#Requires -Version 7.0
param(
    [switch]$SkipNodeCheck,
    [switch]$SkipOpenCode,
    [switch]$SkipLMStudio,
    [switch]$InstallVLLM,
    [switch]$SkipModels,
    [switch]$SkipSync,
    [switch]$SkipDoctor,
    [switch]$Launch,
    [string]$Provider = "lmstudio",
    [string[]]$Models = @(),
    [switch]$Help
)

if ($Help) {
    Write-Host @"
OpenCode Local Setup - Windows Installer

Usage:
  .\scripts\install.ps1                          # Full auto-setup with defaults
  .\scripts\install.ps1 -Provider ollama         # Use Ollama instead of LM Studio
  .\scripts\install.ps1 -InstallVLLM             # Also install vLLM (requires Python)
  .\scripts\install.ps1 -Models phi-3-mini llama-3.1-8b  # Specific models
  .\scripts\install.ps1 -SkipLMStudio -SkipModels  # Skip LM Studio and model download
  .\scripts\install.ps1 -Launch                  # Setup everything and launch OpenCode

Options:
  -Provider <string>       Primary provider: lmstudio (default), ollama, vllm
  -Models <string[]>       Model IDs to download (from models.json)
  -InstallVLLM             Also install vLLM as secondary provider
  -SkipNodeCheck           Skip Node.js installation check
  -SkipOpenCode            Skip OpenCode installation
  -SkipLMStudio            Skip LM Studio installation
  -SkipModels              Skip automatic model download
  -SkipSync                Skip post-download model sync
  -SkipDoctor              Skip configuration health check
  -Launch                  Launch OpenCode after setup completes
"@
    exit 0
}

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$configDir = Join-Path $env:USERPROFILE ".config\opencode"
$setupDir = Join-Path $configDir "local-setup"
$configFile = Join-Path $configDir "opencode.json"
$envFile = Join-Path $setupDir ".env.local"

Write-Host ""
Write-Host "OpenCode Local Setup - Windows" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan
Write-Host ""

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-WebRequestWithProgress {
    param([string]$Url, [string]$OutputFile, [string]$Label = "")

    if ($Label) { Write-Host "  Downloading: $Label" }

    try {
        $client = New-Object System.Net.WebClient
        $client.Headers.Add("User-Agent", "OpenCodeLocalSetup/1.0")
        $client.DownloadFile($Url, $OutputFile)
        return $true
    } catch {
        Write-Host "  Download failed: $_" -ForegroundColor Yellow
        return $false
    }
}

function Test-Command {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# Create directories
Write-Host "[1/8] Creating directories..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
Write-Host "  ✓ Config: $configDir"
Write-Host "  ✓ Setup:  $setupDir"

# Check Node.js
Write-Host ""
Write-Host "[2/8] Checking prerequisites..." -ForegroundColor Yellow

if (-not $SkipNodeCheck) {
    if (Test-Command node) {
        $nodeVersion = node --version
        $majorVersion = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
        if ($majorVersion -ge 18) {
            Write-Host "  ✓ Node.js: $nodeVersion"
        } else {
            Write-Host "  ✗ Node.js 18+ required (found $nodeVersion)" -ForegroundColor Red
            Write-Host "  Install from https://nodejs.org/" -ForegroundColor Yellow
            exit 1
        }
    } else {
        Write-Host "  ! Node.js not found" -ForegroundColor Yellow
        Write-Host "  Installing Node.js LTS..." -ForegroundColor Cyan

        $nodeInstaller = Join-Path $env:TEMP "nodejs-installer.msi"
        $nodeUrl = "https://nodejs.org/dist/v24.18.0/node-v24.18.0-x64.msi"

        if (Invoke-WebRequestWithProgress -Url $nodeUrl -OutputFile $nodeInstaller -Label "Node.js LTS") {
            Write-Host "  Running Node.js installer..." -ForegroundColor Cyan
            Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /qn /norestart" -Wait -NoNewWindow
            Remove-Item $nodeInstaller -Force -ErrorAction SilentlyContinue

            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (Test-Command node) {
                Write-Host "  ✓ Node.js installed: $(node --version)"
            } else {
                Write-Host "  ! Node.js installed but not in PATH. Restart your terminal." -ForegroundColor Yellow
            }
        } else {
            Write-Host "  ✗ Failed to install Node.js. Install manually from https://nodejs.org/" -ForegroundColor Red
            exit 1
        }
    }
}

# Check/install OpenCode
Write-Host ""
Write-Host "[3/8] Checking OpenCode..." -ForegroundColor Yellow

if (-not $SkipOpenCode) {
    if (Test-Command opencode) {
        try {
            $ocVersion = & opencode --version 2>$null
            Write-Host "  ✓ OpenCode: $ocVersion"
        } catch {
            Write-Host "  ✓ OpenCode is installed"
        }
    } else {
        Write-Host "  ! OpenCode not found. Installing..." -ForegroundColor Cyan

        try {
            $installerScript = Invoke-RestMethod -Uri "https://opencode.ai/install" -TimeoutSec 30
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  ✓ OpenCode installed via official installer"
            } else {
                throw "Installer failed"
            }
        } catch {
            Write-Host "  ! Could not auto-install OpenCode." -ForegroundColor Yellow
            Write-Host "  Install manually: iwr https://opencode.ai/install | iex" -ForegroundColor Yellow
        }
    }
}

