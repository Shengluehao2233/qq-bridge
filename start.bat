@echo off
REM ===========================================================================
REM  start.bat -- guard window for the qq-bridge (keeps it alive, shows output)
REM
REM  KEEP THIS WINDOW OPEN. Closing it stops the bridge.
REM
REM  RESTART POLICY
REM    The bridge exits immediately (code 1) when a dependency is missing --
REM    most often SnowLuma's OneBot (3000/3001) or DSH (3082) is not up yet.
REM    Retrying every 5 seconds forever just floods this window and hides the
REM    real cause, so:
REM      * the first 3 failures retry after 5s each (transient blips recover),
REM      * every failure after that retries every 60s, and
REM      * the dependency hint is printed once instead of on every loop.
REM    Exit code 2 (another instance already holds the lock) still stops the
REM    guard outright, because retrying it can never succeed.
REM
REM  KEEP THIS FILE ASCII-ONLY (cmd.exe parses .bat with the OEM code page;
REM  a Chinese Windows reads it as GBK, so UTF-8 text here would be misparsed).
REM ===========================================================================
@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

REM Harden state/ ACLs (upstream v0.2.0): Windows needs WRITE_DAC; the directory
REM owner normally has it, so no UAC prompt in the usual case. NEVER blocks
REM startup: if it cannot get permission it prints a command and exits 0.
node scripts\harden-state-acl.mjs --quiet

REM Only pause when this window actually has an interactive console. When the
REM guard is launched by start-all.cmd (or any wrapper), stdin may be a pipe or
REM NUL, and a bare `pause` then waits forever on EOF -- the guard looks alive
REM but never restarts the bridge. Measured values for [Console]::IsInputRedirected:
REM   real double-clicked window -> False ; spawned/wrapped window -> True.
%PS% -NoProfile -Command "if([Console]::IsInputRedirected){exit 1}else{exit 0}" >nul 2>nul
if errorlevel 1 (set "INTERACTIVE=") else (set "INTERACTIVE=1")
set /a fails=0
set "hinted="

:loop
node src/bridge.js
set "code=%errorlevel%"
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    if defined INTERACTIVE pause
    exit /b 2
)

set /a fails+=1
if %fails% leq 3 (
    set "wait=5"
) else (
    set "wait=60"
)

REM NOTE: the dependency check below lives in a subroutine on purpose. A
REM PowerShell one-liner full of parentheses placed INSIDE an `if (...)` block
REM makes cmd.exe's block parser abort with ". was unexpected at this time.",
REM which would kill the guard window on the first retry.
if not defined hinted (
    echo [%date% %time%] bridge exited (code %code%). Checking dependencies once...
    call :depcheck
    set "hinted=1"
    echo [%date% %time%] will keep retrying (5s for the first 3 tries, then every 60s). Press Ctrl+C to stop.
)

REM `timeout` refuses to run when stdin is redirected ("Input redirection is not
REM supported") and returns instantly, which turns this loop into a busy spin when
REM the guard was launched by a wrapper. Fall back to a PowerShell sleep there.
if defined INTERACTIVE (
    timeout /t %wait% /nobreak >nul
) else (
    %PS% -NoProfile -Command "Start-Sleep -Seconds %wait%" >nul 2>nul
)
goto loop

:depcheck
%PS% -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $sl=(Get-NetTCPConnection -State Listen -LocalPort 3000) -and (Get-NetTCPConnection -State Listen -LocalPort 3001); $dsh=(Get-NetTCPConnection -State Listen -LocalPort 3082); if(-not $sl){ Write-Host '  !! SnowLuma OneBot 3000/3001 is NOT listening -- start SnowLuma (QQ must be running), then rerun.' }; if(-not $dsh){ Write-Host '  !! DSH 3082 is NOT listening -- start the qq DSH window, then rerun.' }; if($sl -and $dsh){ Write-Host '  Both dependencies look up. The failure is elsewhere -- read the error above.' }"
exit /b 0
