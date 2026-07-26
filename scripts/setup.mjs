#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { detect, SERVER_ENDPOINTS } from "./detect.mjs";
import { getProvider } from "./providers.mjs";
import { bestVariantFor, DEFAULT_PROFILE_VRAM_GB, profile } from "./vram-profile.mjs";
import { inspect, renderStatus, resetConfig, uninstall } from "./manage.mjs";
import {
  getConfigPath,
  getDefaultConfigDir,
  getProviderMap,
  readConfig,
  writeConfig,
} from "./sync-core.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptDir);

// This file runs both from the repository and from the installed setup dir, where there is
// no parent "repo" to look in. Try alongside the script first.
export async function catalogPath() {
  for (const candidate of [path.join(scriptDir, "models.json"), path.join(repoDir, "models.json")]) {
    if (await fs.access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error("models.json not found next to setup.mjs or in the repository root");
}

const START_MARKER = "# >>> opencode-local-setup >>>";
const END_MARKER = "# <<< opencode-local-setup <<<";

// ─── Argument parsing ────────────────────────────────────────────────

export function parseArgs(argv) {
  const flags = {
    provider: null,
    model: null,
    quant: null,
    maxModelLen: null,
    vramGb: null,
    kvDtype: null,
    tensorParallel: null,
    profileOnly: false,
    status: false,
    uninstall: false,
    reinstall: false,
    resetConfig: false,
    keepConfig: false,
    yes: false,
    dryRun: false,
    skipModels: false,
    skipServe: false,
    skipSync: false,
    skipDoctor: false,
    launch: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--provider": flags.provider = argv[++index]; break;
      case "--model": flags.model = argv[++index]; break;
      case "--quant": flags.quant = argv[++index]; break;
      case "--max-model-len": flags.maxModelLen = Number(argv[++index]); break;
      case "--vram": flags.vramGb = Number(argv[++index]); break;
      case "--kv-dtype": flags.kvDtype = argv[++index]; break;
      case "--tensor-parallel": flags.tensorParallel = Number(argv[++index]); break;
      case "--profile": flags.profileOnly = true; break;
      case "--status": flags.status = true; break;
      case "--uninstall": flags.uninstall = true; break;
      case "--reinstall": flags.reinstall = true; break;
      case "--reset-config": flags.resetConfig = true; break;
      case "--keep-config": flags.keepConfig = true; break;
      case "-y": case "--yes": flags.yes = true; break;
      case "--dry-run": flags.dryRun = true; break;
      case "--skip-models": flags.skipModels = true; break;
      case "--skip-serve": flags.skipServe = true; break;
      case "--skip-sync": flags.skipSync = true; break;
      case "--skip-doctor": flags.skipDoctor = true; break;
      case "--launch": flags.launch = true; break;
      case "-h": case "--help": flags.help = true; break;
      default:
        if (argv[index].startsWith("-")) throw new Error(`Unknown option: ${argv[index]}`);
    }
  }
  return flags;
}

const HELP = `
LocalCode - run OpenCode against models on your own hardware

Usage:
  node scripts/setup.mjs [options]

Options:
  --provider <name>     vllm, ollama, lmstudio, llamacpp (auto-detected by default)
  --model <id>          Model id from models.json (e.g. qwen3.6-27b)
  --quant <name>        Force a variant: bf16, fp8, awq4, q4_k_m
  --max-model-len <n>   Override the profiled context limit
  --vram <gb>           Profile against a card of this size instead of the detected one
  --kv-dtype <name>     KV cache precision: fp16 (default) or fp8, which doubles context
  --tensor-parallel <n> Split across n GPUs
  --profile             Show what every catalogued model needs, then exit
  -y, --yes             Take the detected defaults, ask nothing
  --dry-run             Print the resolved plan and exit without changing anything
  --skip-models         Do not download the model
  --skip-serve          Configure only; do not start the model server
  --skip-sync           Do not refresh the model list afterwards
  --skip-doctor         Do not run the health check
  --launch              Launch OpenCode when setup finishes
  -h, --help            Show this message

Managing an existing install:
  --status              Show what is installed and what would be removed
  --reinstall           Remove, then install again with the current options
  --uninstall           Remove files, unwire the shell, drop managed providers
  --keep-config         With --uninstall, leave opencode.json untouched
  --reset-config        Restore a default config, keeping providers you added yourself

With no flags it detects your hardware, proposes a plan, and asks before acting.
`;

// ─── Plan building (pure - no IO, unit tested) ───────────────────────

/**
 * vLLM has no native Windows build, so it runs inside WSL2.
 *
 * Docker Model Runner also serves vLLM on Windows, but only for images published to
 * Docker Hub with a `-vllm` suffix, on port 12434, and only after DMR is reinstalled with
 * `--gpu cuda`. It cannot serve an arbitrary HuggingFace repo, which is what this catalog
 * is built from. Rather than route users into a dead end it is not offered: WSL2 runs
 * real upstream vLLM and takes any repo.
 */
export function selectVllmHost(env) {
  if (env.platform !== "win32") return "native";
  if (env.wsl2.available) return "wsl";
  return null;
}

export function selectProvider(env, requested) {
  if (requested) return { provider: requested, reason: "requested with --provider" };

  const running = Object.keys(env.servers ?? {});
  if (running.length) {
    return { provider: running[0], reason: `already serving on ${env.servers[running[0]].baseURL}` };
  }

  if (env.gpu.vendor === "nvidia" || env.gpu.vendor === "rocm") {
    if (env.platform === "win32") {
      if (selectVllmHost(env)) {
        return { provider: "vllm", reason: `${env.gpu.vendor.toUpperCase()} GPU, vLLM via WSL2` };
      }
      return {
        provider: "ollama",
        reason: "GPU present but no usable WSL2 distro for vLLM",
        fallbackFrom: "vllm",
      };
    }
    if (!env.python.meetsVllm) {
      return { provider: "ollama", reason: "vLLM needs Python 3.9+, which was not found", fallbackFrom: "vllm" };
    }
    return { provider: "vllm", reason: `${env.gpu.vendor.toUpperCase()} GPU with ${env.gpu.vramGb} GB VRAM` };
  }

  if (env.gpu.vendor === "apple") {
    return { provider: "ollama", reason: "Apple Silicon - no practical vLLM path, Ollama uses Metal", fallbackFrom: "vllm" };
  }

  return { provider: "ollama", reason: "no supported GPU detected", fallbackFrom: "vllm" };
}

/**
 * Memory available to the model, in GB.
 *
 * vLLM is strictly VRAM-bound. Ollama can spill into system RAM, but a spilled layer is
 * an order of magnitude slower, so the budget is what stays resident on the accelerator.
 * Apple Silicon has unified memory: the GPU can address most of system RAM.
 */
export function memoryBudgetGb(env, provider) {
  if (provider === "vllm") return env.gpu.vramGb;
  if (env.gpu.vendor === "apple") return Math.floor(env.ramGb * 0.75);
  if (env.gpu.vramGb > 0) return env.gpu.vramGb;
  return env.ramGb;
}

export function selectVariant(model, { provider, budgetGb, quant, kvDtype = "fp16", gpuCount = 1 }) {
  const usesVllm = provider === "vllm";
  // LM Studio and llama.cpp consume GGUF, same as Ollama.
  const candidates = model.variants.filter((variant) => (
    usesVllm ? Boolean(variant.vllm) : Boolean(variant.ollama || variant.gguf)
  ));

  if (quant) {
    const forced = candidates.find((variant) => variant.quant === quant);
    if (!forced) {
      throw new Error(
        `${model.id} has no '${quant}' variant for ${provider}. Available: ${candidates.map((v) => v.quant).join(", ")}`,
      );
    }
    return forced;
  }

  const best = bestVariantFor({
    variants: candidates,
    paramsB: model.params_b,
    arch: model.arch,
    vramGb: budgetGb,
    maxContext: model.context,
    kvDtype,
    gpuCount,
  });
  return best?.variant ?? null;
}

export function buildPlan({ env, catalog, flags }) {
  const { provider, reason, fallbackFrom } = selectProvider(env, flags.provider);

  // Resolve the vLLM host regardless of how the provider was chosen, so an explicit
  // --provider vllm on Windows still routes through WSL2 or Docker rather than "native".
  const vllmHost = provider === "vllm" ? selectVllmHost(env) : null;
  if (provider === "vllm" && !vllmHost) {
    const listed = env.wsl2.listedOnly ? " (WSL is present but has no distro with a shell)" : "";
    throw new Error(
      `vLLM has no native Windows build and no usable WSL2 distro was found${listed}.\n`
      + "  Install one:  wsl --install -d Ubuntu\n"
      + "  Then re-run.  Or use --provider ollama, which runs natively on Windows.",
    );
  }

  const modelId = flags.model ?? catalog.default_model;
  const model = catalog.models.find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Unknown model '${modelId}'. Known: ${catalog.models.map((m) => m.id).join(", ")}`);
  }

  const gpuCount = flags.tensorParallel ?? Math.max(1, env.gpu.cards?.length ?? 1);
  const budgetGb = flags.vramGb ?? memoryBudgetGb(env, provider);
  const kvDtype = flags.kvDtype ?? "fp16";

  const variant = selectVariant(model, { provider, budgetGb, quant: flags.quant, kvDtype, gpuCount });

  if (!variant) {
    throw new Error(
      `No ${model.display_name} variant fits ${budgetGb} GB with usable context.\n`
      + `Try --kv-dtype fp8 to halve the cache, or a smaller model: `
      + catalog.models.filter((m) => m.id !== model.id).map((m) => m.id).join(", "),
    );
  }

  const memory = profile({
    vramGb: budgetGb,
    paramsB: model.params_b,
    quant: variant.quant,
    arch: model.arch,
    kvDtype,
    maxContext: model.context,
    gpuCount,
  });

  const baseURL = provider === "vllm" && vllmHost === "wsl"
    ? SERVER_ENDPOINTS.vllm // resolved to the WSL address at execution time if forwarding is off
    : SERVER_ENDPOINTS[provider];

  const maxModelLen = flags.maxModelLen || memory.maxModelLen;

  return {
    provider,
    providerReason: reason,
    fallbackFrom,
    vllmHost,
    model,
    variant,
    baseURL,
    maxModelLen,
    memory,
    budgetGb,
    kvDtype,
    gpuCount,
    gated: Boolean(variant.gated),
    configPath: getConfigPath(),
    setupDir: process.env.OPENCODE_LOCAL_SETUP_DIR ?? path.join(getDefaultConfigDir(), "local-setup"),
  };
}

/**
 * Full memory profile of the catalog against one card. Answers "what can this GPU
 * actually hold, and with how much context" without installing anything.
 */
export function renderProfile(catalog, { vramGb, kvDtype = "fp16", gpuCount = 1 }) {
  const total = vramGb * gpuCount;
  const tokens = (n) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));
  const lines = [
    "",
    `  Memory profile - ${total} GB${gpuCount > 1 ? ` (${gpuCount} x ${vramGb} GB)` : ""}, ${kvDtype} KV cache`,
    "",
    `  ${"Model".padEnd(22)}${"Quant".padEnd(8)}${"Weights".padStart(9)}${"KV".padStart(9)}${"Context".padStart(10)}`,
    `  ${"-".repeat(58)}`,
  ];

  for (const model of catalog.models) {
    let first = true;
    for (const variant of model.variants) {
      const result = profile({
        vramGb, gpuCount, kvDtype,
        paramsB: model.params_b,
        quant: variant.quant,
        arch: model.arch,
        maxContext: model.context,
      });

      const label = first ? model.display_name.slice(0, 21) : "";
      first = false;
      const engine = variant.vllm ? "vllm" : "ollama";

      lines.push(result.fits
        ? `  ${label.padEnd(22)}${`${variant.quant}`.padEnd(8)}${`${result.weightsGib}G`.padStart(9)}${`${result.kvGib}G`.padStart(9)}${tokens(result.maxModelLen).padStart(10)}  ${engine}`
        : `  ${label.padEnd(22)}${`${variant.quant}`.padEnd(8)}${`${result.weightsGib}G`.padStart(9)}${"-".padStart(9)}${"too big".padStart(10)}  ${engine}`);
    }
  }

  lines.push("", "  Context assumes the whole card is free. Close other GPU users for the full figure.", "");
  return lines.join("\n");
}

/**
 * The exact `vllm serve` arguments for a plan.
 *
 * These were previously computed and only ever displayed. The context limit, the
 * quantization flag and the model's own required flags (Qwen3.6 needs
 * `--reasoning-parser qwen3` for its reasoning output to be parsed at all) all have to
 * reach the server or the model runs mis-configured.
 */
export function vllmServeArgs(plan) {
  const args = [
    "--max-model-len", String(plan.maxModelLen),
    "--gpu-memory-utilization", "0.90",
  ];

  if (plan.gpuCount > 1) args.push("--tensor-parallel-size", String(plan.gpuCount));
  if (plan.kvDtype === "fp8") args.push("--kv-cache-dtype", "fp8");

  args.push(...(plan.variant.extra_args ?? []));
  args.push(...(plan.model.vllm_args ?? []));
  return args;
}

export function renderPlan(plan, env) {
  const lines = [
    "",
    "  Detected",
    `    OS            ${env.platform} ${env.arch}`,
    `    RAM           ${env.ramGb} GB`,
    `    GPU           ${env.gpu.vendor === "none" ? "none" : `${env.gpu.cards[0]?.name ?? env.gpu.vendor}${env.gpu.vramGb ? ` (${env.gpu.vramGb} GB VRAM)` : ""}`}`,
    `    OpenCode      ${env.has.opencode ? "installed" : "not installed - will install"}`,
    "",
    "  Plan",
    `    Server        ${plan.provider}${plan.vllmHost && plan.vllmHost !== "native" ? ` via ${plan.vllmHost}` : ""} - ${plan.providerReason}`,
  ];

  if (plan.fallbackFrom) lines.push(`                  (falling back from ${plan.fallbackFrom})`);

  lines.push(
    `    Model         ${plan.model.display_name} @ ${plan.variant.quant}`,
    `    Source        ${plan.variant.vllm ?? plan.variant.ollama}`,
    `    Endpoint      ${plan.baseURL}`,
  );

  if (plan.memory?.fits) {
    const capped = plan.maxModelLen < plan.model.context;
    lines.push(
      `    Memory        ${plan.memory.weightsGib} GiB weights + ${plan.memory.kvGib} GiB KV of ${plan.budgetGb} GB`
      + `${plan.gpuCount > 1 ? ` across ${plan.gpuCount} GPUs` : ""}`,
      `    Context       ${plan.maxModelLen}${capped ? ` (of ${plan.model.context} max; KV cache is the limit)` : ""}`,
    );
    if (capped && plan.kvDtype === "fp16") {
      lines.push("                  --kv-dtype fp8 would roughly double this");
    }
  }
  lines.push(`    Config        ${plan.configPath}`);
  if (plan.gated) {
    lines.push("", "    ! This repository is gated. Accept its licence on HuggingFace and export HF_TOKEN first.");
  }
  lines.push("");
  return lines.join("\n");
}

// ─── Execution ───────────────────────────────────────────────────────

async function runStep(label, command, args, options = {}) {
  process.stdout.write(`  ${label}\n`);
  return new Promise((resolve) => {
    // Node refuses to exec .cmd/.bat shims without a shell on Windows (CVE-2024-27980).
    const needsShell = os.platform() === "win32" && /\.(cmd|bat)$/i.test(command);
    try {
      const child = spawn(command, args, { stdio: "inherit", shell: needsShell, ...options });
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

async function capture(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", timeout: 15_000, ...options });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Endpoint for a vLLM instance running inside WSL2.
 *
 * Must only be called once the server is up: the probe is the whole point. Called
 * earlier it always fails and falls through to the distro address, which changes on
 * every reboot and silently breaks the config the next day. localhost forwarding is on
 * by default, so 127.0.0.1 is both the common and the stable answer.
 */
export async function resolveWslEndpoint({ probe = true } = {}) {
  if (!probe) return SERVER_ENDPOINTS.vllm;

  const forwarded = await fetch(`${SERVER_ENDPOINTS.vllm}/models`, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.ok)
    .catch(() => false);
  if (forwarded) return SERVER_ENDPOINTS.vllm;

  const addresses = await capture("wsl.exe", ["hostname", "-I"]);
  const ip = addresses?.replace(/\0/g, "").trim().split(/\s+/)[0];
  if (!ip) return SERVER_ENDPOINTS.vllm;

  process.stdout.write(
    `  ! WSL2 localhost forwarding appears disabled; using ${ip}.\n`
    + "    That address changes when WSL restarts - re-run setup if the endpoint stops responding.\n",
  );
  return `http://${ip}:8000/v1`;
}

// npm/winget ship as .cmd shims on Windows, which spawn cannot exec without the extension.
const exe = (name) => (os.platform() === "win32" ? `${name}.cmd` : name);

async function installOpenCode(platform) {
  if (platform === "win32") {
    // https://opencode.ai/install serves a bash script: piping it into iex does not work.
    // npm is guaranteed here because Node is a hard requirement.
    return runStep("Installing OpenCode via npm...", exe("npm"), ["install", "-g", "opencode-ai"]);
  }

  if (await runStep("Installing OpenCode...", "sh", ["-c", "curl -fsSL https://opencode.ai/install | bash"])) {
    return true;
  }
  return runStep("Retrying via npm...", "npm", ["install", "-g", "opencode-ai"]);
}

async function installOllama(platform) {
  if (platform === "win32") return runStep("Installing Ollama...", exe("winget"), ["install", "--id", "Ollama.Ollama", "-e", "--silent"]);
  if (platform === "darwin") return runStep("Installing Ollama...", exe("brew"), ["install", "ollama"]);
  return runStep("Installing Ollama...", "sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"]);
}

