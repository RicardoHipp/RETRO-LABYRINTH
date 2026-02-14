@echo off
echo ============================================================
echo   🎮 RETRO LABYRINTH - START SCRIPT
echo ============================================================
echo.
echo 1. Oeffne Spiel im Webbrowser (http://localhost:3333)...
start http://localhost:3333
echo.
echo 2. Starte lokalen Webserver...
echo (Hinweis: Zum Beenden dieses Fenster schliessen oder Strg+C druecken)
echo.
npx -y serve . -l 3333 --no-clipboard
pause
