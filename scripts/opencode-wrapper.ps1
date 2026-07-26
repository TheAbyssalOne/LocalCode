#Requires -Version 7.0
# LocalCode PowerShell helpers. Dot-source from your profile:
#   . "$env:OPENCODE_LOCAL_SETUP_DIR\opencode-wrapper.ps1"

$script:LocalCodeSetupDir = if ($env:OPENCODE_LOCAL_SETUP_DIR) {
    $env:OPENCODE_LOCAL_SETUP_DIR
} else {
    Join-Path $HOME ".config\opencode\local-setup"
}

function Import-LocalCodeEnv {
    $envFile = Join-Path $script:LocalCodeSetupDir ".env.local"
    if (-not (Test-Path $envFile)) { return }

    foreach ($line in Get-Content $envFile) {
        $trimmed = $line.Trim() -replace '^export\s+', ''
        if ($trimmed -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $key = $Matches[1]
            $value = $Matches[2].Trim() -replace '^"(.*)"$', '$1' -replace "^'(.*)'$", '$1'
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Invoke-LocalCodeSync {
    $sync = Join-Path $script:LocalCodeSetupDir "sync-on-launch.mjs"
    if (Test-Path $sync) {
        & node $sync 2>$null | Out-Null
    }
}

function opencode {
    Import-LocalCodeEnv
    Invoke-LocalCodeSync
    & (Get-Command opencode.cmd, opencode.exe -ErrorAction SilentlyContinue | Select-Object -First 1) @args
}

function sync-models {
    param([string]$Url = "")
    Import-LocalCodeEnv
    if ($Url) { $env:LOCAL_API_BASE = $Url }
    & node (Join-Path $script:LocalCodeSetupDir "sync-on-launch.mjs")
}

function oc-doctor {
    Import-LocalCodeEnv
    & node (Join-Path $script:LocalCodeSetupDir "doctor.mjs")
}

function download-models {
    param(
        [Parameter(Position = 0)][string]$Provider = "ollama",
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$ModelIds
    )
    Import-LocalCodeEnv
    & node (Join-Path $script:LocalCodeSetupDir "download-models.mjs") $Provider @ModelIds
}

function localcode-setup {
    & node (Join-Path $script:LocalCodeSetupDir "setup.mjs") @args
}

function oc-vllm {
    Import-LocalCodeEnv
    $server = Join-Path $script:LocalCodeSetupDir "vllm-server.ps1"
    & $server status 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "vLLM is not running. Start it with: vllm-server.ps1 start <hf-repo>"
        return
    }
    $env:LOCAL_API_BASE = "http://127.0.0.1:8000/v1"
    $env:OPENCODE_PROVIDER_ID = "vllm"
    sync-models | Out-Null
    opencode @args
}

function oc-lmstudio {
    $env:LOCAL_API_BASE = "http://127.0.0.1:1234/v1"
    $env:OPENCODE_PROVIDER_ID = "lmstudio"
    sync-models | Out-Null
    opencode @args
}

function oc-ollama {
    $env:LOCAL_API_BASE = "http://127.0.0.1:11434/v1"
    $env:OPENCODE_PROVIDER_ID = "ollama"
    sync-models | Out-Null
    opencode @args
}

Write-Host "LocalCode commands: opencode, sync-models, oc-doctor, oc-vllm, oc-ollama, oc-lmstudio, download-models, localcode-setup" -ForegroundColor DarkGray