async function installVllm(plan, env) {
  if (plan.vllmHost === "wsl") {
    return runStep("Installing vLLM inside WSL2...", "wsl.exe", [
      "-e", "bash", "-lc",
      "python3 -m venv ~/.local/share/localcode/vllm-env && ~/.local/share/localcode/vllm-env/bin/pip install --upgrade pip vllm",
    ]);
  }
  const venvDir = path.join(plan.setupDir, "vllm-env");
  const created = await runStep("Creating vLLM virtualenv...", env.python.command, ["-m", "venv", venvDir]);
  if (!created) return false;
  const pip = path.join(venvDir, os.platform() === "win32" ? "Scripts" : "bin", "pip");
  return runStep("Installing vLLM (several minutes)...", pip, ["install", "--upgrade", "pip", "vllm"]);
}

async function downloadModel(plan) {
  if (plan.provider === "ollama") {
    return runStep(`Pulling ${plan.variant.ollama}...`, "ollama", ["pull", plan.variant.ollama]);
  }
  if (plan.provider === "vllm") {
    // vLLM fetches weights on first serve; pre-fetching just makes the wait visible.
    const repo = plan.variant.vllm;
    if (plan.vllmHost === "wsl") {
      return runStep(`Fetching ${repo} inside WSL2...`, "wsl.exe", [
        "-e", "bash", "-lc", `~/.local/share/localcode/vllm-env/bin/hf download ${repo}`,
      ]);
    }
    const hf = path.join(plan.setupDir, "vllm-env", os.platform() === "win32" ? "Scripts" : "bin", "hf");
    return runStep(`Fetching ${repo}...`, hf, ["download", repo]);
  }
  process.stdout.write(`  Load ${plan.model.display_name} in ${plan.provider} yourself, then re-run sync.\n`);
  return true;
}

