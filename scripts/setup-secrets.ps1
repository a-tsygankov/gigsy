#!/usr/bin/env pwsh
<#
.SYNOPSIS
  One-stop secrets bootstrap for Gigsy: GitHub Actions secrets (via
  `gh`) + Cloudflare Worker secrets (via `wrangler`), plus one-time
  D1/R2 provisioning. Full secret matrix: docs/plan.md §11.

.DESCRIPTION
  1. COPY this file to scripts/setup-secrets.local.ps1 (gitignored).
  2. Fill in the placeholder values in the FILL ME IN block below.
     - Leave 'GENERATE' where present to have the script mint a
       cryptographically random 32-byte base64 key (AUTH_SECRET,
       REFRESH_TOKEN_ENC_KEY).
     - Anything still wrapped in <angle-brackets> is skipped with a
       warning — optional secrets can stay as placeholders forever.
  3. Run it:
       ./scripts/setup-secrets.local.ps1 -Provision   # once: create D1 + R2
       ./scripts/setup-secrets.local.ps1 -All         # GitHub + Worker secrets
       ./scripts/setup-secrets.local.ps1 -GitHub      # only gh secret set
       ./scripts/setup-secrets.local.ps1 -Cloudflare  # only wrangler secret put
       ./scripts/setup-secrets.local.ps1 -All -DryRun # show plan, set nothing
  4. NEVER commit a filled-in copy. Values are never echoed.

  Prereqs: `gh auth login` done (for -GitHub); `wrangler login` or
  CLOUDFLARE_API_TOKEN in the environment (for -Cloudflare/-Provision);
  `pnpm install` done (wrangler runs via `pnpm exec` from backend/).

.NOTES
  Where each value comes from:
    CLOUDFLARE_API_KEY      dash.cloudflare.com → My Profile → API Tokens →
                            Create Token → scopes: Workers Scripts:Edit,
                            D1:Edit, Cloudflare Pages:Edit (an API *token*,
                            not the legacy global key)
    CLOUDFLARE_ACCOUNT_ID   dashboard sidebar (32-char hex)
    GOOGLE_CLIENT_SECRET    console.cloud.google.com → APIs & Services →
                            Credentials → your OAuth "Web application"
                            client (Calendar API enabled). The public
                            client ID goes in backend/wrangler.toml [vars].
    GEMINI_API_KEY          aistudio.google.com → Get API key
    ANTHROPIC_API_KEY       console.anthropic.com (optional fallback
                            extraction provider)
    PR_MERMAID_ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
                            optional — PR diagram workflow
