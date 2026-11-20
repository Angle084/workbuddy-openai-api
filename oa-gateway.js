#!/usr/bin/env node
'use strict';

// Local Chat Completions <-> Responses adapter. Node 22+, no dependencies.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual, randomUUID, randomBytes } = require('node:crypto');
const { once } = require('node:events');

const VERSION = '2.1.1';
const MiB = 1024 * 1024;
const SUMMARY_LIMIT = 256 * 1024;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.length > 0;
const hash = s => createHash('sha256').update(s).digest();
const unixNow = () => Math.floor(Date.now() / 1000);

class GatewayError extends Error {
  constructor(status, code, message, param = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}
const invalid = (message, param) => new GatewayError(400, 'invalid_request', message, param);
const badUpstream = (code, message) => new GatewayError(502, code, message);
const timeout = stage => new GatewayError(504, `${stage}_timeout`, `Upstream timed out: ${stage}`);
const disconnected = () => new GatewayError(499, 'client_disconnected', 'Client disconnected');

function configFrom(env, flags = {}) {
  function integer(name, def, min, max) {
    const v = env[name] === undefined ? def : Number(env[name]);
    if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`Invalid ${name}`);
    return v;
  }
  const host = env.OA_GW_UPSTREAM || 'api.openai.com';
  const base = env.OA_GW_BASE || '/v1';
  const proxyHost = env.OA_GW_PROXY_HOST || '127.0.0.1';
  const hostPattern = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/;
  if (!hostPattern.test(host) || !hostPattern.test(proxyHost)) throw new Error('Invalid upstream or proxy hostname');
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\/?$/.test(base)) throw new Error('Invalid OA_GW_BASE');
  let key = env.OPENAI_API_KEY;
  // Optional explicit migration: exact model ID + exact local endpoint, never first sk-*.
  if (!key && env.OA_GW_KEY_MODEL) {
    const profile = env.USERPROFILE || env.HOME;
    if (!env.OA_GW_MODELS_FILE && !profile) throw new Error('WorkBuddy profile path is unavailable');
    const file = env.OA_GW_MODELS_FILE || path.join(profile, '.workbuddy', 'models.json');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Cannot read WorkBuddy model configuration'); }
    const rows = Array.isArray(parsed) ? parsed : parsed?.models;
    const compatibleUrl = /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+(?:\/v1)?(?:\/chat\/completions)?\/?$/i;
    const matches = (Array.isArray(rows) ? rows : []).filter(m => m?.id === env.OA_GW_KEY_MODEL && compatibleUrl.test(String(m?.url || '')));
    if (matches.length !== 1 || !/^sk-[A-Za-z0-9_-]+$/.test(matches[0].apiKey || '')) {
      throw new Error('OA_GW_KEY_MODEL must identify exactly one local gateway model with an OpenAI key');
    }
    key = matches[0].apiKey;
  }
  const token = env.OA_GW_LOCAL_TOKEN;
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(key)) throw new Error('Set OPENAI_API_KEY (or explicitly select OA_GW_KEY_MODEL)');
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{24,256}$/.test(token)) throw new Error('Set OA_GW_LOCAL_TOKEN to a separate random token of at least 24 characters');
  if (key === token) throw new Error('The local token and OpenAI API key must be different');
  const summary = env.OA_GW_REASONING_SUMMARY ?? 'off';
  if (!['auto', 'off'].includes(summary)) throw new Error('OA_GW_REASONING_SUMMARY must be auto or off');
  const summaryModels = new Set((env.OA_GW_SUMMARY_MODELS ?? '').split(',').map(m => m.trim().toLowerCase()).filter(Boolean));
  return {
    summary, summaryModels,
    host, base: base.replace(/\/$/, ''), key, token,
    upstreamPort: integer('OA_GW_UPSTREAM_PORT', 443, 1, 65535),
    port: flags.port ?? integer('OA_GW_PORT', 8788, 1, 65535),
    proxyHost, proxyPort: integer('OA_GW_PROXY_PORT', 7897, 1, 65535), useProxy: env.OA_GW_NO_PROXY !== '1',
    connectMs: integer('OA_GW_CONNECT_MS', 15000, 1, 600000),
    tunnelMs: integer('OA_GW_TUNNEL_MS', 20000, 1, 600000),
    tlsMs: integer('OA_GW_TLS_MS', 20000, 1, 600000),
    headersMs: integer('OA_GW_HEADERS_MS', 180000, 1, 3600000),
    idleMs: integer('OA_GW_IDLE_MS', 300000, 1, 3600000),
    totalMs: integer('OA_GW_TIMEOUT', 600000, 1, 7200000),
    bodyMs: integer('OA_GW_BODY_MS', 120000, 1, 600000),
    maxBody: integer('OA_GW_MAX_BODY_BYTES', 64 * MiB, 1024, 512 * MiB),
    maxEvent: integer('OA_GW_MAX_EVENT_BYTES', 32 * MiB, 1024, 256 * MiB),
    maxUpstream: integer('OA_GW_MAX_UPSTREAM_BYTES', 64 * MiB, 1024, 512 * MiB),
    maxConcurrent: integer('OA_GW_MAX_CONCURRENT', 8, 1, 64),
    carryReasoning: env.OA_GW_CARRY_REASONING !== '0',
    noneModels: new Set((env.OA_GW_NONE_MODELS || 'gpt-6-luna,gpt-6.1-terra').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)),
    log: env.OA_GW_LOG !== '0',
  };
}