async function waitForServer(baseURL, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  let dots = 0;

  while (Date.now() < deadline) {
    const ok = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(3000) })
      .then((response) => response.ok)
      .catch(() => false);

    if (ok) {
      if (dots) process.stdout.write("\n");
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    process.stdout.write(".");
    dots += 1;
  }
  if (dots) process.stdout.write("\n");
  return false;
}

/**
 * Start the model server and wait until it answers.
 *
 * Without this the config is written against a dead port, sync finds nothing, and
 * OpenCode shows an empty model list - the install looks successful and is not.
 */
async function startServer(plan) {
  if (plan.provider === "ollama") {
    // `ollama serve` fails harmlessly when the daemon or service is already up.
    if (await waitForServer(plan.baseURL, 2000)) return true;
    spawn(exe("ollama"), ["serve"], { stdio: "ignore", detached: true }).unref();
    return waitForServer(plan.baseURL, 30_000);
  }

  if (plan.provider !== "vllm") return waitForServer(plan.baseURL, 5000);

  const repo = plan.variant.vllm;
  const args = vllmServeArgs(plan);
  process.stdout.write(`  Starting vLLM: ${repo}\n    ${args.join(" ")}\n`);

  const started = plan.vllmHost === "wsl"
    ? await runStep("Launching inside WSL2...", "wsl.exe", [
      "-e", "bash", "-lc",
      `OPENCODE_LOCAL_SETUP_DIR=~/.local/share/localcode VLLM_VENV_DIR=~/.local/share/localcode/vllm-env `
      + `bash ~/.local/share/localcode/vllm-server.sh start ${repo} ${args.join(" ")}`,
    ])
    : await runStep("Launching vLLM...", "bash", [
      path.join(plan.setupDir, "vllm-server.sh"), "start", repo, ...args,
    ], { env: { ...process.env, OPENCODE_LOCAL_SETUP_DIR: plan.setupDir } });

  if (!started) return false;

  process.stdout.write("  Waiting for weights to load");
  return waitForServer(plan.baseURL);
}

