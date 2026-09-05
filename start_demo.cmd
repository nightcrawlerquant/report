@echo off
chcp 65001 >nul
cd /d "%~dp0"
python -X utf8 -B demo.py
if errorlevel 1 (
    pause
    exit /b 1
)
start "" "%~dp0output\backtest_demo.html"
start "" "%~dp0output\live_demo.html"