function makeTransport(cfg) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: cfg.maxConcurrent, maxFreeSockets: Math.min(4, cfg.maxConcurrent), timeout: 30000 });
  const pending = new Set();
  agent.createConnection = (opts, cb) => {
    let stageTimer, connector, socket, secure, ended = false;
    const signal = opts.gatewaySignal;
    const rawError = () => done(badUpstream(cfg.useProxy ? 'proxy_closed' : 'upstream_unreachable', cfg.useProxy ? 'HTTP proxy tunnel closed' : 'Could not connect to upstream'));
    const abort = () => done(signal.reason);
    function done(error, result) {
      if (ended) return;
      ended = true;
      pending.delete(done);
      signal?.removeEventListener('abort', abort);
      clearTimeout(stageTimer);
      if (error) { connector?.destroy(); secure?.destroy(); socket?.destroy(); }
      cb(error, result);
    }
    const stage = (ms, name) => { clearTimeout(stageTimer); stageTimer = setTimeout(() => done(timeout(name)), ms); };
    const startTls = () => {
      stage(cfg.tlsMs, 'upstream_tls');
      secure = tls.connect({ socket, servername: net.isIP(cfg.host) ? undefined : cfg.host, host: cfg.host,
        ca: cfg.ca, rejectUnauthorized: true });
      secure.once('secureConnect', () => done(null, secure));
      secure.on('error', () => done(badUpstream('upstream_tls_failed', 'Upstream TLS handshake or verification failed')));
      secure.once('close', () => done(badUpstream('upstream_tls_closed', 'Connection closed before TLS was ready')));
    };
    pending.add(done);
    if (signal?.aborted) { queueMicrotask(abort); return; }
    signal?.addEventListener('abort', abort, { once: true });
    if (!cfg.useProxy) {
      stage(cfg.connectMs, 'upstream_connect');
      socket = net.connect(cfg.upstreamPort, cfg.host);
      socket.on('error', rawError);
      socket.once('connect', startTls);
      socket.once('close', rawError);
      return;
    }
    const target = `${cfg.host}:${cfg.upstreamPort}`;
    stage(cfg.connectMs, 'proxy_connect');
    connector = http.request({ host: cfg.proxyHost, port: cfg.proxyPort, method: 'CONNECT', path: target,
      headers: { Host: target }, agent: false, maxHeaderSize: 16384 });
    connector.once('socket', s => {
      s.once('connect', () => { if (!ended) stage(cfg.tunnelMs, 'proxy_tunnel'); });
    });
    connector.on('error', () => done(badUpstream('proxy_unreachable', 'Could not connect to the HTTP proxy')));
    connector.once('connect', (res, s, head) => {
      socket = s;
      socket.on('error', rawError);
      socket.once('close', rawError);
      if (ended) return socket.destroy();
      if (res.statusCode !== 200) return done(badUpstream('proxy_rejected', `HTTP proxy rejected CONNECT (${res.statusCode})`));
      if (head.length) socket.unshift(head);
      startTls();
    });
    connector.end();
  };
  function request({ method, endpoint, body, signal }) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = { Authorization: `Bearer ${cfg.key}`, Accept: body?.stream ? 'text/event-stream' : 'application/json' };
      if (payload) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
      const headersDeadline = new AbortController();
      const combined = signal ? AbortSignal.any([signal, headersDeadline.signal]) : headersDeadline.signal;
      const r = https.request({ host: cfg.host, port: cfg.upstreamPort, path: cfg.base + endpoint, method, headers, agent,
        signal: combined, gatewaySignal: combined, rejectUnauthorized: true }, up => {
        clearTimeout(headerTimer);
        // Attach immediately: a failure can arrive before the consumer begins iteration.
        up.on('error', () => {});
        resolve(up);
      });
      const headerTimer = setTimeout(() => headersDeadline.abort(timeout('upstream_headers')), cfg.headersMs);
      r.on('error', err => {
        clearTimeout(headerTimer);
        reject(combined.aborted ? combined.reason : err instanceof GatewayError ? err : badUpstream('upstream_unreachable', 'Could not connect to upstream'));
      });
      r.end(payload || undefined);
    });
  }
  return { request, close() { for (const cancel of pending) cancel(disconnected()); agent.destroy(); } };
}

function textParts(content, field) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalid('Expected text or text parts', field);
  return content.map(p => {
    if (typeof p === 'string') return p;
    if (!isObject(p) || !['text', 'input_text', 'output_text'].includes(p.type) || typeof p.text !== 'string') throw invalid('Unsupported text part', field);
    return p.text;
  }).join('');
}
function inputParts(content, field) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content) || !content.length) throw invalid('Expected a nonempty array of content parts or text', field);
  return content.map(p => {
    if (typeof p === 'string') return { type: 'input_text', text: p };
    if (!isObject(p)) throw invalid('Invalid content part', field);
    if (['text', 'input_text'].includes(p.type) && typeof p.text === 'string') return { type: 'input_text', text: p.text };
    if (p.type === 'image_url' || p.type === 'input_image') {
      const url = isObject(p.image_url) ? p.image_url.url : p.image_url;
      const detail = p.detail ?? p.image_url?.detail ?? 'auto';
      if (!nonempty(url) || !['auto', 'low', 'high', 'original'].includes(detail)) throw invalid('Invalid image URL or detail', field);
      return { type: 'input_image', image_url: url, detail };
    }
    if (p.type === 'file' || p.type === 'input_file') {
      const file = p.type === 'file' ? p.file : p;
      if (!isObject(file)) throw invalid('Invalid file part', field);
      const keys = ['file_id', 'file_url', 'file_data'].filter(k => nonempty(file[k]));
      if (keys.length !== 1) throw invalid('File requires exactly one of file_id, file_url, file_data', field);
      if (keys[0] === 'file_data' && !nonempty(file.filename)) throw invalid('Inline file_data requires a filename', field);
      const out = { type: 'input_file', [keys[0]]: file[keys[0]] };
      if (nonempty(file.filename)) out.filename = file.filename;
      return out;
    }
    throw invalid('Unsupported content part', field);
  });
}
function responseFormat(v) {
  if (!isObject(v)) throw invalid('Invalid response_format', 'response_format');
  if (v.type === 'text' || v.type === 'json_object') return { type: v.type };
  const s = v.json_schema;
  if (v.type !== 'json_schema' || !isObject(s) || !nonempty(s.name) || !isObject(s.schema) || (s.strict != null && typeof s.strict !== 'boolean')) {
    throw invalid('Invalid or unsupported response_format', 'response_format');
  }
  const f = { type: 'json_schema', name: s.name, schema: s.schema, strict: s.strict ?? false };
  if (typeof s.description === 'string') f.description = s.description;
  return f;
}
function convertTools(tools) {
  if (!Array.isArray(tools)) throw invalid('tools must be an array', 'tools');
  return tools.map(t => {
    if (isObject(t) && ['web_search', 'web_search_preview'].includes(t.type)) return { ...t };
    const f = t?.function;
    if (t?.type !== 'function' || !isObject(f) || !nonempty(f.name) || (f.parameters != null && !isObject(f.parameters)) || (f.strict != null && typeof f.strict !== 'boolean')) {
      throw invalid('Invalid or unsupported tool definition', 'tools');
    }
    return { type: 'function', name: f.name, ...(typeof f.description === 'string' ? { description: f.description } : {}),
      parameters: f.parameters ?? { type: 'object', properties: {} }, strict: f.strict ?? false };
  });
}
function toolChoice(v, tools) {
  if (['auto', 'none', 'required'].includes(v)) return v;
  const name = v?.function?.name;
  if (v?.type === 'function' && tools.some(t => t.type === 'function' && t.name === name)) return { type: 'function', name };
  throw invalid('Unsupported tool_choice or unknown function', 'tool_choice');
}
function reasoningEffort(body, cfg) {
  // Optional preview alias lets WorkBuddy add a second entry without changing the live entry or effort.
  const configured = body.model.replace(/@gateway-v2$/i, '');
  if (!configured) throw invalid('Invalid model ID', 'model');
  const suffix = /^(.+?)[@:](none|low|minimal|medium|high|xhigh|max)$/i.exec(configured);
  const model = suffix ? suffix[1] : configured;
  let effort = suffix?.[2] ?? (isObject(body.reasoning_effort) ? body.reasoning_effort.effort : body.reasoning_effort) ?? body.reasoning?.effort;
  if (effort == null) return { model };
  if (typeof effort !== 'string') throw invalid('Invalid reasoning effort', 'reasoning_effort');
  effort = effort.trim().toLowerCase();
  if (['none', 'off', 'disabled'].includes(effort)) effort = cfg.noneModels.has(model.toLowerCase()) ? 'none' : 'low';
  if (effort === 'enabled') effort = 'medium';
  if (effort === 'minimal') effort = 'low';
  if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw invalid('Unsupported reasoning effort', 'reasoning_effort');
  return { model, effort };
}

