@echo off
setlocal EnableExtensions DisableDelayedExpansion

REM 2026-09-20 + Start production TMTV in an isolated Chrome instance with ANGLE D3D11on12.
REM Replace the URL below, or pass the production URL as the first argument.
set "TMTV_URL=https://replace-with-production-host.example/"
if not "%~1"=="" set "TMTV_URL=%~1"

if /I "%TMTV_URL%"=="https://replace-with-production-host.example/" (
  echo [ERROR] Production URL is not configured.
  echo Edit TMTV_URL in this script or pass the URL as the first argument.
  echo Example: start-tmtv-production.cmd "https://viewer.example.com/"
  pause
  exit /b 2
)

set "CHROME_EXE="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not defined CHROME_EXE (
  echo [ERROR] Google Chrome was not found.
  echo Install Chrome or update CHROME_EXE in this script.
  pause
  exit /b 3
)

set "PROFILE_DIR=%LocalAppData%\OHIF-TMTV\ChromeProfile"
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%" >nul 2>&1
if not exist "%PROFILE_DIR%" (
  echo [ERROR] Cannot create the Chrome profile directory:
  echo %PROFILE_DIR%
  pause
  exit /b 4
)

start "OHIF TMTV" "%CHROME_EXE%" ^
  --user-data-dir="%PROFILE_DIR%" ^
  --use-gl=angle ^
  --use-angle=d3d11on12 ^
  --no-first-run ^
  --no-default-browser-check ^
  --new-window ^
  "%TMTV_URL%"

if errorlevel 1 (
  echo [ERROR] Chrome could not be started.
  pause
  exit /b 5
)

endlocal
exit /b 0