# Check/install LM Studio
Write-Host ""
Write-Host "[4/8] Checking model servers..." -ForegroundColor Yellow

$lmStudioInstalled = $false
if (-not $SkipLMStudio) {
    $lmStudioPath = Join-Path $env:LOCALAPPDATA "Programs\LM Studio"
    if (Test-Path $lmStudioPath) {
        Write-Host "  ✓ LM Studio is installed"
        $lmStudioInstalled = $true
    } else {
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:1234/v1/models" -TimeoutSec 2
            if ($response.data) {
                Write-Host "  ✓ LM Studio is running (but not detected in Programs)"
                $lmStudioInstalled = $true
            }
        } catch {}

        if (-not $lmStudioInstalled) {
            Write-Host "  ! LM Studio not found. Installing..." -ForegroundColor Cyan

            $lmInstaller = Join-Path $env:TEMP "LMStudio-installer.exe"
            $lmUrl = "https://github.com/lmstudio-ai/LM-Studio/releases/latest/download/LMStudio-windows-setup.exe"

            if (Invoke-WebRequestWithProgress -Url $lmUrl -OutputFile $lmInstaller -Label "LM Studio") {
                Write-Host "  Running LM Studio installer..." -ForegroundColor Cyan
                Start-Process $lmInstaller -Wait -NoNewWindow
                Remove-Item $lmInstaller -Force -ErrorAction SilentlyContinue

                if (Test-Path $lmStudioPath) {
                    Write-Host "  ✓ LM Studio installed"
                    $lmStudioInstalled = $true
                } else {
                    Write-Host "  ! LM Studio installer completed. Verify installation." -ForegroundColor Yellow
                }
            } else {
                Write-Host "  ✗ Failed to download LM Studio." -ForegroundColor Red
                Write-Host "  Download from: https://lmstudio.ai/" -ForegroundColor Yellow
            }
        }
    }
}

# Optionally install vLLM
if ($InstallVLLM) {
    Write-Host ""
    Write-Host "  Installing vLLM (secondary provider)..." -ForegroundColor Cyan

    if (-not (Test-Command python)) {
        Write-Host "  ! Python not found. Install from https://www.python.org/downloads/" -ForegroundColor Yellow
        $InstallVLLM = $false
    } elseif (-not (Test-Command pip)) {
        Write-Host "  ! pip not found." -ForegroundColor Yellow
        $InstallVLLM = $false
    } else {
        try {
            Write-Host "  Creating vLLM virtual environment..." -ForegroundColor Cyan
            $venvDir = Join-Path $setupDir "vllm-env"
            & python -m venv $venvDir 2>$null

            $activateScript = Join-Path $venvDir "Scripts\Activate.ps1"
            if (Test-Path $activateScript) {
                Write-Host "  Installing vLLM..." -ForegroundColor Cyan
                & (Join-Path $venvDir "Scripts\pip.exe") install --upgrade pip 2>$null
                & (Join-Path $venvDir "Scripts\pip.exe") install vllm 2>$null
                Write-Host "  ✓ vLLM installed in virtual environment"
            } else {
                Write-Host "  ✗ Failed to create vLLM environment" -ForegroundColor Red
                $InstallVLLM = $false
            }
        } catch {
            Write-Host "  ✗ vLLM installation failed: $_" -ForegroundColor Red
            $InstallVLLM = $false
        }
    }
}