function convertChat(body, cfg, memory) {
  if (!isObject(body) || !nonempty(body.model) || !Array.isArray(body.messages) || !body.messages.length) throw invalid('model and nonempty messages are required', 'messages');
  if (body.stream != null && typeof body.stream !== 'boolean') throw invalid('stream must be a boolean', 'stream');
  if (body.stream_options != null && (!isObject(body.stream_options) || (body.stream_options.include_usage != null && typeof body.stream_options.include_usage !== 'boolean'))) throw invalid('Invalid stream_options', 'stream_options');
  if (body.n != null && body.n !== 1) throw invalid('This adapter supports n=1 only', 'n');
  for (const k of ['stop', 'logit_bias', 'seed', 'audio', 'functions', 'function_call']) {
    const value = body[k];
    if (value != null && !(Array.isArray(value) && !value.length) && !(k === 'logit_bias' && isObject(value) && !Object.keys(value).length)) throw invalid(`This adapter does not support ${k}`, k);
  }
  for (const k of ['frequency_penalty', 'presence_penalty', 'top_logprobs']) if (body[k] != null && body[k] !== 0) throw invalid(`This adapter does not support ${k}`, k);
  if (body.logprobs === true) throw invalid('This adapter does not support logprobs', 'logprobs');
  if (body.modalities != null && (!Array.isArray(body.modalities) || body.modalities.some(x => x !== 'text'))) throw invalid('This adapter supports text output only', 'modalities');
  const { model, effort } = reasoningEffort(body, cfg);
  const out = { model, input: [], store: false };
  if (body.stream) out.stream = true;
  if (cfg.carryReasoning) out.include = ['reasoning.encrypted_content'];
  if (effort) out.reasoning = { effort };
  if (cfg.summary === 'auto' && effort !== 'none' && (!cfg.summaryModels.size || cfg.summaryModels.has(model.toLowerCase()))) {
    out.reasoning = { ...out.reasoning, summary: 'auto' };
  }
  const calls = new Set(), answered = new Set(), inserted = new Set();
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    const p = `messages.${i}`;
    if (!isObject(m)) throw invalid('Invalid message', p);
    if (m.role === 'system' || m.role === 'developer') {
      out.input.push({ role: m.role, content: [{ type: 'input_text', text: textParts(m.content, p) }] });
    } else if (m.role === 'user') {
      out.input.push({ role: 'user', content: inputParts(m.content, p) });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content != null) {
        const items = Array.isArray(m.content) ? m.content : [m.content];
        for (const item of items) {
          if (item?.type === 'refusal' && typeof item.refusal === 'string') content.push({ type: 'refusal', refusal: item.refusal });
          else {
            const text = textParts([item], p);
            if (text) content.push({ type: 'output_text', text });
          }
        }
      }
      if (nonempty(m.refusal)) content.push({ type: 'refusal', refusal: m.refusal });
      if (content.length) out.input.push({ role: 'assistant', content });
      if (m.tool_calls != null && !Array.isArray(m.tool_calls)) throw invalid('tool_calls must be an array', p);
      for (const call of m.tool_calls ?? []) {
        if (!nonempty(call?.id) || calls.has(call.id) || (call.type != null && call.type !== 'function') || !nonempty(call.function?.name)) throw invalid('Invalid or duplicate tool call', p);
        const a = call.function.arguments;
        if (typeof a !== 'string' && !isObject(a)) throw invalid('Invalid historical tool arguments', p);
        const item = { type: 'function_call', call_id: call.id, name: call.function.name, arguments: typeof a === 'string' ? a : JSON.stringify(a) };
        for (const r of memory?.get(model, item) ?? []) {
          if (!inserted.has(r.id)) { inserted.add(r.id); out.input.push(r); }
        }
        calls.add(call.id);
        out.input.push(item);
      }
    } else if (m.role === 'tool' || m.role === 'function') {
      const id = m.tool_call_id;
      if (!nonempty(id) || !calls.has(id) || answered.has(id)) throw invalid('Tool result must match one preceding tool call', p);
      answered.add(id);
      const output = typeof m.content === 'string' ? m.content : inputParts(m.content, p);
      out.input.push({ type: 'function_call_output', call_id: id, output });
    } else throw invalid('Unsupported message role', p);
  }
  if (!out.input.length) throw invalid('No usable input messages', 'messages');
  if (body.tools != null) {
    const tools = convertTools(body.tools);
    if (tools.length) out.tools = tools;
  }
  if (body.tool_choice != null) {
    const choice = toolChoice(body.tool_choice, out.tools ?? []);
    if (!out.tools && choice === 'required') throw invalid('Required tool choice needs tools', 'tool_choice');
    if (out.tools) out.tool_choice = choice;
  }
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== 'boolean') throw invalid('Invalid parallel_tool_calls', 'parallel_tool_calls');
  if (out.tools && typeof body.parallel_tool_calls === 'boolean') out.parallel_tool_calls = body.parallel_tool_calls;
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max != null) {
    if (!Number.isSafeInteger(max) || max < 1) throw invalid('Invalid maximum output tokens', 'max_completion_tokens');
    out.max_output_tokens = max;
  }
  for (const k of ['temperature', 'top_p']) if (body[k] != null) {
    if (!Number.isFinite(body[k])) throw invalid(`Invalid ${k}`, k);
    out[k] = body[k];
  }
  for (const k of ['service_tier', 'prompt_cache_key', 'safety_identifier']) if (body[k] != null) {
    if (!nonempty(body[k])) throw invalid(`Invalid ${k}`, k);
    out[k] = body[k];
  }
  if (body.response_format != null) out.text = { format: responseFormat(body.response_format) };
  return out;
}

// Short-lived, bounded, in-memory carryover. Match model + exact tool call, never guess by ID alone.
function reasoningMemory({ ttl = 30 * 60 * 1000, maxEntries = 256, maxBytes = 16 * MiB } = {}) {
  const map = new Map();
  let bytes = 0;
  const key = (model, item) => hash(JSON.stringify([model, item.call_id, item.name, item.arguments])).toString('hex');
  const remove = k => { bytes -= map.get(k)?.size ?? 0; map.delete(k); };
  return {
    get(model, item) {
      const k = key(model, item), v = map.get(k);
      if (!v) return [];
      if (v.until <= Date.now()) { remove(k); return []; }
      return v.items;
    },
    remember(model, output) {
      const previous = [];
      for (const item of output) {
        if (item?.type === 'reasoning' && nonempty(item.id) && nonempty(item.encrypted_content)) {
          previous.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: Array.isArray(item.summary) ? item.summary : [] });
        }
        if (!previous.length || item?.type !== 'function_call' || !nonempty(item.call_id)) continue;
        const json = JSON.stringify(previous), size = Buffer.byteLength(json);
        if (size > maxBytes) continue;
        const k = key(model, item);
        remove(k);
        while (map.size >= maxEntries || bytes + size > maxBytes) remove(map.keys().next().value);
        map.set(k, { size, items: JSON.parse(json), until: Date.now() + ttl });
        bytes += size;
      }
    },
  };
}