export function envFileContents(plan) {
  return `# LocalCode environment
LOCAL_API_BASE=${plan.baseURL}
OPENCODE_PROVIDER_ID=${plan.provider}
OPENCODE_PROVIDER_NAME="${getProvider(plan.provider)?.name ?? plan.provider}"

# Local server authentication (most local servers need none)
# LOCAL_API_KEY=

# HuggingFace token, required for gated repositories
# HF_TOKEN=

# Model oc-vllm starts when the server is not already running
${plan.variant.vllm ? `VLLM_MODEL=${plan.variant.vllm}` : "# VLLM_MODEL="}

# Remote OpenAI-compatible servers
# REMOTE_API_BASE=https://your-server.example/v1
# REMOTE_API_KEY=

# Tailscale discovery (opt-in)
# OPENCODE_TAILSCALE_DISCOVERY=1
# OPENCODE_TAILSCALE_PORTS=1234,8000,8080,11434
`;
}

export function applyMarkerBlock(existing, body) {
  const lines = existing.split("\n");
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    if (line.trim() === START_MARKER) { skipping = true; continue; }
    if (line.trim() === END_MARKER) { skipping = false; continue; }
    if (!skipping) kept.push(line);
  }

  const head = kept.join("\n").replace(/\s+$/, "");
  return `${head}\n\n${START_MARKER}\n${body}\n${END_MARKER}\n`;
}