# Create/update .env.local
Write-Host ""
Write-Host "[5/8] Configuring environment..." -ForegroundColor Yellow

if (-not (Test-Path $envFile)) {
    $envContent = @"
# OpenCode Local Setup - Windows Environment
# Primary model server endpoint
LOCAL_API_BASE=http://127.0.0.1:1234/v1

# Provider identification
OPENCODE_PROVIDER_ID=lmstudio
OPENCODE_PROVIDER_NAME="LM Studio (local)"

# --- Local server authentication (optional) ---
# LOCAL_API_KEY=

# --- Cloud provider API keys (set as needed) ---
# OPENAI_API_KEY=sk-...
# FIREWORKS_API_KEY=fw_...
# DEEPSEEK_API_KEY=sk-...
# XAI_API_KEY=xai-...
# GROQ_API_KEY=gsk_...
# TOGETHER_API_KEY=...
# MISTRAL_API_KEY=...
# OPENROUTER_API_KEY=sk-or-...
# DASHSCOPE_API_KEY=sk-...
# ALIBABA_API_KEY=sk-...

# --- Remote OpenAI-compatible servers ---
# REMOTE_API_BASE=https://your-server.com/v1
# REMOTE_API_KEY=...

# --- vLLM secondary provider (if installed) ---
# VLLM_API_BASE=http://127.0.0.1:8000/v1

# --- Tailscale discovery (opt-in) ---
# OPENCODE_TAILSCALE_DISCOVERY=1
# OPENCODE_TAILSCALE_PORTS=1234,8000,8080,11434
"@
    Set-Content -Path $envFile -Value $envContent -Encoding UTF8
    # Restrict file permissions to current user only
    try {
        $acl = Get-Acl $envFile
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            "$env:USERPROFILE", "FullControl", "Allow"
        )
        $acl.AddAccessRule($rule)
        Set-Acl -Path $envFile -AclObject $acl
    } catch {
        Write-Host "  ! Could not set file permissions on $envFile" -ForegroundColor Yellow
    }
    Write-Host "  ✓ Created $envFile (restricted to current user)"
} else {
    Write-Host "  ✓ Preserved existing $envFile"
}

# Create opencode.json
Write-Host ""
Write-Host "[6/8] Generating configuration..." -ForegroundColor Yellow

