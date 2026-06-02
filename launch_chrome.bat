@echo off
echo Launching Google Chrome with dedicated autonomous agent profile and remote debugging...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%~dp0chrome_profile" --remote-debugging-port=9222 --remote-allow-origins=* --no-first-run --no-default-browser-check
echo Chrome launched! Remote debugging port: 9222
echo Zeronaut daemon can now automate and control this browser window!
pause