async function restrictToCurrentUser(filePath) {
  if (os.platform() !== "win32") {
    await fs.chmod(filePath, 0o600).catch(() => {});
    return;
  }
  // fs.chmod is a no-op on Windows; ACLs are the only real protection for a secrets file.
  const user = process.env.USERNAME;
  if (!user) return;
  await execFileAsync("icacls.exe", [filePath, "/inheritance:r", "/grant:r", `${user}:(F)`], { timeout: 10_000 })
    .catch(() => process.stdout.write(`  ! Could not restrict permissions on ${filePath}\n`));
}

async function wireShell(plan) {
  if (os.platform() === "win32") {
    const profileDir = path.join(os.homedir(), "Documents", "PowerShell");
    const profileFile = path.join(profileDir, "Microsoft.PowerShell_profile.ps1");
    await fs.mkdir(profileDir, { recursive: true });
    const existing = await fs.readFile(profileFile, "utf8").catch(() => "");
    // Guarded, mirroring the bash block: a removed setup dir must not break every new
    // session. Without this, deleting the directory leaves an unconditional dot-source.
    const wrapperPath = path.join(plan.setupDir, "opencode-wrapper.ps1");
    const body = `$env:OPENCODE_LOCAL_SETUP_DIR = "${plan.setupDir}"\n`
      + `if (Test-Path "${wrapperPath}") { . "${wrapperPath}" }`;
    await fs.writeFile(profileFile, applyMarkerBlock(existing, body), "utf8");
    return profileFile;
  }

  const rcFile = path.join(os.homedir(), /zsh$/.test(process.env.SHELL ?? "") ? ".zshrc" : ".bashrc");
  const existing = await fs.readFile(rcFile, "utf8").catch(() => "");
  const wrapper = path.join(plan.setupDir, "opencode-wrapper.sh");
  const body = `export OPENCODE_LOCAL_SETUP_DIR="${plan.setupDir}"\n[ -f "${wrapper}" ] && . "${wrapper}"`;
  await fs.writeFile(rcFile, applyMarkerBlock(existing, body), "utf8");
  return rcFile;
}

