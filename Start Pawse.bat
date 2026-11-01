@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 start.py
) else (
  python start.py
)
if errorlevel 1 (
  echo Install Python 3.11+ from https://www.python.org/downloads/ if Python was not found.
  pause
)
