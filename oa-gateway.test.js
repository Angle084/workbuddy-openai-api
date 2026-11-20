'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomInt } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { configFrom, createGateway, makeTransport, parseSse, convertChat, reasoningMemory, verifyGateway, VERSION } = require('./oa-gateway');

const token = 'local-test-token-not-for-production';
const key = 'sk-test-transport-fixture';
const cfg = patch => ({ ...configFrom({ OPENAI_API_KEY: key, OA_GW_LOCAL_TOKEN: token, OA_GW_LOG: '0' }, { port: 0 }), ...patch });
const body = (extra = {}) => ({ model: 'mock-model', messages: [{ role: 'user', content: 'hello' }], ...extra });
const msg = text => ({ type: 'message', content: [{ type: 'output_text', text }] });
const reply = (output = [], patch = {}) => ({ id: 'resp_1', status: 'completed', output, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }, ...patch });
const created = { type: 'response.created' };
const delta = delta => ({ type: 'response.output_text.delta', delta });
const completed = output => ({ type: 'response.completed', response: reply(output) });
const incomplete = (reason, output) => ({ type: 'response.incomplete', response: reply(output, { status: 'incomplete', incomplete_details: { reason } }) });
const frame = (e, nl = '\n') => Buffer.from(`${e.type ? 'event: ' + e.type + nl : ''}data: ${JSON.stringify(e)}${nl}${nl}`);
const call = (name, n, args) => ({ type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n, name, arguments: args });
const add = (i, item) => ({ type: 'response.output_item.added', output_index: i, item });
const pieces = (out, item, d) => ({ type: 'response.function_call_arguments.delta', output_index: out, item_id: item.id, delta: d });
const done = (out, item, a) => ({ type: 'response.function_call_arguments.done', output_index: out, item_id: item.id, arguments: a });
const wait = (promise, label) => Promise.race([promise, delay(1400, null, { ref: false }).then(() => { throw new Error('Timeout waiting for ' + label); })]);
function upstream(chunks, status = 200, headers = {}) {
  const r = Readable.from(chunks.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x)));
  r.statusCode = status;
  r.headers = headers;
  return r;
}
const sse = chunks => upstream(chunks, 200, { 'content-type': 'text/event-stream; charset=utf-8' });
const json = (object, status = 200, headers) => upstream([JSON.stringify(object)], status, headers ?? { 'content-type': 'application/json' });
async function listen(server) {
  // Avoid WHATWG Fetch-blocked ports in the machine's ephemeral range.
  for (let tries = 0; tries < 10; tries++) {
    const port = randomInt(41000, 49000);
    try {
      server.listen(port, '127.0.0.1'); await once(server, 'listening');
      return port;
    } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('No regular isolated test port available');
}
function track(server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return () => new Promise(resolve => { server.close(resolve); for (const s of sockets) s.destroy(); });
}
async function fixture(t, response, options = {}) {
  const history = [];
  const server = createGateway(cfg(options), { transport: { async request(req) { history.push(req); return response(req, history.length); } } });
  const dispose = track(server);
  t.after(dispose);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const request = (b, { authorization = `Bearer ${token}`, route = '/v1/chat/completions', method = b === undefined ? 'GET' : 'POST', signal } = {}) => fetch(base + route, {
    method, signal, headers: { ...(authorization ? { Authorization: authorization } : {}), ...(b !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(b !== undefined ? { body: typeof b === 'string' ? b : JSON.stringify(b) } : {}),
  });
  return { port, request, history };
}
async function decode(r) {
  const raw = await r.text();
  const lines = raw.split('\n').filter(x => x.startsWith('data: ')).map(x => x.slice(6));
  const events = lines.filter(x => x !== '[DONE]').map(x => JSON.parse(x));
  const deltas = events.map(e => e.choices?.[0]?.delta).filter(Boolean);
  return { events, end: lines.at(-1) === '[DONE]', text: deltas.map(x => x.content || '').join(''),
    thinking: deltas.map(x => x.reasoning_content || '').join(''), refusal: deltas.map(x => x.refusal || '').join(''),
    calls: deltas.flatMap(x => x.tool_calls || []), reason: events.map(e => e.choices?.[0]?.finish_reason).filter(Boolean).at(-1), error: events.find(x => x.error)?.error };
}

test('configuration requires separate token and explicit upstream key', () => {
  assert.throws(() => configFrom({ OA_GW_LOCAL_TOKEN: token }), /OPENAI_API_KEY/);
  assert.throws(() => configFrom({ OPENAI_API_KEY: key }), /OA_GW_LOCAL_TOKEN/);
  assert.throws(() => configFrom({ OPENAI_API_KEY: token, OA_GW_LOCAL_TOKEN: token }), /must be different/);
  assert.throws(() => configFrom({ OPENAI_API_KEY: key, OA_GW_LOCAL_TOKEN: token, OA_GW_PORT: 'abc' }), /OA_GW_PORT/);
});

test('CLI migration copies only the explicitly selected key, creates a separate token and does not overwrite', t => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.gateway-cli-test-'));
  const settings = path.join(dir, 'models.json'), envFile = path.join(dir, 'candidate.env');
  t.after(() => { for (const f of [settings, envFile]) if (fs.existsSync(f)) fs.unlinkSync(f); fs.rmdirSync(dir); });
  fs.writeFileSync(settings, JSON.stringify({ models: [
    { id: 'unrelated', url: 'http://127.0.0.1:8788/v1', apiKey: 'sk-other-fixture' },
    { id: 'selected', url: 'http://127.0.0.1:8788/v1', apiKey: key },
  ] }));
  const env = { ...process.env, OA_GW_MODELS_FILE: settings }; delete env.OPENAI_API_KEY; delete env.OA_GW_LOCAL_TOKEN;
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'oa-gateway.js'), '--config-file', envFile, ...args], { env, encoding: 'utf8' });
  let r = run('--init-config', 'selected');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /"requestsSent":0/); assert.doesNotMatch(r.stdout, /sk-test/);
  const saved = fs.readFileSync(envFile, 'utf8');
  assert.match(saved, /OPENAI_API_KEY=sk-test-transport-fixture/); assert.doesNotMatch(saved, /sk-other/);
  const localToken = /^OA_GW_LOCAL_TOKEN=(.+)$/m.exec(saved)[1];
  assert.equal(localToken.length, 43); assert.notEqual(localToken, key);
  r = run('--check-config'); assert.equal(r.status, 0, r.stderr); assert.ok(!r.stdout.includes(localToken));
  r = run('--init-config', 'selected'); assert.equal(r.status, 1); assert.match(r.stderr, /nothing was overwritten/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), saved);
});