/**
 * Everything copied into the setup dir.
 *
 * Must cover the full import graph of every entry point installed here, or the installed
 * copy dies on a missing module. tests/setup.test.mjs walks the imports and fails if this
 * list falls behind - the previous installer shipped without the files its own wrappers
 * called, and nothing caught it.
 */
export const INSTALLED_FILES = [
  "providers.mjs",
  "sync-core.mjs",
  "sync-provider.mjs",
  "sync-on-launch.mjs",
  "detect.mjs",
  "doctor.mjs",
  "download-models.mjs",
  "setup.mjs",
  "vram-profile.mjs",
  "manage.mjs",
  "opencode-wrapper.sh",
  "opencode-wrapper.ps1",
  "vllm-server.sh",
  "vllm-server.ps1",
];

async function installFiles(plan) {
  await fs.mkdir(plan.setupDir, { recursive: true, mode: 0o700 });

  const copy = async (source, destination) => {
    // Re-running from the installed copy would otherwise copy a file onto itself.
    if (path.resolve(source) === path.resolve(destination)) return;
    if (await fs.access(source).then(() => true, () => false)) {
      await fs.copyFile(source, destination);
    }
  };

  for (const name of INSTALLED_FILES) {
    await copy(path.join(scriptDir, name), path.join(plan.setupDir, name));
  }
  await copy(await catalogPath(), path.join(plan.setupDir, "models.json"));
}