function mapUsage(u) {
  if (!isObject(u)) return null;
  const p = u.input_tokens ?? 0, c = u.output_tokens ?? 0;
  const usage = { prompt_tokens: p, completion_tokens: c, total_tokens: u.total_tokens ?? p + c };
  if (Number.isFinite(u.input_tokens_details?.cached_tokens)) usage.prompt_tokens_details = { cached_tokens: u.input_tokens_details.cached_tokens };
  if (Number.isFinite(u.output_tokens_details?.reasoning_tokens)) usage.completion_tokens_details = { reasoning_tokens: u.output_tokens_details.reasoning_tokens };
  return usage;
}
function finalReason(resp, count) {
  if (resp?.status === 'completed') return count ? 'tool_calls' : 'stop';
  if (resp?.status === 'incomplete') {
    if (resp.incomplete_details?.reason === 'max_output_tokens') return 'length';
    if (resp.incomplete_details?.reason === 'content_filter') return 'content_filter';
    throw badUpstream('upstream_incomplete', 'Upstream response was incomplete');
  }
  if (resp?.status === 'failed' || resp?.status === 'cancelled') throw badUpstream(`upstream_${resp.status}`, `Upstream response ${resp.status}`);
  throw badUpstream('invalid_upstream_status', 'Upstream response is not in a terminal state');
}
function collectText(output) {
  let content = '', refusal = '';
  for (const item of output ?? []) if (item?.type === 'message') {
    for (const p of item.content ?? []) {
      if (p?.type === 'output_text' && typeof p.text === 'string') content += p.text;
      if (p?.type === 'refusal' && typeof p.refusal === 'string') refusal += p.refusal;
    }
  }
  return { content, refusal };
}
function validCall(item) {
  if (!nonempty(item?.call_id) || !nonempty(item.name) || typeof item.arguments !== 'string') throw badUpstream('invalid_tool_call', 'Upstream tool call is missing its ID, name or final arguments');
  let args;
  try { args = JSON.parse(item.arguments); } catch { /* validation below */ }
  if (!isObject(args)) throw badUpstream('invalid_tool_arguments', 'Upstream tool arguments are not a valid JSON object');
  return { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
}
function outputCalls(out) {
  const seen = new Set();
  return out.filter(x => x?.type === 'function_call').map(x => {
    const call = validCall(x);
    if (seen.has(call.id)) throw badUpstream('duplicate_tool_call', 'Upstream returned duplicate tool call IDs');
    seen.add(call.id);
    return call;
  });
}
function summaryParts(item) {
  // Only forward the provider's public summary, never raw reasoning or encrypted context.
  return item?.type === 'reasoning' && Array.isArray(item.summary) ? item.summary : [];
}
function nonStream(resp, model, memory, actualModel, showSummary) {
  const reason = finalReason(resp, 0);
  if (!Array.isArray(resp.output)) throw badUpstream('invalid_upstream_body', 'Upstream response is missing its outputs');
  const calls = reason === 'stop' ? outputCalls(resp.output) : [];
  const { content, refusal } = collectText(resp.output);
  const message = { role: 'assistant', content: content || (calls.length || refusal ? null : ''), refusal: refusal || null };
  if (showSummary && reason !== 'content_filter') {
    let text = '', bytes = 0;
    for (const item of resp.output) for (const part of summaryParts(item)) {
      if (part?.type !== 'summary_text' || !nonempty(part.text) || !part.text.trim()) continue;
      const next = (text ? '\n\n' : '') + part.text, n = Buffer.byteLength(next);
      if (bytes + n > SUMMARY_LIMIT) continue;
      bytes += n;
      text += next;
    }
    if (text) message.reasoning_content = text;
  }
  if (calls.length) { message.tool_calls = calls; memory?.remember(actualModel, resp.output); }
  return { id: `chatcmpl-${resp.id || randomUUID()}`, object: 'chat.completion', created: resp.created_at ?? unixNow(), model,
    choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : reason, logprobs: null }], usage: mapUsage(resp.usage) };
}

// WHATWG event-stream line endings, multiline data and incremental strict UTF-8.
async function* parseSse(source, maxBytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', skipLF = false, data = [], event = '', bytes = 0;
  function line(s) {
    if (!s.length) {
      const result = data.length ? { type: event, data: data.join('\n') } : null;
      data = []; event = ''; bytes = 0;
      return result;
    }
    bytes += Buffer.byteLength(s) + 1;
    if (bytes > maxBytes) throw badUpstream('sse_event_too_large', 'Upstream SSE event exceeded the configured limit');
    if (s[0] === ':') return null;
    const i = s.indexOf(':');
    const key = i < 0 ? s : s.slice(0, i);
    let value = i < 0 ? '' : s.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (key === 'data') data.push(value);
    else if (key === 'event') event = value;
    return null;
  }
  function* feed(text) {
    if (!text.length) return;
    if (skipLF) { if (text[0] === '\n') text = text.slice(1); skipLF = false; }
    let offset = 0;
    const endings = /\r\n|\r|\n/g;
    let m;
    while ((m = endings.exec(text))) {
      const frame = line(pending + text.slice(offset, m.index));
      pending = '';
      offset = endings.lastIndex;
      skipLF = m[0] === '\r' && offset === text.length;
      if (frame) yield frame;
    }
    pending += text.slice(offset);
    if (bytes + Buffer.byteLength(pending) > maxBytes) throw badUpstream('sse_event_too_large', 'Upstream SSE event exceeded the configured limit');
  }
  function decode(chunk, stream) {
    try { return decoder.decode(chunk, { stream }); }
    catch { throw badUpstream('invalid_upstream_utf8', 'Upstream stream is not valid UTF-8'); }
  }
  for await (const chunk of source) yield* feed(decode(chunk, true));
  yield* feed(decode(undefined, false));
  // SSE only dispatches upon a blank line. A partial event at EOF is not a terminal event.
}

