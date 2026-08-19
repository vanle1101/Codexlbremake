@echo off
title Codex-LB Server
cd /d "%~dp0"

echo ===================================================
echo           Starting Codex-LB Server...
echo ===================================================
echo Dashboard URL: http://localhost:2455
echo Health Check:  http://localhost:2455/health
echo ===================================================
echo.

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -m app.cli --host 0.0.0.0 --port 2455
) else (
    uv run codex-lb --host 0.0.0.0 --port 2455
)

pause