async function writeProviderConfig(plan) {
  const cfg = await readConfig(plan.configPath);
  const providers = getProviderMap(cfg);
  const existing = providers[plan.provider] ?? {};

  providers[plan.provider] = {
    ...existing,
    npm: existing.npm ?? getProvider(plan.provider)?.npm ?? "@ai-sdk/openai-compatible",
    name: existing.name ?? getProvider(plan.provider)?.name ?? plan.provider,
    options: { ...(existing.options ?? {}), baseURL: plan.baseURL },
    models: existing.models ?? {},
  };

  cfg.$schema = "https://opencode.ai/config.json";
  cfg.autoupdate ??= "notify";
  cfg.share ??= "manual";

  await writeConfig(cfg, plan.configPath);
}

async function execute(plan, env, flags) {
  process.stdout.write("\nApplying\n");

  // Escape hatch for tests and for machines where prerequisites are managed elsewhere:
  // without it, a test run could trigger a real global install.
  const installPrereqs = process.env.LOCALCODE_SKIP_PREREQS !== "1";

  if (installPrereqs && !env.has.opencode) await installOpenCode(env.platform);

  if (installPrereqs && plan.provider === "ollama" && !env.has.ollama) {
    if (!await installOllama(env.platform)) {
      process.stdout.write("  ! Ollama install failed. Install it from https://ollama.com/ and re-run.\n");
      return false;
    }
  }

  if (installPrereqs && plan.provider === "vllm" && !env.servers.vllm) {
    if (!await installVllm(plan, env)) {
      process.stdout.write("  ! vLLM install failed.\n");
      return false;
    }
  }

  await installFiles(plan);
  process.stdout.write(`  Installed helper files to ${plan.setupDir}\n`);

  if (!flags.skipModels) await downloadModel(plan);

  // Bring the server up before anything reads from it. Only now is the WSL2 endpoint
  // knowable, so resolve it here and let the env file and config record the same answer.
  let serving = false;
  if (!flags.skipServe) {
    serving = await startServer(plan);
    if (!serving) {
      process.stdout.write(
        `  ! ${plan.provider} did not come up. The config is still written; start it yourself and run sync-models.\n`,
      );
    }
  }

  if (plan.provider === "vllm" && plan.vllmHost === "wsl") {
    plan.baseURL = await resolveWslEndpoint({ probe: serving });
  }

  // Written last so it records the endpoint that was actually resolved. An existing file
  // is the user's - never overwrite it.
  const envFile = path.join(plan.setupDir, ".env.local");
  if (await fs.access(envFile).then(() => true, () => false)) {
    process.stdout.write(`  Kept existing ${envFile}\n`);
  } else {
    await fs.writeFile(envFile, envFileContents(plan), { encoding: "utf8", mode: 0o600 });
    await restrictToCurrentUser(envFile);
    process.stdout.write(`  Wrote ${envFile}\n`);
  }

  await writeProviderConfig(plan);
  // The config carries {env:VAR} references rather than secrets, but it is still a
  // user-scoped file; POSIX gets 0600 from writeConfig, Windows needs the ACL.
  await restrictToCurrentUser(plan.configPath);
  process.stdout.write(`  Wrote ${plan.configPath}\n`);

  const profile = await wireShell(plan);
  process.stdout.write(`  Wired ${profile}\n`);

  if (!flags.skipSync && serving) {
    await runStep("Syncing model list...", process.execPath, [path.join(scriptDir, "sync-on-launch.mjs")], {
      env: { ...process.env, OPENCODE_CONFIG: plan.configPath, LOCAL_API_BASE: plan.baseURL },
    });
  }

  if (!flags.skipDoctor) {
    await runStep("Health check...", process.execPath, [path.join(scriptDir, "doctor.mjs")], {
      env: { ...process.env, OPENCODE_CONFIG: plan.configPath },
    });
  }

  if (flags.launch) {
    spawn(env.platform === "win32" ? "opencode.cmd" : "opencode", [], { stdio: "inherit", detached: true });
  }

  return true;
}

function nextSteps(plan) {
  const lines = ["", "Next steps:", "  1. Restart your shell so the helper commands load."];

  if (plan.provider === "vllm") {
    const serve = plan.vllmHost === "wsl" ? "oc-vllm (starts the server inside WSL2)" : "oc-vllm";
    lines.push(`  2. Start serving: ${serve}`);
  } else if (plan.provider === "ollama") {
    lines.push("  2. Make sure Ollama is running: ollama serve");
  }
  lines.push("  3. Launch OpenCode: opencode");
  lines.push("", "Useful: sync-models, oc-doctor");
  return lines.join("\n");
}