test('request mapping preserves role order, images, files, format, tools and settings', () => {
  const b = body({ model: 'gpt-6.1-terra@none', max_completion_tokens: 12000, temperature: 1, top_p: 0.7,
    messages: [{ role: 'developer', content: 'policy' }, { role: 'user', content: [{ type: 'text', text: 'text' }, { type: 'image_url', image_url: { url: 'https://example.invalid/a.png', detail: 'high' } }, { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,WA==' } }] }, { role: 'system', content: 'later' }],
    tools: [{ type: 'function', function: { name: 'weather' } }], tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: false,
    response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' }, strict: true } } });
  const c = convertChat(b, cfg());
  assert.deepEqual(c.input.map(m => m.role), ['developer', 'user', 'system']);
  assert.equal(c.input[1].content[1].detail, 'high');
  assert.equal(c.input[1].content[2].file_data, 'data:application/pdf;base64,WA==');
  assert.deepEqual(c.text.format, { type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: true });
  assert.deepEqual(c.tool_choice, { type: 'function', name: 'weather' });
  assert.equal(c.tools[0].strict, false);
  assert.equal(c.parallel_tool_calls, false);
  assert.equal(c.max_output_tokens, 12000);
  assert.equal(c.reasoning.effort, 'none');
  assert.equal(c.model, 'gpt-6.1-terra');
  assert.equal(c.top_p, 0.7);
  assert.equal(c.store, false);
  assert.deepEqual(convertChat(body({ response_format: { type: 'json_object' } }), cfg()).text, { format: { type: 'json_object' } });
  assert.equal(convertChat(body({ reasoning_effort: 'off' }), cfg()).reasoning.effort, 'low');
  const preview = convertChat(body({ model: 'gpt-6.2-sol@high@gateway-v2' }), cfg());
  assert.equal(preview.model, 'gpt-6.2-sol');
  assert.equal(preview.reasoning.effort, 'high');
  assert.throws(() => convertChat(body({ n: 2 }), cfg()), /n=1/);
});

const summaryItem = (id, ...texts) => ({ type: 'reasoning', id, encrypted_content: 'mock-private-blob',
  content: [{ type: 'reasoning_text', text: 'mock-raw-reasoning-only' }], summary: texts.map(text => ({ type: 'summary_text', text })) });
const summaryEvent = (type, fields) => ({ type: 'response.reasoning_summary_text.' + type, item_id: 'rs_1', output_index: 0, summary_index: 0, ...fields });

test('summary is opt-in, respects aliases/allowlist, keeps effort, and skips effective none', () => {
  const b = body({ model: 'gpt-6.2-sol@high@gateway-v2' });
  assert.deepEqual(convertChat(b, cfg()).reasoning, { effort: 'high' });
  const selected = cfg({ summary: 'auto', summaryModels: new Set(['gpt-6.2-sol']) });
  assert.deepEqual(convertChat(b, selected).reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(convertChat(body({ model: 'gpt-6.2-astra' }), selected).reasoning, undefined);
  assert.deepEqual(convertChat(body({ model: 'gpt-6.2-sol' }), selected).reasoning, { summary: 'auto' });
  const all = cfg({ summary: 'auto' });
  assert.deepEqual(convertChat(body({ model: 'gpt-6.1-terra', reasoning_effort: 'none' }), all).reasoning, { effort: 'none' });
  assert.throws(() => configFrom({ OPENAI_API_KEY: key, OA_GW_LOCAL_TOKEN: token, OA_GW_REASONING_SUMMARY: 'raw' }), /auto or off/);
});

test('streamed summary arrives before output, folds standalone whitespace and reconciles repeated completion snapshots', async t => {
  const live = new PassThrough(); live.statusCode = 200; live.headers = { 'content-type': 'text/event-stream' };
  t.after(() => live.destroy());
  const f = await fixture(t, () => { live.write(frame(summaryEvent('delta', { delta: '阶段一' }))); return live; }, { summary: 'auto' });
  const r = await wait(f.request(body({ stream: true })), 'summary before assistant output');
  const reader = r.body.getReader();
  const first = Buffer.from((await wait(reader.read(), 'thought chunk')).value).toString();
  assert.match(first, /"reasoning_content":"阶段一"/);
  assert.doesNotMatch(first, /正文/);
  const item = summaryItem('rs_1', '阶段一 阶段二！', '下一段');
  live.end(Buffer.concat([
    frame(summaryEvent('delta', { delta: ' ' })), frame(summaryEvent('delta', { delta: '阶段二' })),
    frame(summaryEvent('done', { text: '阶段一 阶段二！' })),
    frame({ type: 'response.reasoning_summary_part.done', item_id: item.id, output_index: 0, summary_index: 1, part: item.summary[1] }),
    frame({ type: 'response.output_item.done', output_index: 0, item }),
    frame({ type: 'response.reasoning_text.delta', delta: 'mock-raw-reasoning-only' }),
    frame(delta('正文')), frame(completed([item, msg('正文')]))
  ]));
  let rest = '';
  for (;;) { const x = await reader.read(); if (x.done) break; rest += Buffer.from(x.value).toString(); }
  const parsed = await decode(new Response(first + rest));
  assert.equal(parsed.thinking, '阶段一 阶段二！\n\n下一段');
  assert.equal(parsed.text, '正文'); assert.equal(parsed.reason, 'stop'); assert.equal(parsed.end, true);
  assert.doesNotMatch(first + rest, /mock-(?:private|raw)/);
  assert.equal(f.history[0].body.reasoning.summary, 'auto');
});

test('final-only summaries are emitted before fallback text and validated tool calls', async t => {
  const item = summaryItem('rs_1', '第一段');
  const tool = call('weather', 1, '{}');
  const f = await fixture(t, () => sse([frame(completed([item, summaryItem('rs_2', '第二段'), msg('正文'), tool]))]), { summary: 'auto' });
  const r = await decode(await f.request(body({ stream: true })));
  assert.equal(r.thinking, '第一段\n\n第二段'); assert.equal(r.text, '正文'); assert.equal(r.reason, 'tool_calls');
  assert.equal(r.calls[0].id, tool.call_id);
  const events = r.events.map(x => x.choices?.[0]?.delta ?? {});
  assert.ok(events.findIndex(x => x.reasoning_content) < events.findIndex(x => x.content === '正文'));
});

test('published non-stream summary is separated from content; no fabricated fallback for absent/disabled summaries', async t => {
  const item = summaryItem('rs_1', '摘要一', '摘要二');
  const f = await fixture(t, ({ body: b }, i) => {
    const output = [...(i === 1 ? [item] : [summaryItem('rs_1')]), msg('正文')];
    return b.stream ? sse([frame(completed(output))]) : json(reply(output));
  }, { summary: 'auto' });
  const result = await (await f.request(body())).json();
  assert.deepEqual(result.choices[0].message, { role: 'assistant', content: '正文', refusal: null, reasoning_content: '摘要一\n\n摘要二' });
  assert.doesNotMatch(JSON.stringify(result), /mock-(?:private|raw)/);
  const missing = await decode(await f.request(body({ stream: true })));
  assert.equal(missing.thinking, ''); assert.equal(missing.text, '正文');
  const off = await fixture(t, () => sse([frame(summaryEvent('delta', { delta: 'not requested' })), frame(completed([item, msg('正文')]))]));
  const unrequested = await decode(await off.request(body({ stream: true })));
  assert.equal(unrequested.thinking, ''); assert.equal(unrequested.text, '正文');
});

test('health, authentication, route checks and local body limit', async t => {
  const f = await fixture(t, () => json(reply()), { maxBody: 150 });
  assert.equal((await f.request(undefined, { route: '/health', authorization: '' })).status, 200);
  assert.equal((await f.request(body(), { authorization: '' })).status, 401);
  assert.equal((await f.request(body(), { authorization: `Bearer ${key}` })).status, 401);
  assert.equal((await f.request(body(), { route: '/models' })).status, 405);
  assert.equal((await f.request(undefined, { route: '/unknown' })).status, 404);
  assert.equal((await f.request('null')).status, 400);
  assert.equal((await f.request('!')).status, 400);
  assert.equal((await f.request('x'.repeat(160))).status, 413);
  assert.equal(f.history.length, 0);
});

test('standard SSE CRLF, LF, CR, split UTF-8, comments and multiline data', async t => {
  let round = 0;
  const f = await fixture(t, () => {
    const nl = ['\r\n', '\n', '\r'][round++];
    const raw = Buffer.concat([Buffer.from(`: comment${nl}${nl}`), frame(created, nl),
      Buffer.from(`event: response.output_text.delta${nl}data: {"type":"response.output_text.delta",${nl}data: "delta":"中文🙂"}${nl}${nl}`), frame(completed([msg('中文🙂')]), nl)]);
    return sse(Array.from(raw, x => Buffer.from([x])));
  });
  for (let i = 0; i < 3; i++) {
    const r = await decode(await f.request(body({ stream: true, stream_options: { include_usage: true } })));
    assert.equal(r.text, '中文🙂'); assert.equal(r.reason, 'stop'); assert.equal(r.end, true);
    assert.equal(r.events.at(-1).usage.total_tokens, 5);
    assert.equal(r.events[0].usage, null);
    assert.equal(new Set(r.events.map(e => e.id)).size, 1);
  }
});

test('incremental SSE is visible before upstream completes; terminal text fallback/refusal', async t => {
  const live = new PassThrough(); live.statusCode = 200; live.headers = { 'content-type': 'text/event-stream' };
  t.after(() => live.destroy());
  const f = await fixture(t, () => { live.write(frame(delta('早'))); return live; });
  const r = await wait(f.request(body({ stream: true })), 'first downstream chunk');
  const reader = r.body.getReader();
  const first = Buffer.from((await wait(reader.read(), 'first SSE data')).value).toString();
  assert.match(first, /早/);
  live.end(frame(completed([msg('早安'), { type: 'message', content: [{ type: 'refusal', refusal: 'refused' }] }])));
  const later = Buffer.from((await reader.read()).value).toString();
  assert.match(later, /安/); assert.match(later, /"refusal":"refused"/);
  while (!(await reader.read()).done) { /* drain */ }
});

test('stream truncation and content filtering are not successful tool calls', async t => {
  const a = call('weather', 1, '{"city":');
  const f = await fixture(t, (_, i) => sse([frame(delta('partial')), frame(add(1, a)), frame(incomplete(i === 1 ? 'max_output_tokens' : 'content_filter', [msg('partial'), a]))]));
  for (const reason of ['length', 'content_filter']) {
    const r = await decode(await f.request(body({ stream: true })));
    assert.equal(r.reason, reason); assert.equal(r.text, 'partial'); assert.equal(r.calls.length, 0); assert.equal(r.end, true);
  }
});

test('missing terminal, malformed SSE, and upstream stream errors do not end as success', async t => {
  const f = await fixture(t, (_, i) => sse([frame(delta('partial')), i === 1 ? Buffer.from('data: [DONE]\n\n') : i === 2 ? Buffer.from('data: !\n\n') : frame({ type: 'response.failed' })]));
  for (const code of ['stream_missing_terminal', 'invalid_sse_event', 'upstream_stream_failed']) {
    const r = await decode(await f.request(body({ stream: true })));
    assert.equal(r.error.code, code); assert.equal(r.reason, undefined); assert.equal(r.end, false);
  }
});

test('SSE invalid UTF-8 and an oversize frame are rejected', async () => {
  async function collect(s, limit) { for await (const _ of parseSse(s, limit)) { /* drain */ } }
  await assert.rejects(collect(Readable.from([Buffer.from([0xff])]), 100), e => e.code === 'invalid_upstream_utf8');
  await assert.rejects(collect(Readable.from([Buffer.from('data: ' + 'x'.repeat(100))]), 20), e => e.code === 'sse_event_too_large');
});

test('parallel tool calls use dense indices, final args (including done-only) and correct call IDs', async t => {
  const a = call('weather', 1, ''), b = call('calendar', 2, '');
  const f = await fixture(t, () => sse([created, add(1, a), add(2, b), pieces(1, a, '{"city":'), done(2, b, '{"day":1}'), pieces(1, a, '"北京"}'),
    completed([{ type: 'reasoning' }, { ...a, arguments: '{"city":"北京"}' }, b])].map(e => frame(e))));
  const r = await decode(await f.request(body({ stream: true })));
  assert.equal(r.reason, 'tool_calls'); assert.equal(r.end, true);
  assert.deepEqual(r.calls.map(x => [x.index, x.id, x.function.name, JSON.parse(x.function.arguments)]), [[0, 'call_1', 'weather', { city: '北京' }], [1, 'call_2', 'calendar', { day: 1 }]]);
});

test('invalid or unconfirmed tool calls are withheld entirely', async t => {
  const a = call('weather', 1, '');
  const f = await fixture(t, (_, i) => sse([add(0, a), ...(i === 2 ? [pieces(0, a, '{"city":"A"}')] : []),
    completed(i === 3 ? [] : [{ ...a, arguments: i === 1 ? '{"city":' : '{"city":"B"}' }])].map(e => frame(e))));
  for (const code of ['invalid_tool_arguments', 'tool_arguments_conflict', 'unconfirmed_tool_call']) {
    const r = await f.request(body({ stream: true }));
    assert.equal(r.status, 502); assert.equal((await r.json()).error.code, code);
  }
});

test('multi-turn tools round trip on the local HTTP server with bounded reasoning carryover', async t => {
  const a = call('weather', 1, '{"city":"北京"}'), r = { type: 'reasoning', id: 'rs_a', encrypted_content: 'synthetic-encrypted-opaque', summary: [] };
  const f = await fixture(t, (_, i) => i === 1 ? sse([frame(completed([r, a]))]) : json(reply([msg('北京晴天')])));
  const first = await decode(await f.request(body({ stream: true })));
  const { index, ...toolCall } = first.calls[0];
  const turns = [...body().messages, { role: 'assistant', content: null, tool_calls: [toolCall] }, { role: 'tool', tool_call_id: toolCall.id, content: '晴天' }];
  const result = await (await f.request(body({ messages: turns }))).json();
  assert.equal(result.choices[0].message.content, '北京晴天');
  assert.deepEqual(f.history[1].body.input.slice(1), [r, { type: 'function_call', call_id: a.call_id, name: a.name, arguments: a.arguments }, { type: 'function_call_output', call_id: a.call_id, output: '晴天' }]);
  assert.equal(f.history[1].body.store, false);
  assert.equal((await f.request(body({ messages: [...turns.slice(0, -1), { ...turns.at(-1), tool_call_id: 'call_other' }] }))).status, 400);
  const memory = reasoningMemory({ maxEntries: 1, maxBytes: 4096 });
  memory.remember('m', [r, a]);
  assert.equal(memory.get('m', a).length, 1);
  assert.equal(memory.get('other', a).length, 0);
  assert.equal(memory.get('m', { ...a, arguments: '{}' }).length, 0);
  const a2 = call('weather', 2, '{}'); memory.remember('m', [r, a2]); assert.equal(memory.get('m', a).length, 0);
});

test('non-streaming output, limits, threading and failure are mapped correctly', async t => {
  const a = call('weather', 1, '{}');
  const f = await fixture(t, (_, i) => json(i === 1 ? reply([msg('中文'), a]) : i === 2 ? incomplete('max_output_tokens', [msg('part'), a]).response : reply([], { status: 'failed' })));
  const x = await (await f.request(body())).json();
  assert.equal(x.choices[0].message.content, '中文'); assert.equal(x.choices[0].finish_reason, 'tool_calls'); assert.equal(x.choices[0].message.tool_calls[0].id, 'call_1');
  const y = await (await f.request(body())).json();
  assert.equal(y.choices[0].finish_reason, 'length'); assert.equal(y.choices[0].message.tool_calls, undefined);
  assert.equal((await f.request(body())).status, 502);
});

test('model list forwards 401 and 429, retry metadata; successful listing is unchanged', async t => {
  const f = await fixture(t, (_, i) => i === 1 ? json({ error: { message: 'key: ' + key, code: 'api_key_invalid' } }, 401) : i === 2 ? json({ error: { message: 'limit' } }, 429, { 'retry-after': '8', 'x-request-id': 'req_fixture' }) : json({ data: [{ id: 'model-1' }] }));
  const req = () => f.request(undefined, { route: '/v1/models' });
  let r = await req(); assert.equal(r.status, 401); assert.match((await r.json()).error.message, /\[redacted\]/);
  r = await req(); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '8'); assert.equal(r.headers.get('x-request-id'), 'req_fixture');
  r = await req(); assert.deepEqual((await r.json()).data, [{ id: 'model-1' }]);
});

test('disconnect cancels upstream and destroys streamed response; no automatic replay', async t => {
  let abort, closed;
  const seenAbort = new Promise(resolve => { abort = resolve; });
  const seenClose = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, ({ signal }) => {
    signal.addEventListener('abort', () => abort(signal.reason), { once: true });
    const live = new PassThrough(); live.statusCode = 200; live.headers = { 'content-type': 'text/event-stream' };
    live.once('close', closed); live.write(frame(delta('partial'))); return live;
  });
  const c = new AbortController();
  assert.equal((await f.request(body({ stream: true }), { signal: c.signal })).status, 200);
  c.abort();
  assert.equal((await wait(seenAbort, 'abort signal')).code, 'client_disconnected');
  await wait(seenClose, 'upstream close'); assert.equal(f.history.length, 1);
});

test('idle timeout before SSE data and after partial SSE; enforce concurrency', async t => {
  let markOpened;
  const opened = new Promise(resolve => { markOpened = resolve; });
  const f = await fixture(t, (_, i) => {
    const live = new PassThrough(); live.statusCode = 200; live.headers = { 'content-type': 'text/event-stream' };
    if (i === 1) markOpened(); else live.write(frame(delta('partial')));
    return live;
  }, { idleMs: 125, totalMs: 1200, maxConcurrent: 1 });
  const first = f.request(body({ stream: true }));
  await wait(opened, 'idle upstream');
  assert.equal((await f.request(body())).status, 429);
  const fail = await first;
  assert.equal(fail.status, 504); assert.equal((await fail.json()).error.code, 'upstream_idle_timeout');
  const result = await decode(await f.request(body({ stream: true })));
  assert.equal(result.error.code, 'upstream_idle_timeout'); assert.equal(result.end, false);
});

test('installation verification uses the configured port and local mode never calls upstream', async t => {
  const f = await fixture(t, () => { throw Error('unexpected upstream call'); });
  const result = await verifyGateway(cfg({ port: f.port }));
  assert.equal(result.ok, true); assert.equal(result.authStatus, 401); assert.equal(result.upstreamAttempts, 0);
  assert.equal(f.history.length, 0);
});

test('installation verification rejects a same-version synthetic probe without sending any credentials', async t => {
  const requests = [];
  const wrong = http.createServer((req, res) => {
    requests.push({ path: req.url, hasAuth: Boolean(req.headers.authorization) });
    res.end(JSON.stringify({ ok: true, version: VERSION, mode: 'probe' }));
  });
  t.after(track(wrong));
  const port = await listen(wrong);
  const result = await verifyGateway(cfg({ port }), { mode: 'text', model: 'mock-model' });
  assert.equal(result.ok, false); assert.equal(result.code, 'wrong_gateway_version'); assert.equal(result.upstreamAttempts, 0);
  assert.deepEqual(requests, [{ path: '/health', hasAuth: false }]);
});

test('live verification requires actual text, the named tool or a complete stream; never prints bodies', async t => {
  const f = await fixture(t, ({ body: b }, i) => {
    if (i === 1) return json(reply([]));
    if (i === 2) return json(reply([msg('pong')]));
    if (i === 3) return json(reply([call('other', 1, '{}')]));
    if (i === 4) return json(reply([call('gateway_test', 1, '{}')]));
    if (i === 5) return sse([frame(delta('pong'))]);
    return sse([frame(delta('pong')), frame(completed([msg('pong')]))]);
  });
  const run = mode => verifyGateway(cfg({ port: f.port }), { mode, model: 'mock-model' });
  assert.equal((await run('text')).code, 'missing_complete_text');
  assert.equal((await run('text')).ok, true);
  assert.equal((await run('tool')).code, 'missing_expected_tool_call');
  assert.equal((await run('tool')).ok, true);
  assert.equal((await run('stream')).code, 'live_stream_error');
  const success = await run('stream');
  assert.equal(success.ok, true); assert.equal(success.summaryReceived, false); assert.equal(success.upstreamAttempts, 1);
  assert.equal(f.history.length, 6);
  assert.ok(f.history.every(r => r.body.model === 'mock-model'));
  assert.doesNotMatch(JSON.stringify(success), /pong|local-test-token/);
});

const openssl = process.env.OA_GW_TEST_OPENSSL || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/mingw64/bin/openssl.exe') ? 'C:/Program Files/Git/mingw64/bin/openssl.exe' : 'openssl');
async function tlsFixture(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.gateway-test-'));
  t.after(() => { for (const n of ['key.pem', 'cert.pem']) { const f = path.join(dir, n); if (fs.existsSync(f)) fs.unlinkSync(f); } fs.rmdirSync(dir); });
  const keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore', windowsHide: true });
  const key = fs.readFileSync(keyFile), cert = fs.readFileSync(certFile);
  const queries = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    queries.push({ url: req.url, authorization: req.headers.authorization });
    req.resume();
    if (req.url === '/v1/hold') return;
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame(delta('proxy-stream')));
      res.write(frame(completed([msg('proxy-stream')])));
      return setTimeout(() => res.end(), 15);
    }
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(track(server));
  return { port: await listen(server), cert, queries };
}
async function proxyFixture(t, mode, upstreamPort = 0) {
  const server = http.createServer();
  let connects = 0, notifyOpen, notifyClose;
  const opened = new Promise(resolve => { notifyOpen = resolve; });
  const ended = new Promise(resolve => { notifyClose = resolve; });
  server.on('connect', (req, socket, head) => {
    connects++; socket.on('error', () => {}); socket.on('end', () => socket.end()); socket.once('close', notifyClose); notifyOpen();
    if (mode === 'reject') return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
    if (mode === 'tunnel-delay') return;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (mode === 'tls-delay') { socket.resume(); return; }
    assert.equal(req.url, `127.0.0.1:${upstreamPort}`);
    const remote = net.connect(upstreamPort, '127.0.0.1');
    remote.on('error', () => socket.destroy()); socket.once('close', () => remote.destroy());
    if (head.length) remote.write(head);
    remote.pipe(socket).pipe(remote);
  });
  t.after(track(server));
  return { port: await listen(server), opened, ended, connections: () => connects };
}
async function through(transport, endpoint = '/models', signal) {
  const up = await transport.request({ method: 'GET', endpoint, signal });
  const b = []; for await (const chunk of up) b.push(chunk);
  return JSON.parse(Buffer.concat(b).toString());
}

test('actual local HTTPS through CONNECT verifies TLS and reuses the tunnel', async t => {
  const up = await tlsFixture(t), proxy = await proxyFixture(t, 'pass', up.port);
  const transport = makeTransport(cfg({ host: '127.0.0.1', upstreamPort: up.port, proxyPort: proxy.port, ca: up.cert }));
  t.after(() => transport.close());
  assert.deepEqual(await through(transport), { ok: true });
  assert.deepEqual(await through(transport), { ok: true });
  assert.equal(proxy.connections(), 1);
  assert.deepEqual(up.queries.map(x => x.authorization), [`Bearer ${key}`, `Bearer ${key}`]);
});

test('normal streaming terminal drains to EOF so sequential chats reuse the actual proxy tunnel', async t => {
  const up = await tlsFixture(t), proxy = await proxyFixture(t, 'pass', up.port);
  const gateway = createGateway(cfg({ host: '127.0.0.1', upstreamPort: up.port, proxyPort: proxy.port, ca: up.cert, maxConcurrent: 1 }));
  t.after(track(gateway));
  const port = await listen(gateway);
  for (let i = 0; i < 2; i++) {
    const r = await decode(await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body({ stream: true })),
    }));
    assert.equal(r.text, 'proxy-stream'); assert.equal(r.end, true);
    await delay(70);
  }
  assert.equal(proxy.connections(), 1);
  assert.deepEqual(up.queries.map(x => x.authorization), [`Bearer ${key}`, `Bearer ${key}`]);
});

