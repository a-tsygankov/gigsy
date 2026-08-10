# Mint a Google refresh token for the E2E test account.
#
# Run once, by hand. Prints ONLY the refresh token, so it can be piped
# straight into `gh secret set` without ever landing in a file or in
# shell history.
#
# Google retired the copy-paste "oob" flow in 2022, so this listens on a
# loopback port and catches the redirect. That port must be registered:
#   Google Cloud console -> Credentials -> your OAuth client
#   -> Authorized redirect URIs -> add http://localhost:8910
#
# The test account must also be listed under OAuth consent screen ->
# Test users, or consent is refused outright.
#
# ASCII only, deliberately: Windows PowerShell 5.1 mangles non-ASCII in
# a BOM-less file, which previously leaked parameter text into output.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ClientId,

    [Parameter(Mandatory = $true)]
    [string] $ClientSecret,

    [int] $Port = 8910
)

$ErrorActionPreference = 'Stop'

$redirectUri = "http://localhost:$Port"
$scope = 'https://www.googleapis.com/auth/calendar.events'

# access_type=offline asks for a refresh token at all; prompt=consent
# forces one even when this account has already granted the scope.
# Without the second, a re-consent returns an access token only and the
# exchange below comes back with nothing to store.
$authUrl = 'https://accounts.google.com/o/oauth2/v2/auth' +
    "?client_id=$([uri]::EscapeDataString($ClientId))" +
    "&redirect_uri=$([uri]::EscapeDataString($redirectUri))" +
    '&response_type=code' +
    "&scope=$([uri]::EscapeDataString($scope))" +
    '&access_type=offline' +
    '&prompt=consent'

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("$redirectUri/")

try {
    $listener.Start()
}
catch {
    Write-Host "Could not listen on $redirectUri" -ForegroundColor Red
    Write-Host 'Another process may hold the port; pass -Port to pick another.'
    Write-Host '(A different port must also be registered as a redirect URI.)'
    throw
}

Write-Host ''
Write-Host 'Sign in as the TEST account (gigsy.test@gmail.com), not your own.'
Write-Host 'Opening the consent screen...'
Write-Host ''
Start-Process $authUrl

try {
    # Blocks until Google redirects the browser back to the loopback.
    $context = $listener.GetContext()
    $code = $context.Request.QueryString['code']
    $oauthError = $context.Request.QueryString['error']

    $message = if ($code) { 'Done. You can close this tab.' } else { 'Consent failed.' }
    $html = [System.Text.Encoding]::UTF8.GetBytes(
        "<html><body style='font-family:sans-serif'><p>$message</p></body></html>")
    $context.Response.ContentType = 'text/html'
    $context.Response.OutputStream.Write($html, 0, $html.Length)
    $context.Response.Close()
}
finally {
    $listener.Stop()
    $listener.Close()
}

if ($oauthError) {
    throw "Consent was refused: $oauthError"
}
if (-not $code) {
    throw 'No authorization code came back.'
}

$response = Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' -Body @{
    code          = $code
    client_id     = $ClientId
    client_secret = $ClientSecret
    redirect_uri  = $redirectUri
    grant_type    = 'authorization_code'
}

if (-not $response.refresh_token) {
    Write-Host ''
    Write-Host 'Google returned an access token but no refresh token.' -ForegroundColor Red
    Write-Host 'That happens when the scope was already granted and prompt=consent'
    Write-Host 'did not take. Revoke Gigsy at https://myaccount.google.com/permissions'
    Write-Host 'for the test account, then run this again.'
    throw 'No refresh token issued.'
}

Write-Host ''
Write-Host 'Refresh token minted. Store it without pasting it anywhere:' -ForegroundColor Green
Write-Host '  gh secret set E2E_GOOGLE_REFRESH_TOKEN --repo a-tsygankov/gigsy'
Write-Host 'then paste at the prompt. Also needed, once:'
Write-Host '  gh secret set GOOGLE_CLIENT_ID --repo a-tsygankov/gigsy'
Write-Host '  gh secret set GOOGLE_CLIENT_SECRET --repo a-tsygankov/gigsy'
Write-Host ''
Write-Host 'Heads up: while the OAuth app is in Testing status, Google expires' -ForegroundColor Yellow
Write-Host 'refresh tokens for sensitive scopes after 7 days. The live calendar' -ForegroundColor Yellow
Write-Host 'workflow is manual-dispatch for that reason - re-run this when it' -ForegroundColor Yellow
Write-Host 'reports an expired grant.' -ForegroundColor Yellow
Write-Host ''

# Last line, and nothing else on it, so `... | gh secret set` works.
Write-Output $response.refresh_token
