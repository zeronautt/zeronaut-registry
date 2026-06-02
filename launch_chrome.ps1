# Launch Google Chrome with a dedicated, isolated autonomous agent profile and remote debugging enabled
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = Join-Path $PSScriptRoot "chrome_profile"

if (Test-Path $chromePath) {
    Write-Host "Launching Google Chrome with dedicated autonomous agent profile and remote debugging..."
    Start-Process -FilePath $chromePath -ArgumentList "--user-data-dir=`"$profileDir`"", "--remote-debugging-port=9222", "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check"
    Write-Host "Chrome launched successfully on remote debugging port 9222!"
} else {
    Write-Error "Google Chrome could not be found at standard location: $chromePath"
}