test('actual CONNECT rejection, CONNECT response timeout and TLS timeout are distinguishable', async t => {
  for (const [mode, expected] of [['reject', 'proxy_rejected'], ['tunnel-delay', 'proxy_tunnel_timeout'], ['tls-delay', 'upstream_tls_timeout']]) {
    const proxy = await proxyFixture(t, mode);
    const tr = makeTransport(cfg({ proxyPort: proxy.port, connectMs: 500, tunnelMs: 100, tlsMs: 100, headersMs: 1000 }));
    try { await assert.rejects(through(tr), e => e.code === expected); }
    finally { tr.close(); }
  }
});

test('pending CONNECT is cancelled before timeout when downstream aborts', async t => {
  const proxy = await proxyFixture(t, 'tunnel-delay');
  const tr = makeTransport(cfg({ proxyPort: proxy.port, tunnelMs: 10000, headersMs: 15000 }));
  t.after(() => tr.close());
  const controller = new AbortController();
  const err = new Error('test-cancel');
  const assertion = assert.rejects(through(tr, '/models', controller.signal), e => e === err);
  await wait(proxy.opened, 'proxy opening'); controller.abort(err);
  await wait(assertion, 'proxy abort'); await wait(proxy.ended, 'proxy socket release');
});

test('direct HTTPS validates certificates and has a distinct header deadline', async t => {
  const up = await tlsFixture(t);
  const conf = { host: '127.0.0.1', upstreamPort: up.port, useProxy: false, headersMs: 150, tlsMs: 500 };
  const trusted = makeTransport(cfg({ ...conf, ca: up.cert }));
  const untrusted = makeTransport(cfg(conf));
  t.after(() => { trusted.close(); untrusted.close(); });
  assert.deepEqual(await through(trusted), { ok: true });
  await assert.rejects(through(untrusted), e => e.code === 'upstream_tls_failed');
  await assert.rejects(through(trusted, '/hold'), e => e.code === 'upstream_headers_timeout');
});
