#Requires -Version 7.0
# vLLM lifecycle on Windows. vLLM has no official Windows build, so this dispatches into
# WSL2 (preferred) or Docker Model Runner. Usage: vllm-server.ps1 start <repo> [args...]

param(
    [Parameter(Position = 0)][string]$Action = "status",
    [Parameter(Position = 1)][string]$Model = "",
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ExtraArgs = @()
)

$ErrorActionPreference = "Stop"
$port = if ($env:VLLM_PORT) { $env:VLLM_PORT } else { "8000" }
$setupDir = if ($env:OPENCODE_LOCAL_SETUP_DIR) { $env:OPENCODE_LOCAL_SETUP_DIR } else { Join-Path $HOME ".config\opencode\local-setup" }

function Test-Wsl {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return $false }
    $distros = (wsl.exe --list --quiet) -replace "`0", ""
    if ([string]::IsNullOrWhiteSpace($distros)) { return $false }

    # A listed distro is not a usable one: Docker's helper VMs appear here but have no
    # shell. vLLM needs a real Linux userspace, so prove bash runs.
    $probe = (wsl.exe -e bash -lc "echo localcode-ok" 2>$null) -replace "`0", ""
    return $probe -match "localcode-ok"
}

function Get-Endpoint {
    # Localhost forwarding normally works; fall back to the distro address when it does not.
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/models" -TimeoutSec 2 | Out-Null
        return "http://127.0.0.1:$port/v1"
    } catch {}

    if (Test-Wsl) {
        $ip = ((wsl.exe hostname -I) -replace "`0", "").Trim().Split(" ")[0]
        if ($ip) { return "http://${ip}:$port/v1" }
    }
    return "http://127.0.0.1:$port/v1"
}

function Invoke-InWsl {
    param([string]$Command)
    & wsl.exe -e bash -lc $Command
    return $LASTEXITCODE -eq 0
}

switch ($Action) {
    "start" {
        if (-not $Model) {
            Write-Error "Usage: vllm-server.ps1 start <hf-repo> [extra vllm args...]"
            exit 1
        }

        if (Test-Wsl) {
            $extra = ($ExtraArgs -join " ")
            $remote = "OPENCODE_LOCAL_SETUP_DIR=~/.local/share/localcode VLLM_VENV_DIR=~/.local/share/localcode/vllm-env bash ~/.local/share/localcode/vllm-server.sh start $Model $extra"
            if (Invoke-InWsl $remote) {
                Write-Host "✓ vLLM started in WSL2 - endpoint $(Get-Endpoint)"
            } else {
                Write-Error "Failed to start vLLM inside WSL2."
                exit 1
            }
        } else {
            Write-Error @"
No usable WSL2 distro found. vLLM has no native Windows build.

  Install one:  wsl --install -d Ubuntu
  Then re-run:  vllm-server.ps1 start $Model

Docker Model Runner also serves vLLM, but only for images published to Docker Hub with a
'-vllm' suffix on port 12434 - it cannot serve an arbitrary HuggingFace repository.
"@
            exit 1
        }
    }

    "stop" {
        if (Test-Wsl) {
            Invoke-InWsl "OPENCODE_LOCAL_SETUP_DIR=~/.local/share/localcode bash ~/.local/share/localcode/vllm-server.sh stop" | Out-Null
            Write-Host "✓ Stopped"
        } else {
            Write-Host "No usable WSL2 distro; nothing to stop."
        }
    }

    "restart" {
        & $PSCommandPath stop
        Start-Sleep -Seconds 1
        & $PSCommandPath start $Model @ExtraArgs
    }

    "status" {
        try {
            $response = Invoke-RestMethod -Uri "$(Get-Endpoint)/models" -TimeoutSec 3
            $ids = ($response.data | ForEach-Object { $_.id }) -join ", "
            Write-Host "vLLM is running at $(Get-Endpoint) - serving: $ids"
        } catch {
            Write-Host "vLLM is not running"
            exit 1
        }
    }

    default {
        Write-Error "Usage: vllm-server.ps1 {start <repo> [args...]|stop|restart <repo>|status}"
        exit 1
    }
}