$config = @{
    `$schema   = "https://opencode.ai/config.json"
    autoupdate = "notify"
    share      = "manual"
    provider   = @{
        lmstudio = @{
            npm    = "@ai-sdk/openai-compatible"
            name   = "LM Studio (local)"
            options = @{
                baseURL = "http://127.0.0.1:1234/v1"
            }
            models  = @{}
        }
    }
}

if ($InstallVLLM) {
    $config.provider["vllm"] = @{
        npm    = "@ai-sdk/openai-compatible"
        name   = "vLLM (local)"
        options = @{
            baseURL = "http://127.0.0.1:8000/v1"
        }
        models  = @{}
    }
}

if (-not (Test-Path $configFile)) {
    $config | ConvertTo-Json -Depth 5 | Set-Content -Path $configFile -Encoding UTF8
    Write-Host "  ✓ Created $configFile"
} else {
    Write-Host "  ✓ Preserved existing $configFile"
}

# Copy setup scripts
Write-Host ""
Write-Host "[7/8] Installing helper scripts..." -ForegroundColor Yellow

$scriptsToCopy = @("providers.mjs", "sync-core.mjs", "sync-provider.mjs", "sync-local-models.mjs", "sync-on-launch.mjs", "doctor.mjs", "setup-env.mjs", "download-models.mjs")
foreach ($script in $scriptsToCopy) {
    $source = Join-Path $scriptDir $script
    if (Test-Path $source) {
        Copy-Item -Path $source -Destination (Join-Path $setupDir $script) -Force
    }
}

$wrapperPs1 = @"
# OpenCode Local Setup - Windows Wrapper
# Add this to your PowerShell profile: ~\Documents\PowerShell\Microsoft.PowerShell_profile.ps1

`$envFile = "`"$setupDir\.env.local`""

function Import-LocalEnv {
    if (Test-Path `$envFile) {
        Get-Content `$envFile | Where-Object { ``$_ -and ``$_ -notmatch '^\s*#' } | ForEach-Object {
            `$line = ``$_.Trim() -replace '^export\s+', ''
            if (`$line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)') {
                `$key = `$Matches[1].Trim()
                `$value = `$Matches[2].Trim()
                `$value = `$value -replace '^"(.*)"$', `'$1' -replace "^'(.*)'$", `'$1'
                [System.Environment]::SetEnvironmentVariable(`$key, `$value, "Process")
            }
        }
    }
}

function opencode {
    param([Parameter(ValueFromRemainingArguments=`$true)][string[]]`$Args)
    Import-LocalEnv
    if (Test-Path "`"$setupDir\sync-on-launch.mjs`"") {
        node "`"$setupDir\sync-on-launch.mjs`"`" 2>$null | Out-Null
    }
    & cmd.exe /c "opencode" @Args
}

function sync-models {
    param([string]`$Url = "")
    Import-LocalEnv
    if (`$Url) {
        `$env:LOCAL_API_BASE = `$Url
    }
    node "`"$setupDir\sync-on-launch.mjs`""
}

function oc-lmstudio {
    param([Parameter(ValueFromRemainingArguments=`$true)][string[]]`$Args)
    `$env:LOCAL_API_BASE = "http://127.0.0.1:1234/v1"
    `$env:OPENCODE_PROVIDER_ID = "lmstudio"
    sync-models "http://127.0.0.1:1234/v1" 2>$null | Out-Null
    opencode @Args
}

function oc-vllm {
    param([Parameter(ValueFromRemainingArguments=`$true)][string[]]`$Args)
    `$env:LOCAL_API_BASE = "http://127.0.0.1:8000/v1"
    `$env:OPENCODE_PROVIDER_ID = "vllm"
    sync-models "http://127.0.0.1:8000/v1" 2>$null | Out-Null
    opencode @Args
}

function oc-doctor {
    Import-LocalEnv
    node "`"$setupDir\doctor.mjs`""
}

function download-models {
    param(
        [string]`$Provider = "lmstudio",
        [Parameter(ValueFromRemainingArguments=`$true)][string[]]`$ModelIds
    )
    Import-LocalEnv
    `$argsList = @(`$Provider)
    if (`$ModelIds) { `$argsList += `$ModelIds }
    node "`"$setupDir\download-models.mjs`"`" @argsList
}

Write-Host "OpenCode Local Setup commands loaded." -ForegroundColor DarkGray
Write-Host "  opencode       - Launch OpenCode with auto-sync" -ForegroundColor DarkGray
Write-Host "  oc-lmstudio    - Sync LM Studio and launch" -ForegroundColor DarkGray
Write-Host "  oc-vllm        - Sync vLLM and launch (if installed)" -ForegroundColor DarkGray
Write-Host "  sync-models    - Refresh model list from servers" -ForegroundColor DarkGray
Write-Host "  download-models <provider> [models...] - Download models" -ForegroundColor DarkGray
Write-Host "  oc-doctor      - Check configuration health" -ForegroundColor DarkGray
"@

