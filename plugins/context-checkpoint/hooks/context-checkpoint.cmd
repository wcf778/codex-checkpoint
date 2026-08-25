@echo off
setlocal
set "CC_NODE="
for %%D in ("%PATH:;=" "%") do if not defined CC_NODE call :find_node "%%~D"
if not defined CC_NODE (
  >&2 echo context-checkpoint: node.exe was not found on PATH
  exit /b 127
)
"%CC_NODE%" "%~dp0context-checkpoint.cjs"
exit /b %errorlevel%

:find_node
set "CC_DIR=%~1"
if "%CC_DIR:~1,1%"==":" if exist "%CC_DIR%\node.exe" set "CC_NODE=%CC_DIR%\node.exe"
if "%CC_DIR:~0,2%"=="\\" if exist "%CC_DIR%\node.exe" set "CC_NODE=%CC_DIR%\node.exe"
exit /b
