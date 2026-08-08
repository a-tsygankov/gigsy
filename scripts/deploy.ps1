#!/usr/bin/env pwsh
# Workstation deploy helper (PowerShell). CI handles main-branch
# deploys; this is for one-offs.
#
# Usage:
#   ./scripts/deploy.ps1 -Backend
#   ./scripts/deploy.ps1 -Webapp
#   ./scripts/deploy.ps1 -All
[CmdletBinding()]
param(
    [switch]$Backend,
    [switch]$Webapp,
    [switch]$All
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if ($All) { $Backend = $true; $Webapp = $true }
if (-not ($Backend -or $Webapp)) {
    Write-Error 'Pick at least one: -Backend, -Webapp, or -All'
}

if ($Backend) {
    Write-Host '── backend ──' -ForegroundColor Cyan
    pnpm --filter gigsy-backend db:migrate:remote
    pnpm --filter gigsy-backend deploy
}
if ($Webapp) {
    Write-Host '── webapp ──' -ForegroundColor Cyan
    pnpm --filter gigsy-webapp build
    pnpm --filter gigsy-webapp deploy
}
