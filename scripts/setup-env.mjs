#!/usr/bin/env node
/**
 * setup-env.mjs - Cross-platform environment setup for OpenCode Local
 *
 * Detects OS (Unix distro or Windows), installs missing dependencies,
 * and prepares the system for running local LLM models with OpenCode.
 *
 * Usage:
 *   node setup-env.mjs                  # Full auto-setup
 *   node setup-env.mjs --install-all    # Install everything including servers
 *   node setup-env.mjs --server ollama  # Install Ollama server
 *   node setup-env.mjs --server lmstudio # Install LM Studio server
 *   node setup-env.mjs --check-only     # Only check, don't install
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch, release, totalmem } from 'os';
import { createInterface } from 'readline';

// ─── Platform Detection ─────────────────────────────────────────────

const isWindows = platform() === 'win32';
const isMac = platform() === 'darwin';
let linuxDistro = null;

function detectLinuxDistro() {
  if (!isWindows && !isMac) {
    try {
      const osRelease = readFileSync('/etc/os-release', 'utf8');
      const idMatch = osRelease.match(/^ID=(.*)$/m);
      return idMatch ? idMatch[1].replace(/"/g, '') : 'unknown';
    } catch {
      // Try lsb_release
      try {
        return execSync('lsb_release -si', { encoding: 'utf8' }).trim().toLowerCase();
      } catch {
        return 'unknown';
      }
    }
  }
  return null;
}

linuxDistro = detectLinuxDistro();

const osInfo = {
  platform: isWindows ? 'windows' : isMac ? 'macos' : linuxDistro || 'linux',
  arch: arch(),
  nodeVersion: process.version,
  totalRamGb: Math.round(totalmem() / (1024 ** 3)),
};

// ─── CLI Helpers ──────────────────────────────────────────────────────

const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function log(msg, color = 'reset') {
  process.stdout.write(`${colors[color]}${msg}${colors.reset}\n`);
}

function checkmark(msg) { log(`  ✓ ${msg}`, 'green'); }
function warning(msg) { log(`  ! ${msg}`, 'yellow'); }
function error(msg) { log(`  ✗ ${msg}`, 'red'); }
function info(msg) { log(`  ${msg}`); }

// ─── Command Execution ────────────────────────────────────────────────

function runCommand(command, args = [], options = {}) {
  const { sudo = false, silent = false, shell = isWindows ? 'cmd.exe' : '/bin/bash' } = options;
  
  let fullCmd = command;
  let fullArgs = [...args];
  
  if (sudo && !isWindows) {
    fullCmd = 'sudo';
    fullArgs = [command, ...args];
  }
  
  if (!silent) {
    info(`  $ ${fullCmd} ${fullArgs.join(' ')}`);
  }
  
  try {
    const output = execSync(`${fullCmd} ${fullArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`, {
      shell,
      encoding: 'utf8',
      stdio: silent ? 'pipe' : 'inherit',
      timeout: 300000, // 5 min timeout
    });
    return { success: true, output };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function runCommandAsync(command, args = [], options = {}) {
  const { shell = isWindows ? 'cmd.exe' : '/bin/bash', detached = false } = options;
  
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell,
      stdio: 'inherit',
      detached,
    });
    
    child.on('close', (code) => resolve({ success: code === 0, code }));
    child.on('error', () => resolve({ success: false }));
  });
}

// ─── Version Checking ─────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(`where ${cmd}`, { shell: 'cmd.exe', encoding: 'utf8' });
    return true;
  } catch {
    try {
      execSync(`which ${cmd}`, { shell: '/bin/bash', encoding: 'utf8' });
      return true;
    } catch {
      return false;
    }
  }
}

function getNodeVersion() {
  if (!commandExists('node')) return null;
  try {
    const ver = execSync('node --version', { encoding: 'utf8' }).trim();
    return { version: ver, major: parseInt(ver.replace('v', '').split('.')[0]) };
  } catch {
    return null;
  }
}

function getPythonVersion() {
  const cmd = isWindows ? 'python' : 'python3';
  if (!commandExists(cmd)) return null;
  try {
    const ver = execSync(`${cmd} --version`, { encoding: 'utf8' }).trim();
    return { version: ver, command: cmd };
  } catch {
    // Try python on Linux as fallback
    if (!isWindows) {
      try {
        const ver = execSync('python --version', { encoding: 'utf8' }).trim();
        return { version: ver, command: 'python' };
      } catch {}
    }
    return null;
  }
}

// ─── Download Helper ──────────────────────────────────────────────────

async function downloadFile(url, outputPath) {
  const https = await import('https');
  const http = await import('http');
  const { mkdirSync: mkd, writeFileSync: wf } = await import('fs');
  
  return new Promise((resolve, reject) => {
    info(`  Downloading from ${url}`);
    
    // Create output directory if needed
    mkdSync(dirname(outputPath), { recursive: true });
    
    const client = url.startsWith('https') ? https : http;
    const file = await (await import('fs')).createWriteStream(outputPath);
    
    client.get(url, {
      headers: { 'User-Agent': 'OpenCodeLocalSetup/1.0' },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Follow redirect
        client.get(response.headers.location, (redirectResponse) => {
          redirectResponse.pipe(file);
          let downloaded = 0;
          const total = parseInt(redirectResponse.headers['content-length'] || '0', 10);
          
          redirectResponse.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total) {
              const pct = Math.round((downloaded / total) * 100);
              process.stdout.write(`\r  Download: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`);
            }
          });
          
          file.on('finish', () => {
            file.close();
            process.stdout.write('\r\n');
            resolve(true);
          });
        }).on('error', reject);
      } else {
        response.pipe(file);
        let downloaded = 0;
        const total = parseInt(response.headers['content-length'] || '0', 10);
        
        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total) {
            const pct = Math.round((downloaded / total) * 100);
            process.stdout.write(`\r  Download: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`);
          }
        });
        
        file.on('finish', () => {
          file.close();
          process.stdout.write('\r\n');
          resolve(true);
        });
      }
    }).on('error', reject);
  });
}

// ─── Node.js Installer ────────────────────────────────────────────────

async function installNodeJS() {
  log('', 'cyan');
  log('[1/7] Checking Node.js...', 'yellow');
  
  const nodeInfo = getNodeVersion();
  
  if (nodeInfo && nodeInfo.major >= 18) {
    checkmark(`Node.js ${nodeInfo.version} is installed`);
    return true;
  }
  
  warning(`Node.js 18+ required. Found: ${nodeInfo ? nodeInfo.version : 'not installed'}`);
  info('  Installing Node.js LTS...');
  
  if (isWindows) {
    const installerPath = join(require('os').tmpdir(), 'nodejs-installer.msi');
    // Get latest LTS version from API
    let nodeUrl = 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi';
    
    try {
      const https = await import('https');
      const latestInfo = await new Promise((resolve, reject) => {
        https.get('https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt', (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      
      // Parse latest version from SHASUMS
      const match = latestInfo.match(/node-v20\.(\d+\.\d+)-win-x64/);
      if (match) {
        nodeUrl = `https://nodejs.org/dist/v20.${match[1]}/node-v20.${match[1]}-x64.msi`;
      }
    } catch {}
    
    const success = await downloadFile(nodeUrl, installerPath);
    
    if (success) {
      info('  Running Node.js installer...');
      const result = await runCommandAsync('msiexec.exe', ['/i', `"${installerPath}"`, '/qn', '/norestart']);
      
      // Clean up
      try { require('fs').unlinkSync(installerPath); } catch {}
      
      // Refresh PATH
      process.env.Path = 
        (process.env.ProgramFiles || 'C:\\Program Files') + '\\nodejs;' + 
        (process.env.ProgramFilesX86 || 'C:\\Program Files (x86)') + '\\nodejs;' + 
        process.env.Path;
      
      if (commandExists('node')) {
        checkmark(`Node.js installed: ${getNodeVersion().version}`);
        return true;
      } else {
        warning('Node.js installed but not in PATH. Restart your terminal.');
        return false;
      }
    } else {
      error('Failed to download Node.js');
      info('  Install manually from https://nodejs.org/');
      return false;
    }
  } else if (isMac) {
    if (commandExists('brew')) {
      const result = runCommand('brew', ['install', 'node@20']);
      if (result.success) {
        checkmark(`Node.js installed via Homebrew`);
        return true;
      }
    } else {
      warning('Homebrew not found. Installing...');
      const brewResult = runCommand('/bin/bash', [
        '-c',
        '(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash)'
      ]);
      
      if (brewResult.success) {
        // Add Homebrew to PATH
        process.env.Path = '/opt/homebrew/bin:/usr/local/bin:' + process.env.Path;
        const nodeResult = runCommand('brew', ['install', 'node@20']);
        if (nodeResult.success) {
          checkmark(`Node.js installed via Homebrew`);
          return true;
        }
      }
    }
  } else {
    // Linux - distro-specific installation
    const sudoCmd = commandExists('sudo') ? 'sudo' : null;
    
    if (['ubuntu', 'debian', 'linuxmint', 'pop', 'elementary'].includes(linuxDistro)) {
      info('  Installing via NodeSource APT repository...');
      runCommand(sudoCmd || 'bash', [
        '-c',
        `curl -fsSL https://deb.nodesource.com/setup_20.x | ${sudoCmd || ''} bash - && ${sudoCmd || ''} apt-get install -y nodejs`
      ], { sudo: !sudoCmd });
    } else if (['fedora', 'rhel', 'centos', 'rocky', 'almalinux'].includes(linuxDistro)) {
      info('  Installing via NodeSource YUM repository...');
      runCommand(sudoCmd || 'bash', [
        '-c',
        `curl -fsSL https://rpm.nodesource.com/setup_20.x | ${sudoCmd || ''} bash - && ${sudoCmd || ''} dnf install -y nodejs`
      ], { sudo: !sudoCmd });
    } else if (['arch', 'manjaro', 'endeavouros'].includes(linuxDistro)) {
      info('  Installing via pacman...');
      runCommand(sudoCmd || 'pacman', ['-S', '--noconfirm', 'nodejs'], { sudo: !sudoCmd });
    } else if (linuxDistro && linuxDistro.startsWith('opensuse')) {
      info('  Installing via zypper...');
      runCommand(sudoCmd || 'zypper', ['install', '-y', 'nodejs20'], { sudo: !sudoCmd });
    } else {
      warning(`Unsupported distro: ${linuxDistro}`);
      info('  Install Node.js 18+ from https://nodejs.org/');
      return false;
    }
    
    if (commandExists('node')) {
      checkmark(`Node.js installed`);
      return true;
    }
  }
  
  error('Failed to install Node.js');
  return false;
}

// ─── Git Installer ────────────────────────────────────────────────────

async function installGit() {
  log('', 'cyan');
  log('[2/7] Checking Git...', 'yellow');
  
  if (commandExists('git')) {
    try {
      const ver = execSync('git --version', { encoding: 'utf8' }).trim();
      checkmark(`Git ${ver}`);
      return true;
    } catch {}
  }
  
  warning('Git not found. Installing...');
  
  if (isWindows) {
    const installerPath = join(require('os').tmpdir(), 'git-installer.exe');
    const gitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.49.0.windows.1/Git-2.49.0-64-bit.exe';
    
    const success = await downloadFile(gitUrl, installerPath);
    
    if (success) {
      info('  Running Git installer...');
      await runCommandAsync(installerPath, ['/VERYSILENT', '/NORESTART']);
      
      try { require('fs').unlinkSync(installerPath); } catch {}
      
      // Refresh PATH
      process.env.Path = 'C:\\Program Files\\Git\\cmd;' + process.env.Path;
      
      if (commandExists('git')) {
        checkmark(`Git installed`);
        return true;
      } else {
        warning('Git installed but not in PATH. Restart your terminal.');
        return false;
      }
    }
  } else if (isMac) {
    if (commandExists('brew')) {
      const result = runCommand('brew', ['install', 'git']);
      if (result.success) {
        checkmark(`Git installed via Homebrew`);
        return true;
      }
    } else {
      info('  Trying Xcode command line tools...');
      runCommand('xcode-select', ['--install']);
    }
  } else {
    if (['ubuntu', 'debian', 'linuxmint'].includes(linuxDistro)) {
      runCommand('sudo', ['apt-get', 'install', '-y', 'git']);
    } else if (['fedora', 'rhel', 'centos', 'rocky'].includes(linuxDistro)) {
      runCommand('sudo', ['dnf', 'install', '-y', 'git']);
    } else if (['arch', 'manjaro'].includes(linuxDistro)) {
      runCommand('sudo', ['pacman', '-S', '--noconfirm', 'git']);
    } else if (linuxDistro && linuxDistro.startsWith('opensuse')) {
      runCommand('sudo', ['zypper', 'install', '-y', 'git']);
    }
    
    if (commandExists('git')) {
      checkmark(`Git installed`);
      return true;
    }
  }
  
  error('Failed to install Git');
  return false;
}

// ─── Python Installer ─────────────────────────────────────────────────

async function installPython() {
  log('', 'cyan');
  log('[3/7] Checking Python...', 'yellow');
  
  const pyInfo = getPythonVersion();
  
  if (pyInfo) {
    checkmark(`Python ${pyInfo.version} (${pyInfo.command})`);
    
    // Check pip
    if (!commandExists('pip') && !commandExists('pip3')) {
      warning('pip not found. Installing...');
      const result = runCommand(pyInfo.command, ['-m', 'ensurepip', '--upgrade']);
      if (result.success) {
        checkmark('pip installed');
      }
    } else {
      checkmark('pip is available');
    }
    
    return true;
  }
  
  warning('Python not found. Installing...');
  
  if (isWindows) {
    const installerPath = join(require('os').tmpdir(), 'python-installer.exe');
    // Get latest Python 3.12 from python.org
    let pyUrl = 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe';
    
    const success = await downloadFile(pyUrl, installerPath);
    
    if (success) {
      info('  Running Python installer...');
      // /quiet for silent, PrependPath=1 to add to PATH
      await runCommandAsync(installerPath, ['/quiet', 'InstallAllUsers=0', 'PrependPath=1']);
      
      try { require('fs').unlinkSync(installerPath); } catch {}
      
      process.env.Path = 'C:\\Python312;C:\\Python312\\Scripts;' + process.env.Path;
      
      if (commandExists('python')) {
        checkmark(`Python installed`);
        return true;
      } else {
        warning('Python installed but not in PATH. Restart your terminal.');
        return false;
      }
    }
  } else if (isMac) {
    if (commandExists('brew')) {
      const result = runCommand('brew', ['install', 'python@3.12']);
      if (result.success) {
        checkmark(`Python installed via Homebrew`);
        return true;
      }
    }
  } else {
    if (['ubuntu', 'debian', 'linuxmint'].includes(linuxDistro)) {
      runCommand('sudo', ['apt-get', 'install', '-y', 'python3', 'python3-pip']);
    } else if (['fedora', 'rhel', 'centos', 'rocky'].includes(linuxDistro)) {
      runCommand('sudo', ['dnf', 'install', '-y', 'python3', 'python3-pip']);
    } else if (['arch', 'manjaro'].includes(linuxDistro)) {
      runCommand('sudo', ['pacman', '-S', '--noconfirm', 'python', 'pip']);
    } else if (linuxDistro && linuxDistro.startsWith('opensuse')) {
      runCommand('sudo', ['zypper', 'install', '-y', 'python3', 'python3-pip']);
    }
    
    if (commandExists('python3') || commandExists('python')) {
      checkmark(`Python installed`);
      return true;
    }
  }
  
  error('Failed to install Python');
  return false;
}

// ─── OpenCode CLI Installer ───────────────────────────────────────────

async function installOpenCode() {
  log('', 'cyan');
  log('[4/7] Checking OpenCode...', 'yellow');
  
  if (commandExists('opencode')) {
    try {
      const ver = execSync('opencode --version', { encoding: 'utf8' }).trim();
      checkmark(`OpenCode ${ver}`);
      return true;
    } catch {
      checkmark('OpenCode is installed');
      return true;
    }
  }
  
  warning('OpenCode not found. Installing...');
  
  if (isWindows) {
    // Try npm global install first
    info('  Attempting npm global install...');
    const result = runCommand('npm', ['install', '-g', 'opencode']);
    
    if (result.success && commandExists('opencode')) {
      checkmark(`OpenCode installed via npm`);
      return true;
    }
    
    // Fallback: Try official installer
    info('  Trying official installer...');
    const result2 = runCommand('iwr', [
      'https://opencode.ai/install', 
      '-UseBasicParsing'
    ], { shell: 'powershell.exe' });
    
    if (result2.success) {
      checkmark(`OpenCode installed`);
      return true;
    }
  } else {
    // Unix: Use official installer script
    info('  Installing via official script...');
    const result = runCommand('/bin/bash', [
      '-c',
      'curl -fsSL https://opencode.ai/install | bash'
    ]);
    
    if (result.success && commandExists('opencode')) {
      checkmark(`OpenCode installed`);
      return true;
    }
    
    // Fallback: npm global
    info('  Attempting npm fallback...');
    const result2 = runCommand('npm', ['install', '-g', 'opencode']);
    
    if (result2.success) {
      checkmark(`OpenCode installed via npm`);
      return true;
    }
  }
  
  error('Failed to install OpenCode');
  info('  Install manually: curl -fsSL https://opencode.ai/install | bash');
  return false;
}

// ─── LM Studio Installer (Windows) ────────────────────────────────────

async function installLMStudio() {
  log('', 'cyan');
  log('[5/7] Checking LM Studio...', 'yellow');
  
  // Check if already running
  try {
    const http = await import('http');
    await new Promise((resolve, reject) => {
      const req = http.get('http://127.0.0.1:1234/v1/models', (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.setTimeout(2000);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });
    
    checkmark('LM Studio is running');
    return true;
  } catch {}
  
  // Check if installed on Windows
  if (isWindows) {
    const lmPath = join(process.env.LOCALAPPDATA || '', 'Programs\\LM Studio');
    if (existsSync(lmPath)) {
      checkmark('LM Studio is installed');
      return true;
    }
    
    warning('LM Studio not found. Installing...');
    
    const installerPath = join(require('os').tmpdir(), 'LMStudio-installer.exe');
    // Get latest release from GitHub API
    let lmUrl = 'https://github.com/lmstudio-ai/LM-Studio/releases/latest/download/LMStudio-windows-setup.exe';
    
    try {
      const https = await import('https');
      const releases = JSON.parse(await new Promise((resolve, reject) => {
        https.get('https://api.github.com/repos/lmstudio-ai/LM-Studio/releases/latest', {
          headers: { 'User-Agent': 'OpenCodeLocalSetup' },
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      }));
      
      const asset = releases.assets?.find(a => 
        a.name.includes('windows-setup') || a.name.includes('LMStudio-windows')
      );
      if (asset) {
        lmUrl = asset.browser_download_url;
      }
    } catch {}
    
    const success = await downloadFile(lmUrl, installerPath);
    
    if (success) {
      info('  Running LM Studio installer...');
      await runCommandAsync(installerPath, []);
      
      try { require('fs').unlinkSync(installerPath); } catch {}
      
      checkmark(`LM Studio installed`);
      return true;
    } else {
      error('Failed to download LM Studio');
      info('  Download from: https://lmstudio.ai/');
      return false;
    }
  } else if (isMac) {
    // Check for LM Studio.app in Applications
    const lmApp = '/Applications/LM Studio.app';
    if (existsSync(lmApp)) {
      checkmark('LM Studio is installed');
      return true;
    }
    
    warning('LM Studio not found. Download from https://lmstudio.ai/');
    info('  On macOS, download the .dmg and drag to Applications.');
    return false;
  } else {
    // Linux - check for lms CLI or running server
    if (commandExists('lms')) {
      checkmark('LM Studio CLI found');
      return true;
    }
    
    warning('LM Studio not found. Download from https://lmstudio.ai/');
    info('  On Linux, download the AppImage or .deb package.');
    return false;
  }
}

// ─── Ollama Installer ─────────────────────────────────────────────────

async function installOllama() {
  log('', 'cyan');
  log('[5/7] Checking Ollama...', 'yellow');
  
  if (commandExists('ollama')) {
    checkmark(`Ollama is installed`);
    
    // Try to start the service
    try {
      const http = await import('http');
      await new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:11434/api/tags', (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data));
        });
        req.setTimeout(2000);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
      });
      checkmark('Ollama server is running');
    } catch {
      info('  Starting Ollama service...');
      if (isWindows) {
        runCommandAsync('ollama', ['serve'], { detached: true });
      } else {
        // Try systemd user service first, then background process
        const svcResult = runCommand('systemctl', ['--user', 'start', 'ollama']);
        if (!svcResult.success) {
          runCommandAsync('ollama', ['serve'], { detached: true });
        }
      }
    }
    
    return true;
  }
  
  warning('Ollama not found. Installing...');
  
  if (isWindows) {
    const installerPath = join(require('os').tmpdir(), 'ollama-installer.exe');
    // Get latest from GitHub releases
    let ollamaUrl = 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip';
    
    try {
      const https = await import('https');
      const releases = JSON.parse(await new Promise((resolve, reject) => {
        https.get('https://api.github.com/repos/ollama/ollama/releases/latest', {
          headers: { 'User-Agent': 'OpenCodeLocalSetup' },
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      }));
      
      const asset = releases.assets?.find(a => 
        a.name.includes('windows-amd64') && a.name.endsWith('.zip')
      );
      if (asset) {
        ollamaUrl = asset.browser_download_url;
      }
    } catch {}
    
    const success = await downloadFile(ollamaUrl, installerPath);
    
    if (success) {
      info('  Extracting Ollama...');
      const zipDir = join(require('os').tmpdir(), 'ollama-extract');
      mkdirSync(zipDir, { recursive: true });
      
      // Use PowerShell Expand-Archive
      runCommand('powershell.exe', [
        '-Command',
        `Expand-Archive -Path "${installerPath}" -DestinationPath "${zipDir}" -Force`
      ]);
      
      // Copy to Program Files
      const destDir = 'C:\\Program Files\\Ollama';
      mkdirSync(destDir, { recursive: true });
      
      // Find and copy ollama.exe
      const exePath = join(zipDir, 'ollama-windows-amd64', 'ollama.exe');
      if (existsSync(exePath)) {
        require('fs').copyFileSync(exePath, join(destDir, 'ollama.exe'));
        process.env.Path = destDir + ';' + process.env.Path;
        
        // Install as Windows service
        runCommand(join(destDir, 'ollama.exe'), ['serve'], { detached: true });
        
        checkmark(`Ollama installed`);
      } else {
        error('Failed to extract Ollama');
        return false;
      }
      
      try { require('fs').unlinkSync(installerPath); } catch {}
    } else {
      error('Failed to download Ollama');
      info('  Download from: https://ollama.com/');
      return false;
    }
  } else if (isMac) {
    // On macOS, prefer Homebrew
    if (commandExists('brew')) {
      const result = runCommand('brew', ['install', 'ollama']);
      if (result.success) {
        checkmark(`Ollama installed via Homebrew`);
        runCommand('brew', ['services', 'start', 'ollama']);
        return true;
      }
    }
    
    // Fallback: official script
    info('  Installing via official script...');
    const result = runCommand('/bin/bash', [
      '-c',
      'curl -fsSL https://ollama.com/install.sh | sh'
    ]);
    
    if (result.success) {
      checkmark(`Ollama installed`);
      return true;
    }
  } else {
    // Linux: official install script
    info('  Installing via official script...');
    const result = runCommand('/bin/bash', [
      '-c',
      'curl -fsSL https://ollama.com/install.sh | sh'
    ]);
    
    if (result.success) {
      checkmark(`Ollama installed`);
      
      // Start service
      try {
        runCommand('sudo', ['systemctl', 'enable', 'ollama']);
        runCommand('sudo', ['systemctl', 'start', 'ollama']);
      } catch {}
      
      return true;
    }
  }
  
  error('Failed to install Ollama');
  info('  Install from: https://ollama.com/');
  return false;
}

// ─── Server Selection & Installation ──────────────────────────────────

async function installServer(serverType) {
  if (serverType === 'lmstudio') {
    return await installLMStudio();
  } else if (serverType === 'ollama') {
    return await installOllama();
  } else {
    // Auto-detect and offer both
    const hasLmStudio = isWindows ? 
      existsSync(join(process.env.LOCALAPPDATA || '', 'Programs\\LM Studio')) :
      (existsSync('/Applications/LM Studio.app') || commandExists('lms'));
    
    const hasOllama = commandExists('ollama');
    
    if (hasLmStudio && !hasOllama) {
      return await installLMStudio();
    } else if (hasOllama && !hasLmStudio) {
      return await installOllama();
    } else if (!hasLmStudio && !hasOllama) {
      // Neither installed - prefer Ollama for automation, LM Studio for Windows GUI
      if (isWindows) {
        info('  No model server found. Installing LM Studio (recommended for Windows)...');
        return await installLMStudio();
      } else {
        info('  No model server found. Installing Ollama...');
        return await installOllama();
      }
    }
    
    // Both available - check which is running
    try {
      const http = await import('http');
      await new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:1234/v1/models', (res) => resolve(res));
        req.setTimeout(1000);
        req.on('timeout', () => { req.destroy(); reject(new Error()); });
        req.on('error', reject);
      });
      checkmark('LM Studio is running');
      return true;
    } catch {}
    
    try {
      const http = await import('http');
      await new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:11434/api/tags', (res) => resolve(res));
        req.setTimeout(1000);
        req.on('timeout', () => { req.destroy(); reject(new Error()); });
        req.on('error', reject);
      });
      checkmark('Ollama is running');
      return true;
    } catch {}
    
    warning('No model server is running. Start one manually or re-run with --server <name>');
    return false;
  }
}

// ─── Exported API for other scripts ────────────────────────────────────

export function detectOS() {
  return { ...osInfo };
}

export async function getSystemRAM() {
  return osInfo.totalRamGb;
}

export function checkNodeJS() {
  const info = getNodeVersion();
  return { available: !!info, version: info?.version || null, meetsRequirement: info?.major >= 18 };
}

export function checkOpenCode() {
  return commandExists('opencode');
}

export async function checkOllama() {
  if (!commandExists('ollama')) return { available: false, running: false };
  try {
    const { default: https } = await import('https');
    const ok = await new Promise((resolve) => {
      const req = https.get('http://127.0.0.1:11434/api/tags', (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.setTimeout(2000);
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
    return { available: true, running: ok };
  } catch {
    return { available: true, running: false };
  }
}

export async function checkLMStudio() {
  if (!commandExists('lmstudio') && !isWindows) {
    // On Unix, check for common install paths
    const lmPaths = ['/Applications/LM Studio.app', '/usr/local/bin/lmstudio'];
    for (const p of lmPaths) {
      if (existsSync(p)) return { available: true, running: false };
    }
    return { available: false, running: false };
  }
  try {
    const { default: https } = await import('https');
    const ok = await new Promise((resolve) => {
      const req = https.get('http://127.0.0.1:1234/v1/models', (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.setTimeout(2000);
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
    return { available: true, running: ok };
  } catch {
    return { available: false, running: false };
  }
}

export async function checkVLLM() {
  if (!commandExists('vllm')) return { available: false, running: false };
  try {
    const { default: https } = await import('https');
    const ok = await new Promise((resolve) => {
      const req = https.get('http://127.0.0.1:8000/v1/models', (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.setTimeout(2000);
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
    return { available: true, running: ok };
  } catch {
    return { available: false, running: false };
  }
}

export function getModelsCatalog(catalogPath) {
  // Try provided path first, then relative to script location, then cwd
  let paths = [];
  if (catalogPath) paths.push(resolve(catalogPath));
  
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    paths.push(join(scriptDir, '..', 'models.json'));
  } catch {}
  
  // Fallback locations
  paths.push(join(process.cwd(), 'LocalCode', 'models.json'));
  paths.push(join(process.cwd(), 'models.json'));
  
  for (const p of paths) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {}
  }
  return { models: [], default_models: [], recommended_by_ram: {} };
}

export function getModelById(catalog, modelId) {
  return (catalog.models || []).find((m) => m.id === modelId);
}

export async function recommendModels(ramGB) {
  const catalog = getModelsCatalog();
  if (!catalog.recommended_by_ram) {
    // Fallback: filter by ram_gb requirement
    return (catalog.models || [])
      .filter((m) => m.ram_gb <= ramGB)
      .map((m) => m.id);
  }
  const tiers = Object.entries(catalog.recommended_by_ram).sort((a, b) => a[0] - b[0]);
  let best = null;
  for (const [tierRam, models] of tiers) {
    if (ramGB >= parseInt(tierRam)) best = models;
  }
  return best || catalog.default_models || [];
}

export { runCommand };

// ─── Main Setup Flow ──────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    installAll: false,
    server: null,
    checkOnly: false,
    skipPython: false,
    help: false,
  };
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--install-all': options.installAll = true; break;
      case '--server': options.server = args[++i]; break;
      case '--check-only': options.checkOnly = true; break;
      case '--skip-python': options.skipPython = true; break;
      case '-h': case '--help': options.help = true; break;
    }
  }
  
  return options;
}

function showHelp() {
  console.log(`
OpenCode Local Environment Setup - Cross-Platform

Usage:
  node setup-env.mjs                    # Full auto-setup (env + opencode)
  node setup-env.mjs --install-all      # Install everything including model server
  node setup-env.mjs --server ollama    # Install Ollama as model server
  node setup-env.mjs --server lmstudio  # Install LM Studio as model server
  node setup-env.mjs --check-only       # Only check, don't install anything

Options:
  --install-all      Also install a model server (LM Studio or Ollama)
  --server <name>    Specify which server to install: ollama, lmstudio
  --check-only       Only check prerequisites without installing
  --skip-python      Skip Python installation (not required for basic usage)

This script will:
  1. Detect your OS and architecture
  2. Install Node.js 20 LTS if missing
  3. Install Git if missing
  4. Install Python 3 + pip if missing
  5. Install OpenCode CLI if missing
  6. Optionally install a model server (LM Studio or Ollama)
`);
}

async function main() {
  const options = parseArgs();
  
  if (options.help) {
    showHelp();
    return;
  }
  
  log('OpenCode Local Environment Setup', 'cyan');
  log('=================================', 'cyan');
  log(`Platform: ${osInfo.platform} (${osInfo.arch})`, 'gray');
  log(`RAM: ${osInfo.totalRamGb} GB available`, 'gray');
  log(`Node.js: ${osInfo.nodeVersion}`, 'gray');
  
  if (options.checkOnly) {
    log('\nCheck-only mode - verifying prerequisites...', 'yellow');
    
    const nodeOk = getNodeVersion()?.major >= 18;
    const gitOk = commandExists('git');
    const pyOk = getPythonVersion() !== null;
    const ocOk = commandExists('opencode');
    
    log(`\n  Node.js 18+: ${nodeOk ? '✓' : '✗'} ${getNodeVersion()?.version || 'not found'}`);
    log(`  Git:        ${gitOk ? '✓' : '✗'}`);
    log(`  Python 3:   ${pyOk ? '✓' : '✗'} ${getPythonVersion()?.version || ''}`);
    log(`  OpenCode:   ${ocOk ? '✓' : '✗'}`);
    
    if (nodeOk && gitOk && ocOk) {
      log('\nAll required prerequisites are met!', 'green');
    } else {
      log('\nSome prerequisites are missing. Re-run without --check-only to install.', 'yellow');
    }
    return;
  }
  
  // Step 1: Node.js (required for this script to run, but check anyway)
  const nodeOk = await installNodeJS();
  if (!nodeOk && getNodeVersion()?.major < 18) {
    error('Cannot proceed without Node.js 18+. Please install manually.');
    process.exit(1);
  }
  
  // Step 2: Git
  await installGit();
  
  // Step 3: Python (optional but useful for vLLM and tools)
  if (!options.skipPython) {
    await installPython();
  } else {
    log('', 'cyan');
    log('[3/7] Skipping Python (--skip-python)', 'yellow');
  }
  
  // Step 4: OpenCode CLI
  const ocOk = await installOpenCode();
  if (!ocOk) {
    warning('OpenCode installation failed. You can continue and install manually later.');
  }
  
  // Step 5: Model server (only with --install-all or --server flag)
  let serverInstalled = false;
  if (options.installAll || options.server) {
    serverInstalled = await installServer(options.server);
  } else {
    log('', 'cyan');
    log('[5/7] Skipping model server installation', 'yellow');
    info('  Use --install-all or --server <name> to install a model server.');
  }
  
  // Summary
  log('\n========================================', 'cyan');
  log('Environment setup complete!', 'green');
  log('', 'reset');
  log('Installed/Verified:', 'yellow');
  log(`  Node.js:    ${getNodeVersion()?.version || 'missing'}`);
  log(`  Git:        ${commandExists('git') ? '✓' : 'missing'}`);
  log(`  Python:     ${getPythonVersion()?.version || 'skipped/missing'}`);
  log(`  OpenCode:   ${commandExists('opencode') ? '✓' : 'missing'}`);
  
  if (options.installAll || options.server) {
    const hasLm = isWindows ? 
      existsSync(join(process.env.LOCALAPPDATA || '', 'Programs\\LM Studio')) : true;
    log(`  Server:     ${serverInstalled ? '✓' : 'not installed'}`);
  }
  
  log('', 'reset');
  log('Next steps:', 'yellow');
  if (!commandExists('opencode')) {
    log('  1. Install OpenCode manually: curl -fsSL https://opencode.ai/install | bash', 'white');
  }
  if (!serverInstalled && !options.server) {
    log(`  ${!commandExists('opencode') ? '2' : '1'}. Run full setup with models: node full-setup.mjs`, 'white');
  } else {
    log(`  ${!commandExists('opencode') ? '3' : '2'}. Start a model server (LM Studio or Ollama)`, 'white');
    log(`  ${!commandExists('opencode') ? '4' : '3'}. Launch: opencode`, 'white');
  }
}

main().catch(err => {
  error(`Setup failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
