@echo off
cd /d "%~dp0"
start wt -w 0 nt "%~dp0.venv\Scripts\python.exe" "%~dp0chat_tui.py"