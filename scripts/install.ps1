#Requires -Version 7.0
# Thin shim. All setup logic lives in scripts/setup.mjs so every platform runs one code path.

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 20+ is required. Install it from https://nodejs.org/ and re-run."
    exit 1
}

$major = [int]((node --version) -replace 'v(\d+)\..*', '$1')
if ($major -lt 20) {
    Write-Error "Node.js 20+ is required; found $(node --version)."
    exit 1
}

& node (Join-Path $scriptDir "setup.mjs") @args
exit $LASTEXITCODE