$profileDir = Join-Path $env:USERPROFILE "Documents\PowerShell"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$profileFile = Join-Path $profileDir "Microsoft.PowerShell_profile.ps1"

$startMarker = "# >>> opencode-local-setup >>>"
$endMarker = "# <<< opencode-local-setup <<<"

if (Test-Path $profileFile) {
    $profileContent = Get-Content $profileFile -Raw
    if ($profileContent -match [regex]::Escape($startMarker)) {
        $profileContent = $profileContent -replace "(?s)$([regex]::Escape($startMarker)).*?$([regex]::Escape($endMarker))", ""
        $profileContent = $profileContent.TrimEnd() + "`n`n" + $startMarker + "`n" + $wrapperPs1 + "`n" + $endMarker + "`n"
        Set-Content -Path $profileFile -Value $profileContent -Encoding UTF8 -NoNewline
    } else {
        Add-Content -Path $profileFile -Value "`n$startMarker`n$wrapperPs1`n$endMarker`n"
    }
} else {
    Set-Content -Path $profileFile -Value "$startMarker`n$wrapperPs1`n$endMarker`n" -Encoding UTF8
}
Write-Host "  ✓ Updated PowerShell profile: $profileFile"

# Download models
if (-not $SkipModels) {
    Write-Host ""
    Write-Host "[8/8] Downloading models..." -ForegroundColor Yellow

    if ($Models.Count -gt 0) {
        node (Join-Path $setupDir "download-models.mjs") $Provider @Models
    } else {
        node (Join-Path $setupDir "download-models.mjs") $Provider
    }
} else {
    Write-Host ""
    Write-Host "[8/8] Skipping model download (-SkipModels)" -ForegroundColor Yellow
}

# Run sync and doctor
if (-not $SkipSync) {
    Write-Host ""
    Write-Host "Running initial sync..." -ForegroundColor Yellow
    try {
        if (Test-Path $envFile) {
            Get-Content $envFile | Where-Object { $_ -and $_ -notmatch '^\s*#' } | ForEach-Object {
                # Strip leading "export " prefix, handle quoted values
                $line = $_.Trim() -replace '^export\s+', ''
                if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)') {
                    $key = $Matches[1].Trim()
                    $value = $Matches[2].Trim()
                    # Remove surrounding quotes (single or double)
                    $value = $value -replace '^"(.*)"$', '$1' -replace "^'(.*)'$", '$1'
                    [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
                }
            }
        }
        `$env:OPENCODE_CONFIG = $configFile
        node (Join-Path $setupDir "sync-on-launch.mjs") 2>$null | Out-Null
    } catch {}

    if (-not $SkipDoctor) {
        try {
            node (Join-Path $setupDir "doctor.mjs")
        } catch {}
    } else {
        Write-Host ""
        Write-Host "Skipping doctor check (-SkipDoctor)" -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "Skipping sync and doctor (-SkipSync)" -ForegroundColor Yellow
}

# Launch OpenCode if requested
if ($Launch) {
    Write-Host ""
    Write-Host "Launching OpenCode..." -ForegroundColor Cyan
    try {
        Start-Process opencode -NoNewWindow
    } catch {
        Write-Host "! Failed to launch OpenCode. Run 'opencode' manually." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
if ($Launch) {
    Write-Host "OpenCode is launching..." -ForegroundColor White
} else {
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Restart PowerShell or run: . `"$profileFile`"" -ForegroundColor White
    Write-Host "  2. Start LM Studio and load a model" -ForegroundColor White
    Write-Host "  3. Run: oc-lmstudio" -ForegroundColor White
}
Write-Host ""
Write-Host "To download more models:" -ForegroundColor Yellow
Write-Host "  download-models lmstudio phi-3-mini llama-3.1-8b" -ForegroundColor White
Write-Host ""
Write-Host "Configuration files:" -ForegroundColor Yellow
Write-Host "  Config:   $configFile" -ForegroundColor Gray
Write-Host "  Env:      $envFile" -ForegroundColor Gray
Write-Host "  Profile:  $profileFile" -ForegroundColor Gray