// ─── Lifecycle ───────────────────────────────────────────────────────

async function confirm(question, assumeYes) {
  if (assumeYes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return ["y", "yes"].includes(answer);
  } finally {
    rl.close();
  }
}

/** Returns true when the run is finished, false when setup should continue (--reinstall). */
async function runLifecycle(flags) {
  const state = await inspect();
  process.stdout.write(renderStatus(state));

  if (flags.status) return true;

  if (flags.resetConfig) {
    const preview = await resetConfig({ dryRun: true });
    if (!preview.cleared.length) {
      process.stdout.write("  Nothing to reset: no managed providers in the config.\n\n");
      return true;
    }
    process.stdout.write(`  Will clear: ${preview.cleared.join(", ")}\n`);
    if (preview.kept.length) process.stdout.write(`  Will keep:  ${preview.kept.join(", ")}\n`);

    if (!await confirm("\nReset configuration?", flags.yes)) {
      process.stdout.write("Cancelled.\n");
      return true;
    }
    const result = await resetConfig();
    process.stdout.write(`\n  Reset ${result.configPath}\n\n`);
    return true;
  }

  if (!state.installed && !state.profiles.length) {
    if (flags.uninstall) {
      process.stdout.write("  Nothing to uninstall.\n\n");
      return true;
    }
    return false; // --reinstall on a clean machine is just an install
  }

  const planned = await uninstall({ keepConfig: flags.keepConfig, dryRun: true });
  if (planned.length) {
    process.stdout.write("  Will remove:\n");
    for (const action of planned) process.stdout.write(`    ${action.action}: ${action.target}\n`);
  }

  process.stdout.write(
    "\n  Downloaded model weights are NOT removed - they live in the model server's own\n"
    + "  store (~/.ollama, ~/.cache/huggingface). Delete those with the server's own tools.\n",
  );

  const question = flags.reinstall ? "\nRemove and reinstall?" : "\nUninstall?";
  if (!await confirm(question, flags.yes)) {
    process.stdout.write("Cancelled.\n");
    return true;
  }

  const done = await uninstall({ keepConfig: flags.keepConfig });
  process.stdout.write(`\n  Removed ${done.length} item(s).\n`);

  if (flags.reinstall) {
    process.stdout.write("  Reinstalling...\n");
    return false;
  }

  process.stdout.write("  Restart your shell to drop the helper commands.\n\n");
  return true;
}

// ─── Entry point ─────────────────────────────────────────────────────

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }

  process.stdout.write("\nLocalCode setup\n===============\n");

  // Lifecycle modes act on an existing install and need no hardware detection.
  if (flags.status || flags.uninstall || flags.reinstall || flags.resetConfig) {
    const handled = await runLifecycle(flags);
    if (handled) return;
  }

  const [env, catalog] = await Promise.all([
    detect(),
    catalogPath().then((file) => fs.readFile(file, "utf8")).then(JSON.parse),
  ]);

  if (flags.profileOnly) {
    // Falls back to a 32 GB card so the profile is useful on a machine without a GPU.
    const vramGb = flags.vramGb ?? (env.gpu.vramGb || DEFAULT_PROFILE_VRAM_GB);
    process.stdout.write(renderProfile(catalog, {
      vramGb,
      kvDtype: flags.kvDtype ?? "fp16",
      gpuCount: flags.tensorParallel ?? Math.max(1, env.gpu.cards?.length ?? 1),
    }));
    return;
  }

  let plan;
  try {
    plan = buildPlan({ env, catalog, flags });
  } catch (error) {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(renderPlan(plan, env));

  if (flags.dryRun) {
    process.stdout.write("Dry run - nothing was changed.\n");
    return;
  }

  if (!flags.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("Proceed? [Y/n] ")).trim().toLowerCase();
      if (answer && !["y", "yes"].includes(answer)) {
        process.stdout.write("Cancelled.\n");
        return;
      }
    } finally {
      rl.close();
    }
  }

  const ok = await execute(plan, env, flags);
  process.stdout.write(ok ? `${nextSteps(plan)}\n` : "\nSetup did not complete.\n");
  if (!ok) process.exitCode = 1;
}

// Only run when invoked directly; importing this module must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