function streamWriter(res, model, includeUsage, signal) {
  const id = 'chatcmpl-' + randomUUID(), created = unixNow();
  let started = false;
  async function send(obj) {
    signal.throwIfAborted();
    if (res.destroyed || res.writableEnded) throw disconnected();
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    if (!res.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`)) await once(res, 'drain', { signal });
  }
  const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason, logprobs: null }], ...(includeUsage ? { usage: null } : {}) });
  async function start() { if (!started) { started = true; await send(chunk({ role: 'assistant', content: '' })); } }
  return {
    async delta(d) { await start(); await send(chunk(d)); },
    async finish(reason, usage) {
      await start();
      await send(chunk({}, reason));
      if (includeUsage && usage) await send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
      await send('[DONE]');
      res.end();
    },
  };
}

function summaryStream(writer) {
  const byId = new Map(), byIndex = new Map();
  let bytes = 0, items = 0, parts = 0, visibleParts = 0;
  function group(id, index) {
    const i = Number.isSafeInteger(index) && index >= 0 ? index : null;
    const key = nonempty(id) ? id : null;
    if (key === null && i === null) return null;
    const a = byId.get(key), b = byIndex.get(i);
    if (a && b && a !== b) return null;
    if (!a && !b && ++items > 256) return null;
    const g = a ?? b ?? new Map();
    if (key !== null && (byId.has(key) || byId.size < 256)) byId.set(key, g);
    if (i !== null && (byIndex.has(i) || byIndex.size < 256)) byIndex.set(i, g);
    return g;
  }
  async function text(g, index, value, final) {
    if (!g || !Number.isSafeInteger(index) || index < 0 || !nonempty(value)) return;
    let entry = g.get(index);
    if (!entry) {
      if (++parts > 512) return;
      g.set(index, entry = { seen: '', shown: 0 });
    }
    // If a final snapshot arrives twice, or was already fully streamed, emit no duplicate.
    if (final && !value.startsWith(entry.seen)) return;
    const tail = final ? value.slice(entry.seen.length) : value;
    const n = Buffer.byteLength(tail);
    if (bytes + n > SUMMARY_LIMIT) return;
    bytes += n;
    entry.seen += tail;
    const pending = entry.seen.slice(entry.shown);
    // WorkBuddy's thought-chunk parser ignores whitespace-only deltas. Carry them to the next text.
    if (!pending.trim()) return;
    const separator = !entry.shown && visibleParts++ > 0 ? '\n\n' : '';
    await writer.delta({ reasoning_content: separator + pending });
    entry.shown = entry.seen.length;
  }
  async function snapshot(item, index) {
    const parts = summaryParts(item);
    if (!parts.length) return;
    const g = group(item.id, index);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]?.type === 'summary_text') await text(g, i, parts[i].text, true);
    }
  }
  return {
    async event(t, evt) {
      if (t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_summary_text.done') {
        const final = t.endsWith('.done');
        await text(group(evt.item_id, evt.output_index), evt.summary_index, final ? evt.text : evt.delta, final);
      } else if (t === 'response.reasoning_summary_part.done' && evt.part?.type === 'summary_text') {
        await text(group(evt.item_id, evt.output_index), evt.summary_index, evt.part.text, true);
      } else if (t === 'response.output_item.done' && evt.item?.type === 'reasoning') {
        await snapshot(evt.item, evt.output_index);
      }
    },
    async finish(output) {
      for (let i = 0; i < output.length; i++) await snapshot(output[i], i);
    },
  };
}

async function streamChat(up, writer, cfg, memory, model, showSummary) {
  const summary = showSummary ? summaryStream(writer) : null;
  // Text is incremental; tool calls are released only after validated terminal output.
  let sentText = '', sentRefusal = '', toolBytes = 0, textBytes = 0, refusalBytes = 0;
  const byIndex = new Map(), byItem = new Map();
  function tool(evt, item) {
    const ix = Number.isInteger(evt.output_index) ? evt.output_index : -1;
    const id = item?.id ?? evt.item_id;
    const a = ix >= 0 ? byIndex.get(ix) : undefined, b = id ? byItem.get(id) : undefined;
    if (a && b && a !== b) throw badUpstream('tool_identity_conflict', 'Upstream tool events could not be correlated');
    const row = a || b || { args: '', done: undefined };
    if (!a && !b && new Set([...byIndex.values(), ...byItem.values()]).size >= 512) throw badUpstream('too_many_tool_calls', 'Upstream returned too many tool calls');
    if (ix >= 0) byIndex.set(ix, row);
    if (id) byItem.set(id, row);
    if (ix < 0 && !id) throw badUpstream('invalid_tool_event', 'Upstream tool event lacked an item index or ID');
    if (item) for (const k of ['id', 'call_id', 'name']) if (nonempty(item[k])) {
      if (row[k] != null && row[k] !== item[k]) throw badUpstream('tool_identity_conflict', 'Upstream tool identity changed mid-stream');
      row[k] = item[k];
    }
    return row;
  }
  function argsInto(row, args, kind) {
    if (typeof args !== 'string' || !args.length) return;
    toolBytes += Buffer.byteLength(args);
    if (toolBytes > cfg.maxUpstream) throw badUpstream('tool_buffer_too_large', 'Upstream tool data exceeded the configured limit');
    if (kind === 'done') {
      if (row.done != null && row.done !== args) throw badUpstream('tool_arguments_conflict', 'Upstream tool final arguments did not agree');
      row.done = args;
    } else row.args += args;
  }
  for await (const frame of parseSse(up, cfg.maxEvent)) {
    if (frame.data === '[DONE]') break;
    let evt;
    try { evt = JSON.parse(frame.data); } catch { throw badUpstream('invalid_sse_event', 'Upstream SSE event was not valid JSON'); }
    if (!isObject(evt) || !nonempty(evt.type || frame.type)) throw badUpstream('invalid_sse_event', 'Upstream SSE event lacked a type');
    if (frame.type && frame.type !== 'message' && evt.type && frame.type !== evt.type) throw badUpstream('invalid_sse_event', 'Upstream SSE event type did not match its data');
    const t = evt.type || frame.type;
    if (t === 'error' || t === 'response.failed' || t === 'response.cancelled') throw badUpstream('upstream_stream_failed', 'Upstream reported a stream failure');
    if (summary && (t.startsWith('response.reasoning_summary_') || (t === 'response.output_item.done' && evt.item?.type === 'reasoning'))) {
      await summary.event(t, evt);
    }
    if (t === 'response.output_text.delta' && nonempty(evt.delta)) {
      sentText += evt.delta;
      textBytes += Buffer.byteLength(evt.delta);
      if (textBytes > cfg.maxUpstream) throw badUpstream('output_too_large', 'Upstream output exceeded the configured limit');
      await writer.delta({ content: evt.delta });
    } else if (t === 'response.refusal.delta' && nonempty(evt.delta)) {
      sentRefusal += evt.delta;
      refusalBytes += Buffer.byteLength(evt.delta);
      if (refusalBytes > cfg.maxUpstream) throw badUpstream('output_too_large', 'Upstream refusal exceeded the configured limit');
      await writer.delta({ refusal: evt.delta });
    } else if (['response.output_item.added', 'response.output_item.done'].includes(t) && evt.item?.type === 'function_call') {
      argsInto(tool(evt, evt.item), evt.item.arguments, t.endsWith('.done') ? 'done' : 'delta');
    } else if (t === 'response.function_call_arguments.delta' || t === 'response.function_call_arguments.done') {
      const row = tool(evt);
      argsInto(row, t.endsWith('.done') ? evt.arguments : evt.delta, t.endsWith('.done') ? 'done' : 'delta');
    } else if (t === 'response.completed' || t === 'response.incomplete') {
      const resp = evt.response;
      const status = t === 'response.completed' ? 'completed' : 'incomplete';
      if (!isObject(resp) || !Array.isArray(resp.output) || (resp.status != null && resp.status !== status)) throw badUpstream('invalid_terminal_event', 'Upstream terminal event had inconsistent response data');
      let reason = finalReason({ ...resp, status }, 0);
      if (reason !== 'content_filter') await summary?.finish(resp.output);
      let count = 0;
      if (reason === 'stop') {
        const confirmed = new Set();
        const output = resp.output.map((item, i) => {
          if (item?.type !== 'function_call') return item;
          const row = tool({ output_index: i }, item);
          const final = nonempty(item.arguments) ? item.arguments : row.done ?? row.args;
          if ((row.done != null && final !== row.done) || (row.args && typeof final === 'string' && !final.startsWith(row.args))) {
            throw badUpstream('tool_arguments_conflict', 'Upstream tool arguments did not agree with terminal output');
          }
          confirmed.add(row);
          return { type: 'function_call', id: row.id, call_id: row.call_id, name: row.name, arguments: final };
        });
        if ([...byIndex.values(), ...byItem.values()].some(row => !confirmed.has(row))) throw badUpstream('unconfirmed_tool_call', 'A streamed tool call was absent from terminal output');
        const calls = outputCalls(output);
        const final = collectText(output);
        await reconcile(final.content, sentText, 'content');
        await reconcile(final.refusal, sentRefusal, 'refusal');
        for (const [index, call] of calls.entries()) await writer.delta({ tool_calls: [{ index, ...call }] });
        count = calls.length;
        if (count) memory?.remember(model, output);
      } else {
        const partial = collectText(resp.output);
        await reconcile(partial.content, sentText, 'content');
        await reconcile(partial.refusal, sentRefusal, 'refusal');
      }
      if (count) reason = 'tool_calls';
      await writer.finish(reason, mapUsage(resp.usage));
      return reason;
    }
  }
  throw badUpstream('stream_missing_terminal', 'Upstream stream ended without a terminal event');
  async function reconcile(full, sent, key) {
    if (!full) return;
    if (!full.startsWith(sent)) throw badUpstream('stream_content_conflict', 'Upstream terminal text disagreed with streamed output');
    if (full.length > sent.length) await writer.delta({ [key]: full.slice(sent.length) });
  }
}

async function readJson(stream, limit, direction, onChunk) {
  let size = 0;
  const chunks = [];
  const downstream = direction === 'client';
  const fail = code => downstream
    ? new GatewayError(code === 'large' ? 413 : 400, code === 'large' ? 'request_too_large' : 'invalid_json', code === 'large' ? 'Request body exceeded the configured limit' : 'Invalid JSON or UTF-8 request body')
    : badUpstream(code === 'large' ? 'upstream_body_too_large' : 'invalid_upstream_json', code === 'large' ? 'Upstream body exceeded the configured limit' : 'Upstream returned invalid JSON or UTF-8');
  const declared = Number(stream.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw fail('large');
  for await (const chunk of stream.iterator({ destroyOnReturn: !downstream })) {
    onChunk?.();
    size += chunk.length;
    if (size > limit) throw fail('large');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw fail('invalid'); }
}
function errorObject(error) {
  return { error: { message: error.message, type: error.status === 401 ? 'authentication_error' : error.status < 500 ? 'invalid_request_error' : 'gateway_error', code: error.code, param: error.param ?? null } };
}
function sendJson(res, code, obj, more = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...more });
  res.end(body);
}
const SAFE_ERROR_HEADERS = ['retry-after', 'x-request-id', 'x-ratelimit-limit-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-requests', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'];
function reportUpstream(res, up, payload, key) {
  const headers = Object.fromEntries(SAFE_ERROR_HEADERS.flatMap(k => typeof up.headers[k] === 'string' ? [[k, up.headers[k]]] : []));
  const source = isObject(payload?.error) ? payload.error : {};
  const safe = s => typeof s === 'string' ? s.slice(0, 2048) : null;
  const scrub = s => typeof s === 'string' ? safe(s.split(key).join('[redacted]')) : null;
  sendJson(res, up.statusCode, { error: { message: scrub(source.message) || `Upstream HTTP ${up.statusCode}`, type: scrub(source.type) || 'upstream_error', code: scrub(source.code), param: scrub(source.param) } }, headers);
}
function createGateway(cfg, options = {}) {
  const transport = options.transport ?? makeTransport(cfg);
  const memory = cfg.carryReasoning ? reasoningMemory() : null;
  const localHash = hash(cfg.token);
  let active = 0;
  const trustedHost = h => {
    const expected = server.address()?.port;
    return h === `127.0.0.1:${expected}` || /^localhost$/i.test(h?.split(':')[0] || '') && h?.split(':').length === 2 && h.split(':')[1] === String(expected);
  };
  const log = fields => { if (cfg.log) console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields })); };
  const server = http.createServer({ requestTimeout: cfg.bodyMs, headersTimeout: Math.min(cfg.bodyMs, 30000), maxHeaderSize: 32768 }, (req, res) => {
    void handle(req, res).catch(() => { if (!res.destroyed) res.destroy(); });
  });
  async function handle(req, res) {
    const url = req.url.split('?', 1)[0];
    const localError = (err, more = {}) => sendJson(res, err.status, errorObject(err), { Connection: 'close', ...more });
    if (!trustedHost(req.headers.host)) return localError(new GatewayError(403, 'invalid_local_host', 'Use the loopback gateway address'));
    if (req.method === 'GET' && url === '/health') return sendJson(res, 200, { ok: true, version: VERSION, mode: options.probe ? 'probe' : 'gateway' });
    const chat = url === '/chat/completions' || url === '/v1/chat/completions';
    const models = url === '/models' || url === '/v1/models';
    if (!chat && !models) return localError(new GatewayError(404, 'not_found', 'Unknown gateway route'));
    const method = chat ? 'POST' : 'GET';
    if (req.method !== method) return localError(new GatewayError(405, 'method_not_allowed', 'Method not allowed'), { Allow: method });
    const bearer = /^Bearer ([^\s,]+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!bearer || !timingSafeEqual(hash(bearer), localHash)) {
      return localError(new GatewayError(401, 'invalid_local_token', 'A valid local gateway token is required'), { 'WWW-Authenticate': 'Bearer' });
    }
    if (active >= cfg.maxConcurrent) return localError(new GatewayError(429, 'gateway_busy', 'Too many active gateway requests'), { 'Retry-After': '1' });
    active++;
    const start = Date.now(), controller = new AbortController();
    const { signal } = controller;
    const cancel = () => { if (!res.writableFinished) controller.abort(disconnected()); };
    req.once('aborted', cancel);
    res.once('close', cancel);
    let timer, idle, bodyTimer, up, outcome = 'failure', requestId;
    const clearIdle = () => clearTimeout(idle);
    const resetIdle = () => {
      clearIdle();
      idle = setTimeout(() => controller.abort(timeout('upstream_idle')), cfg.idleMs);
    };
    try {
      timer = setTimeout(() => controller.abort(timeout('upstream_total')), cfg.totalMs);
      let body, out;
      if (chat) {
        bodyTimer = setTimeout(() => {
          const err = new GatewayError(408, 'request_body_timeout', 'Timed out reading request body');
          if (!signal.aborted) controller.abort(err);
          if (!res.headersSent) localError(err);
          req.resume();
        }, cfg.bodyMs);
        body = await readJson(req, cfg.maxBody, 'client');
        clearTimeout(bodyTimer);
        out = convertChat(body, cfg, memory);
      }
      signal.throwIfAborted();
      up = await transport.request({ method, endpoint: chat ? '/responses' : '/models', body: out, signal });
      signal.throwIfAborted();
      const abortUp = () => up.destroy();
      // Reset idle deadline only on bytes; do not attach a data listener that would force flowing mode.
      async function* tracked() {
        resetIdle();
        try {
          for await (const part of up.iterator({ destroyOnReturn: false })) { resetIdle(); yield part; }
        } finally { clearIdle(); }
      }
      async function drainTail() {
        if (up.readableEnded || up.destroyed) return;
        // Downstream is already done. A short bounded drain returns normal upstream sockets to the pool.
        const tail = setTimeout(() => up.destroy(), 500);
        try { for await (const _ of up) { /* discard bytes after the terminal event */ } }
        catch { /* terminal event already delivered */ }
        finally { clearTimeout(tail); }
      }
      signal.addEventListener('abort', abortUp, { once: true });
      resetIdle();
      requestId = /^[A-Za-z0-9_.-]{1,128}$/.test(up.headers['x-request-id'] || '') ? up.headers['x-request-id'] : undefined;
      if (up.statusCode < 200 || up.statusCode >= 300) {
        let j;
        try { j = await readJson(up, Math.min(cfg.maxUpstream, 256 * 1024), 'upstream', resetIdle); }
        catch { signal.throwIfAborted(); }
        reportUpstream(res, up, j, cfg.key);
        outcome = `http_${up.statusCode}`;
      } else if (!chat) {
        const j = await readJson(up, cfg.maxUpstream, 'upstream', resetIdle);
        if (!Array.isArray(j?.data)) throw badUpstream('invalid_models_response', 'Upstream model list is invalid');
        sendJson(res, 200, { object: 'list', data: j.data });
        outcome = 'models';
      } else if (!out.stream) {
        const j = await readJson(up, cfg.maxUpstream, 'upstream', resetIdle);
        const result = nonStream(j, body.model, memory, out.model, out.reasoning?.summary === 'auto');
        sendJson(res, 200, result);
        outcome = result.choices[0].finish_reason;
      } else {
        if (!/^text\/event-stream(?:\s*;|$)/i.test(up.headers['content-type'] || '')) throw badUpstream('unexpected_content_type', 'Upstream did not return an event stream');
        outcome = await streamChat(tracked(), streamWriter(res, body.model, Boolean(body.stream_options?.include_usage), signal), cfg, memory, out.model, out.reasoning?.summary === 'auto');
        await drainTail();
      }
    } catch (err) {
      const e = signal.aborted ? signal.reason : err instanceof GatewayError ? err : badUpstream('upstream_io_failed', 'Gateway could not complete the upstream request');
      outcome = e.code;
      if (e.status !== 499 && !res.destroyed && !res.writableEnded) {
        if (!res.headersSent) localError(e);
        else res.end(`data: ${JSON.stringify(errorObject(e))}\n\n`); // Never emit success terminator on errors.
      }
    } finally {
      clearIdle(); clearTimeout(timer); clearTimeout(bodyTimer);
      if (up && !up.readableEnded && !up.destroyed) up.destroy();
      req.removeListener('aborted', cancel);
      res.removeListener('close', cancel);
      active--;
      log({ route: chat ? 'chat' : 'models', outcome, duration_ms: Date.now() - start, upstream_request_id: requestId });
    }
  }
  server.on('close', () => transport.close?.());
  return server;
}

function startSummaryProbe() {
  const { Readable } = require('node:stream');
  const { setTimeout: wait } = require('node:timers/promises');
  const localToken = 'local-summary-probe-only';
  const model = 'gateway-thinking-probe';
  const cfg = configFrom({ OPENAI_API_KEY: 'mock-upstream-not-used', OA_GW_LOCAL_TOKEN: localToken, OA_GW_REASONING_SUMMARY: 'auto', OA_GW_CARRY_REASONING: '0', OA_GW_LOG: '0' }, { port: 8789 });
  const summaryText = '这是本地合成的推理摘要探针，不来自真实模型。';
  const content = '这是独立的正文。思考区里应显示另一段文本。';
  const frame = event => Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  const transport = { async request({ endpoint, body, signal }) {
    const type = body?.stream ? 'text/event-stream' : 'application/json';
    const item = { id: 'rs_probe', type: 'reasoning', summary: [{ type: 'summary_text', text: summaryText }] };
    const response = { status: 'completed', output: [item, { type: 'message', content: [{ type: 'output_text', text: content }] }] };
    if (endpoint !== '/models' && body?.model !== model) {
      const up = Readable.from([Buffer.from(JSON.stringify({ error: { message: 'Use the dedicated local probe model' } }))]);
      return Object.assign(up, { statusCode: 400, headers: { 'content-type': 'application/json' } });
    }
    async function* events() {
      yield frame({ type: 'response.reasoning_summary_text.delta', item_id: item.id, output_index: 0, summary_index: 0, delta: summaryText });
      await wait(750, null, { signal });
      yield frame({ type: 'response.output_text.delta', delta: content });
      yield frame({ type: 'response.completed', response });
    }
    const stream = endpoint === '/models'
      ? Readable.from([Buffer.from(JSON.stringify({ data: [{ id: model, object: 'model', owned_by: 'local-probe' }] }))])
      : body?.stream ? Readable.from(events()) : Readable.from([Buffer.from(JSON.stringify(response))]);
    return Object.assign(stream, { statusCode: 200, headers: { 'content-type': type } });
  } };
  listenCli(createGateway(cfg, { transport, probe: true }), cfg.port, `Local fake-token only: ${localToken}; model: ${model}; no upstream network.`);
}

function listenCli(server, port, details = '') {
  server.on('error', e => {
    console.error(`[gateway] ${e.code === 'EADDRINUSE' ? 'Port already in use' : 'Unable to start listener'} (${e.code || 'listen_failed'}).`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[gateway ${VERSION}] listening on http://127.0.0.1:${port}/v1`);
    if (details) console.log(details);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => {
    const t = setTimeout(() => server.closeAllConnections(), 3000);
    t.unref();
    server.close(() => clearTimeout(t));
  });
}