#>
[CmdletBinding()]
param(
    [switch]$GitHub,
    [switch]$Cloudflare,
    [switch]$All,
    [switch]$Provision,
    [switch]$DryRun,
    # Owner/name; auto-detected from the git remote when omitted.
    [string]$Repo = ''
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# ══ FILL ME IN ══════════════════════════════════════════════════════
# 'GENERATE'        → script mints a random 32-byte base64 key.
# '<placeholder>'   → skipped with a warning (fine for optional ones).

$GitHubSecrets = [ordered]@{
    CLOUDFLARE_API_KEY           = '<cloudflare-api-token-workers+d1+pages-edit>'
    CLOUDFLARE_ACCOUNT_ID        = '<cloudflare-account-id-32-hex>'
    # Optional — PR mermaid-diagram workflow:
    PR_MERMAID_ANTHROPIC_API_KEY = '<optional-anthropic-api-key>'
    CLAUDE_CODE_OAUTH_TOKEN      = '<optional-claude-code-oauth-token>'
}

$WorkerSecrets = [ordered]@{
    AUTH_SECRET           = 'GENERATE'                                  # JWT HS256 signing key
    REFRESH_TOKEN_ENC_KEY = 'GENERATE'                                  # AES-GCM key for users.google_refresh_token_enc
    GOOGLE_CLIENT_SECRET  = '<google-oauth-client-secret>'              # auth code -> refresh token exchange
    GEMINI_API_KEY        = '<gemini-api-key>'                          # primary extraction provider
    # Optional — fallback/alt extraction provider:
    ANTHROPIC_API_KEY     = '<optional-anthropic-api-key>'
    # Push notifications. GENERATE_VAPID mints a P-256 pair and prints
    # the PUBLIC half for wrangler.toml [vars] — unlike the symmetric
    # keys above, this one has a counterpart the browser must know.
    VAPID_PRIVATE_KEY     = 'GENERATE_VAPID'
}
# ══ END FILL ME IN ══════════════════════════════════════════════════

if ($All) { $GitHub = $true; $Cloudflare = $true }
if (-not ($GitHub -or $Cloudflare -or $Provision)) {
    Write-Host 'Usage: setup-secrets.ps1 [-GitHub] [-Cloudflare] [-All] [-Provision] [-DryRun]'
    Write-Host 'See the comment header for the full walkthrough.'
    exit 1
}

function Test-Placeholder([string]$Value) {
    return $Value -match '^<.*>$' -or [string]::IsNullOrWhiteSpace($Value)
}

function New-VapidKeyPair {
    # Web Push (RFC 8292) wants raw P-256 material, base64url: the
    # public key as the 65-byte uncompressed point 0x04||X||Y, and the
    # private key as the bare 32-byte scalar D.
    $ecdsa = [System.Security.Cryptography.ECDsa]::Create(
        [System.Security.Cryptography.ECCurve]::CreateFromFriendlyName('nistP256'))
    try {
        $p = $ecdsa.ExportParameters($true)
        $publicBytes = [byte[]]::new(65)
        $publicBytes[0] = 4
        [Array]::Copy($p.Q.X, 0, $publicBytes, 1, 32)
        [Array]::Copy($p.Q.Y, 0, $publicBytes, 33, 32)
        return @{
            PublicKey  = (ConvertTo-Base64Url $publicBytes)
            PrivateKey = (ConvertTo-Base64Url $p.D)
        }
    }
    finally { $ecdsa.Dispose() }
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomKey {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes)
}

$script:setCount = 0
$script:skipped = @()

function Resolve-SecretValue([string]$Name, [string]$Value) {
    if ($Value -ceq 'GENERATE') {
        Write-Host "  $Name — generating random 32-byte key" -ForegroundColor DarkGray
        return New-RandomKey
    }
    if ($Value -ceq 'GENERATE_VAPID') {
        $pair = New-VapidKeyPair
        Write-Host "  $Name — generated a P-256 pair" -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '  ACTION REQUIRED — put the PUBLIC half in backend/wrangler.toml [vars]:' -ForegroundColor Yellow
        Write-Host "  VAPID_PUBLIC_KEY = `"$($pair.PublicKey)`"" -ForegroundColor Yellow
        Write-Host '  Push stays switched off until both halves are in place.' -ForegroundColor Yellow
        Write-Host ''
        return $pair.PrivateKey
    }
    if (Test-Placeholder $Value) {
        $script:skipped += $Name
        Write-Warning "$Name still a placeholder — skipped"
        return $null
    }
    return $Value
}

if ($Provision) {
    Write-Host '── provision (one-time) ──' -ForegroundColor Cyan
    if ($DryRun) {
        Write-Host '  [dry-run] wrangler d1 create gigsy-db'
        Write-Host '  [dry-run] wrangler r2 bucket create gigsy-receipts'
    } else {
        Push-Location backend
        try {
            # d1 create prints a [[d1_databases]] block with the real
            # database_id — paste that ID into backend/wrangler.toml.
            pnpm exec wrangler d1 create gigsy-db
            pnpm exec wrangler r2 bucket create gigsy-receipts
        } finally { Pop-Location }
        Write-Host ''
        Write-Host 'NOW: paste the printed database_id into backend/wrangler.toml' -ForegroundColor Yellow
    }
}

if ($GitHub) {
    Write-Host '── GitHub Actions secrets ──' -ForegroundColor Cyan
    if (-not $Repo) {
        $originUrl = git remote get-url origin 2>$null
        if ($originUrl -match 'github\.com[:/](.+?)(?:\.git)?$') { $Repo = $Matches[1] }
    }
    if (-not $Repo) { throw 'Could not detect the GitHub repo — pass -Repo owner/name.' }
    gh auth status *> $null
    if ($LASTEXITCODE -ne 0) { throw 'gh is not authenticated — run `gh auth login` first.' }
    Write-Host "  repo: $Repo"

    foreach ($name in $GitHubSecrets.Keys) {
        $value = Resolve-SecretValue $name $GitHubSecrets[$name]
        if ($null -eq $value) { continue }
        if ($DryRun) {
            Write-Host "  [dry-run] gh secret set $name -R $Repo  (value hidden, $($value.Length) chars)"
        } else {
            $value | gh secret set $name -R $Repo
            if ($LASTEXITCODE -ne 0) { throw "gh secret set $name failed" }
            Write-Host "  set $name" -ForegroundColor Green
        }
        $script:setCount++
    }
}

if ($Cloudflare) {
    Write-Host '── Cloudflare Worker secrets (gigsy-api) ──' -ForegroundColor Cyan
    Push-Location backend
    try {
        foreach ($name in $WorkerSecrets.Keys) {
            $value = Resolve-SecretValue $name $WorkerSecrets[$name]
            if ($null -eq $value) { continue }
            if ($DryRun) {
                Write-Host "  [dry-run] wrangler secret put $name  (value hidden, $($value.Length) chars)"
            } else {
                # wrangler reads the secret from stdin (trailing
                # newline is trimmed) — the value never hits argv.
                $value | pnpm exec wrangler secret put $name
                if ($LASTEXITCODE -ne 0) { throw "wrangler secret put $name failed" }
                Write-Host "  set $name" -ForegroundColor Green
            }
            $script:setCount++
        }
    } finally { Pop-Location }
}

Write-Host ''
Write-Host "Done. $script:setCount secret(s) $(if ($DryRun) { 'planned' } else { 'set' })." -ForegroundColor Cyan
if ($script:skipped.Count -gt 0) {
    Write-Host "Skipped placeholders: $($script:skipped -join ', ')" -ForegroundColor Yellow
}
if (-not $DryRun -and $Cloudflare -and $WorkerSecrets.AUTH_SECRET -ceq 'GENERATE') {
    Write-Host 'Note: generated keys are NOT saved anywhere. Re-running with GENERATE'
    Write-Host 'rotates them (existing JWTs / encrypted refresh tokens become invalid).'
}
