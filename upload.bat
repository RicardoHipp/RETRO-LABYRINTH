@echo off
echo [GitHub Upload] Bereite Dateien vor...
git add .

echo.
set /p msg="Commit-Nachricht (Enter fuer 'Auto-Update'): "
if "%msg%"=="" set msg=Auto-Update

echo.
echo [GitHub Upload] Commit wird erstellt...
git commit -m "%msg%"

echo.
echo [GitHub Upload] Push zu GitHub...
git push

echo.
echo [GitHub Upload] Fertig!
pause
