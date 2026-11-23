@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "dist\client\index.html" (
  echo [Otzar Sefarim] Building frontend...
  call npm run build
)

powershell -NoProfile -Command "try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:4747/api/health' -UseBasicParsing -TimeoutSec 1; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo [Otzar Sefarim] Starting local server...
  start /min "OtzarSefarimServer" cmd /c "npx tsx server/index.ts"
  powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){ try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:4747/api/health' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){ break } } catch {}; Start-Sleep -Milliseconds 350 }"
)

set "EDGE_PATH=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE_PATH%" set "EDGE_PATH=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if exist "%EDGE_PATH%" (
  start "" "%EDGE_PATH%" --app=http://127.0.0.1:4747 --window-size=1440,900 --user-data-dir="%~dp0data\edge_profile"
) else (
  start "" "http://127.0.0.1:4747"
)
