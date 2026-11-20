@echo off
setlocal
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node.exe"

if /i "%~1"=="probe" goto :probe
if /i "%~1"=="help" goto :usage
if /i "%~1"=="-h" goto :usage
if /i "%~1"=="--help" goto :usage

rem An explicit port overrides the environment file; no argument preserves its port.
if not "%~2"=="" if /i not "%~2"=="summary" goto :usage
if not "%~3"=="" goto :usage
if /i "%~1"=="summary" set "OA_GW_REASONING_SUMMARY=auto"
if /i "%~2"=="summary" set "OA_GW_REASONING_SUMMARY=auto"
if not "%~1"=="" if /i not "%~1"=="summary" set "OA_GW_PORT=%~1"

rem Never inherit credentials from the calling shell; the env file is the only source.
set "OPENAI_API_KEY="
set "OA_GW_KEY_MODEL="
set "OA_GW_LOCAL_TOKEN="

"%NODE%" "%~dp0oa-gateway.js" --check-config
if errorlevel 1 goto :failed
"%NODE%" "%~dp0oa-gateway.js"
if errorlevel 1 goto :failed
exit /b 0

:probe
"%NODE%" "%~dp0oa-gateway.js" --probe-summary
if errorlevel 1 goto :failed
exit /b 0

:usage
echo Usage: Start-Gateway.cmd [PORT^|summary] [summary]
echo        Start-Gateway.cmd probe
echo.
echo   Start-Gateway.cmd              start on the configured port ^(default 8788^)
echo   Start-Gateway.cmd 8789         start on a custom port
echo   Start-Gateway.cmd summary      start with reasoning summaries enabled
echo   Start-Gateway.cmd probe        run the offline synthetic summary probe
exit /b 2

:failed
echo Gateway did not start. Check the message above. No existing process was stopped.
pause
exit /b 1