async function verifyGateway(cfg, live) {
  let requests = 0;
  let stage = 'health';
  const diagnostics = { port: cfg.port, version: VERSION, mode: live?.mode || 'local' };
  const fail = code => ({ ...diagnostics, ok: false, code, upstreamAttempts: requests });
  const request = (route, body, auth) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: cfg.port, path: route, agent: false,
      signal: AbortSignal.timeout(90000), method: payload ? 'POST' : 'GET',
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(auth ? { Authorization: 'Bearer ' + cfg.token } : {}) } }, up => {
      up.on('error', () => {});
      resolve(up);
    });
    r.on('error', reject);
    r.end(payload || undefined);
  });
  const post = (body, auth) => request('/v1/chat/completions', body, auth);
  const read = r => readJson(r, 1024 * 1024, 'upstream');
  try {
    const h = await request('/health');
    const health = await read(h);
    if (h.statusCode !== 200 || health?.ok !== true || health.version !== VERSION || health.mode !== 'gateway') return fail('wrong_gateway_version');
    stage = 'auth';
    const unauth = await post({}, false);
    if (unauth.statusCode !== 401) { unauth.destroy(); return fail('local_auth_not_verified'); }
    if ((await read(unauth)).error?.code !== 'invalid_local_token') return fail('local_auth_not_verified');
    if (!live) return { ...diagnostics, ok: true, authStatus: 401, upstreamAttempts: 0 };
    diagnostics.model = live.model;
    stage = 'live_request';
    const body = { model: live.model, reasoning_effort: 'low', max_completion_tokens: 768,
      messages: [{ role: 'user', content: live.mode === 'tool' ? 'Call gateway_test now.' : 'Reply with the single word pong.' }] };
    if (live.mode === 'tool') {
      body.tools = [{ type: 'function', function: { name: 'gateway_test', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true } }];
      body.tool_choice = { type: 'function', function: { name: 'gateway_test' } };
    }
    if (live.mode === 'stream') body.stream = true;
    requests++;
    const res = await post(body, true);
    diagnostics.httpStatus = res.statusCode;
    if (res.statusCode !== 200) { res.destroy(); return fail('live_http_error'); }
    stage = 'live_response';
    if (live.mode === 'stream') {
      if (!/^text\/event-stream(?:\s*;|$)/i.test(res.headers['content-type'] || '')) { res.destroy(); return fail('expected_event_stream'); }
      let done = false, finished = false, visible = false, summary = false;
      for await (const frame of parseSse(res, 1024 * 1024)) {
        if (done) return fail('trailing_sse_data');
        if (frame.data === '[DONE]') { done = true; continue; }
        const e = JSON.parse(frame.data);
        if (e.error) return fail('live_stream_error');
        const c = e.choices?.[0];
        if (typeof c?.delta?.content === 'string' && c.delta.content.trim()) visible = true;
        if (typeof c?.delta?.reasoning_content === 'string' && c.delta.reasoning_content.trim()) summary = true;
        if (c?.finish_reason === 'stop') finished = true;
      }
      diagnostics.summaryReceived = summary;
      if (!done || !finished || !visible) return fail('incomplete_stream');
    } else {
      const c = (await read(res)).choices?.[0];
      if (live.mode === 'text' && (c?.finish_reason !== 'stop' || typeof c.message?.content !== 'string' || !c.message.content.trim())) return fail('missing_complete_text');
      if (live.mode === 'tool') {
        const call = c?.message?.tool_calls?.[0];
        let params;
        try { params = JSON.parse(call?.function?.arguments); } catch { /* validated below */ }
        if (c?.finish_reason !== 'tool_calls' || !nonempty(call?.id) || call.function?.name !== 'gateway_test' || !isObject(params) || Object.keys(params).length) return fail('missing_expected_tool_call');
      }
    }
    return { ...diagnostics, ok: true, authStatus: 401, upstreamAttempts: requests };
  } catch { return fail(`${stage}_failed`); }
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--probe-summary') return startSummaryProbe();
  let check = false, explicitFile, initModel, verify = false, live, port;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--check-config' && !check) check = true;
    else if (arg === '--config-file' && !explicitFile && args[0] && !args[0].startsWith('--')) explicitFile = args.shift();
    else if (arg === '--init-config' && !initModel && args[0] && !args[0].startsWith('--')) initModel = args.shift();
    else if (arg === '--port' && port === undefined && /^\d{1,5}$/.test(args[0] ?? '') && Number(args[0]) >= 1 && Number(args[0]) <= 65535) port = args.shift();
    else if (arg === '--verify-local' && !verify) verify = true;
    else if (arg === '--verify-live' && !live && /^(?:text|tool|stream)$/.test(args[0] ?? '') && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(args[1] ?? '')) {
      live = { mode: args.shift(), model: args.shift() };
    } else throw new Error('Usage: node oa-gateway.js [--config-file PATH] [--port PORT] [--check-config | --init-config MODEL_ID | --verify-local | --verify-live text|tool|stream MODEL_ID]');
  }
  if ([check, initModel, verify, live].filter(Boolean).length > 1) throw new Error('Select only one CLI operation');
  const profile = process.env.USERPROFILE || process.env.HOME;
  const configFile = explicitFile ?? (profile ? path.join(profile, '.workbuddy', 'oa-gateway-v2.env') : null);
  if (initModel) {
    if (check || !configFile) throw new Error('--init-config requires a destination and cannot be combined with --check-config');
    const token = randomBytes(32).toString('base64url');
    const cfg = configFrom({ ...process.env, OPENAI_API_KEY: undefined, OA_GW_KEY_MODEL: initModel, OA_GW_LOCAL_TOKEN: token });
    try {
      fs.writeFileSync(configFile, `# Local secrets: do not share or commit. WorkBuddy must only receive OA_GW_LOCAL_TOKEN.\nOPENAI_API_KEY=${cfg.key}\nOA_GW_LOCAL_TOKEN=${token}\n`, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code === 'EEXIST') throw new Error('Gateway config already exists; nothing was overwritten');
      throw new Error('Cannot create gateway config in the selected directory');
    }
    console.log(JSON.stringify({ config: 'created', file: configFile, requestsSent: 0 }));
    return;
  }
  if (explicitFile || (configFile && fs.existsSync(configFile))) process.loadEnvFile(configFile);
  const cfg = configFrom(port === undefined ? process.env : { ...process.env, OA_GW_PORT: port });
  if (verify || live) {
    const result = await verifyGateway(cfg, live);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (check) {
    console.log(JSON.stringify({ config: 'ok', version: VERSION, listen: `127.0.0.1:${cfg.port}`, upstream: cfg.host, proxy: cfg.useProxy ? `${cfg.proxyHost}:${cfg.proxyPort}` : 'off', localAuth: 'required', reasoningSummary: cfg.summary, requestsSent: 0 }));
    return;
  }
  listenCli(createGateway(cfg), cfg.port);
}
if (require.main === module) {
  cli().catch(e => {
    console.error(`[gateway] ${e.code ? 'Cannot load environment configuration' : e.message}`);
    process.exitCode = 1;
  });
}
module.exports = { configFrom, createGateway, makeTransport, parseSse, convertChat, reasoningMemory, verifyGateway, VERSION };
