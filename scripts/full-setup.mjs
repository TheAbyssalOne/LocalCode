import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  detectOS,
  checkNodeJS,
  checkOpenCode,
  checkOllama,
  checkLMStudio,
  checkVLLM,
  getSystemRAM,
  recommendModels,
  getModelsCatalog,
  getModelById,
  runCommand,
} from "./setup-env.mjs";
import { downloadModels } from "./download-models.mjs";
import { getConfigPath, getDefaultConfigDir, readConfig, writeConfig, createDefaultConfig } from "./sync-core.mjs";

const execAsync = promisify(execFile);

function parseArgs(args) {
  const parsed = {
    provider: null,
    models: [],
    skipModels: false,
    skipSync: false,
    skipDoctor: false,
    installServer: false,
    launch: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--provider":
        parsed.provider = args[++i];
        break;
      case "--models":
        parsed.models = args[++i].split(",").map((s) => s.trim());
        break;
      case "--skip-models":
        parsed.skipModels = true;
        break;
      case "--skip-sync":
        parsed.skipSync = true;
        break;
      case "--skip-doctor":
        parsed.skipDoctor = true;
        break;
      case "--install-server":
        parsed.installServer = true;
        break;
      case "--launch":
        parsed.launch = true;
        break;
      case "-v":
      case "--verbose":
        parsed.verbose = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`
OpenCode Local Setup - Full Automated Setup

Usage:
  node scripts/full-setup.mjs [options]

Options:
  --provider <name>      Force provider: ollama, lmstudio, vllm (auto-detected by default)
  --models <comma-list>  Model IDs to download (e.g., phi-3-mini,llama-3.1-8b)
  --skip-models          Skip automatic model download
  --skip-sync            Skip post-download model sync
  --skip-doctor          Skip configuration health check
  --install-server       Attempt to install the model server if missing
  --launch               Launch OpenCode after setup completes
  -v, --verbose          Show detailed output
  -h, --help             Show this help message

Examples:
  node scripts/full-setup.mjs                          # Full auto-detect and setup
  node scripts/full-setup.mjs --provider ollama        # Use Ollama as primary
  node scripts/full-setup.mjs --models phi-3-mini      # Download specific model only
  node scripts/full-setup.mjs --install-server          # Install server if missing
  node scripts/full-setup.mjs --launch                  # Setup and launch OpenCode
`);
}

async function logStep(step, total, message) {
  console.log(`\n[${step}/${total}] ${message}`);
}

async function detectAndInstallServer({ provider, installServer }) {
  const osInfo = detectOS();
  let detectedProvider = provider;

  if (!detectedProvider) {
    // Auto-detect: prefer Ollama on Unix, LM Studio on Windows
    if (osInfo.platform === "windows") {
      const lmCheck = await checkLMStudio();
      if (lmCheck.available || lmCheck.running) {
        detectedProvider = "lmstudio";
      } else {
        const ollamaCheck = await checkOllama();
        detectedProvider = ollamaCheck.available ? "ollama" : "lmstudio";
      }
    } else {
      const ollamaCheck = await checkOllama();
      if (ollamaCheck.available || ollamaCheck.running) {
        detectedProvider = "ollama";
      } else {
        const lmCheck = await checkLMStudio();
        detectedProvider = lmCheck.available ? "lmstudio" : "ollama";
      }
    }
  }

  let serverOk = false;

  switch (detectedProvider) {
    case "ollama": {
      const check = await checkOllama();
      if (check.running) {
        console.log(`  ✓ Ollama is running`);
        serverOk = true;
      } else if (check.available && installServer) {
        console.log("  Installing/starting Ollama...");
        try {
          const osInfo2 = detectOS();
          if (osInfo2.platform === "macos") {
            await runCommand("brew", ["install", "ollama"]);
          } else if (osInfo2.platform !== "windows") {
            await runCommand("bash", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"]);
          }
          serverOk = true;
          console.log("  ✓ Ollama installed");
        } catch (error) {
          console.error(`  ✗ Failed to install Ollama: ${error.message}`);
        }
      } else if (!check.available) {
        console.log(`  ! Ollama not found`);
        console.log("  Install with: --install-server or from https://ollama.com/");
      } else {
        console.log(`  ! Ollama installed but not running. Start it manually.`);
      }
      break;
    }

    case "lmstudio": {
      const check = await checkLMStudio();
      if (check.running) {
        console.log(`  ✓ LM Studio is running`);
        serverOk = true;
      } else if (check.available && installServer) {
        console.log("  ! LM Studio requires manual installation.");
        console.log("  Download from https://lmstudio.ai/");
      } else if (!check.available) {
        console.log(`  ! LM Studio not found`);
        console.log("  Download from https://lmstudio.ai/ or use --provider ollama");
      } else {
        console.log(`  ! LM Studio installed but not running. Start it manually.`);
      }
      break;
    }

    case "vllm": {
      const check = await checkVLLM();
      if (check.running) {
        console.log(`  ✓ vLLM is running`);
        serverOk = true;
      } else if (check.available) {
        console.log(`  ! vLLM installed but not running. Start it manually.`);
        console.log("  Example: vllm serve <model-path>");
      } else {
        console.log(`  ! vLLM not found`);
        console.log("  Install with Python: pip install vllm");
      }
      break;
    }
  }

  return { provider: detectedProvider, serverOk };
}

async function setupConfig({ provider }) {
  const configDir = getDefaultConfigDir();
  const configPath = getConfigPath();

  await fs.mkdir(configDir, { recursive: true });

  let cfg;
  try {
    cfg = await readConfig(configPath);
  } catch {
    cfg = createDefaultConfig();
  }

  if (!cfg.provider) cfg.provider = {};
  const providers = cfg.provider;

  const providerConfig = {
    npm: "@ai-sdk/openai-compatible",
    options: {},
    models: {},
  };

  switch (provider) {
    case "ollama":
      providerConfig.name = "Ollama (local)";
      providerConfig.options.baseURL = "http://127.0.0.1:11434/v1";
      providers.ollama = providerConfig;
      break;
    case "lmstudio":
      providerConfig.name = "LM Studio (local)";
      providerConfig.options.baseURL = "http://127.0.0.1:1234/v1";
      providers.lmstudio = providerConfig;
      break;
    case "vllm":
      providerConfig.name = "vLLM (local)";
      providerConfig.options.baseURL = "http://127.0.0.1:8000/v1";
      providers.vllm = providerConfig;
      break;
  }

  cfg.$schema = "https://opencode.ai/config.json";
  if (cfg.autoupdate === undefined) cfg.autoupdate = "notify";
  if (cfg.share === undefined) cfg.share = "manual";

  await writeConfig(cfg, configPath);
  console.log(`  ✓ Config: ${configPath}`);

  return { configPath };
}

async function syncModels({ configPath }) {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const syncScript = path.join(scriptDir, "sync-on-launch.mjs");

  try {
    await execAsync("node", [syncScript], {
      env: { ...process.env, OPENCODE_CONFIG: configPath },
      timeout: 15000,
      encoding: "utf8",
    });
    console.log("  ✓ Models synced");
  } catch (error) {
    if (error.message.includes("ENOENT")) {
      console.log("  ! Sync script not found. Run install.sh or install.ps1 first.");
    } else {
      console.log(`  ! Sync skipped: ${error.message}`);
    }
  }
}

async function runDoctor({ configPath }) {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const doctorScript = path.join(scriptDir, "doctor.mjs");

  try {
    await execAsync("node", [doctorScript], {
      env: { ...process.env, OPENCODE_CONFIG: configPath },
      timeout: 10000,
      encoding: "utf8",
      stdio: "inherit",
    });
  } catch (error) {
    if (error.message.includes("ENOENT")) {
      console.log("  ! Doctor script not found. Run install.sh or install.ps1 first.");
    } else {
      console.log(`  ! Doctor check failed: ${error.message}`);
    }
  }
}

async function launchOpenCode() {
  const isWindows = process.platform === "win32";
  
  console.log("\nLaunching OpenCode...");
  
  try {
    // Check if opencode command exists
    const ocCheck = checkOpenCode();
    if (ocCheck) {
      spawn(isWindows ? "opencode.cmd" : "opencode", [], {
        stdio: "inherit",
        detached: true,
      });
    } else {
      console.log("  ! OpenCode CLI not found. Install from https://opencode.ai/");
      console.log("  Or run manually after installation.");
    }
  } catch (error) {
    console.error(`  ✗ Failed to launch OpenCode: ${error.message}`);
  }
}

export async function fullSetup(options = {}) {
  const args = options.args || process.argv.slice(2);
  const parsed = parseArgs(args);

  if (parsed.help) {
    printHelp();
    return;
  }

  console.log("\nOpenCode Local Setup - Full Automated Setup");
  console.log("==========================================\n");

  let step = 0;
  const totalSteps = parsed.launch ? 7 : 6;

  // Step 1: Check prerequisites
  await logStep(++step, totalSteps, "Checking prerequisites...");
  const nodeCheck = checkNodeJS();
  if (!nodeCheck.meetsRequirement) {
    console.error(`  ✗ Node.js 18+ required. Found: ${nodeCheck.version || 'not installed'}`);
    process.exit(1);
  }
  console.log(`  ✓ Node.js: ${nodeCheck.version}`);

  const ocCheck = checkOpenCode();
  if (ocCheck) {
    console.log(`  ✓ OpenCode is installed`);
  } else {
    console.log(`  ! OpenCode not found. Install from https://opencode.ai/`);
  }

  const ramGB = await getSystemRAM();
  console.log(`  System RAM: ${ramGB} GB`);

  // Step 2: Detect/install server
  await logStep(++step, totalSteps, "Detecting model server...");
  const { provider, serverOk } = await detectAndInstallServer({
    provider: parsed.provider,
    installServer: parsed.installServer,
  });
  console.log(`  Selected provider: ${provider}`);

  // Step 3: Setup configuration
  await logStep(++step, totalSteps, "Setting up configuration...");
  const { configPath } = await setupConfig({ provider });

  // Step 4: Download models
  if (!parsed.skipModels) {
    await logStep(++step, totalSteps, "Downloading models...");
    let modelIds = parsed.models.length > 0 ? parsed.models : null;

    if (!modelIds) {
      modelIds = await recommendModels(ramGB);
      console.log(`  Auto-selected for ${ramGB}GB RAM: ${modelIds.join(", ")}`);
    }

    if (serverOk && provider !== "lmstudio") {
      try {
        const results = await downloadModels({ provider, models: modelIds });
        if (results) {
          const successCount = results.filter((r) => r.status === "downloaded" || r.status === "exists").length;
          console.log(`  ✓ ${successCount}/${results.length} models ready`);
        }
      } catch (error) {
        console.log(`  ! Model download failed: ${error.message}`);
        console.log("  You can download models manually later.");
      }
    } else if (provider === "lmstudio") {
      const catalog = getModelsCatalog();
      const ids = modelIds || await recommendModels(ramGB);
      for (const id of ids) {
        const model = getModelById(catalog, id);
        if (model && model.download) {
          console.log(`  - ${model.display_name}: https://huggingface.co/${model.download.huggingface_repo}`);
        }
      }
      console.log("  Note: Download models in LM Studio's UI, then run sync-models");
    } else if (!serverOk) {
      console.log("  ! Server not running. Models will be downloaded when server is available.");
    }
  } else {
    await logStep(++step, totalSteps, "Skipping model download (--skip-models)");
  }

  // Step 5: Sync models
  if (!parsed.skipSync && serverOk) {
    await logStep(++step, totalSteps, "Syncing models to OpenCode...");
    await syncModels({ configPath });
  } else {
    await logStep(++step, totalSteps, parsed.skipSync ? "Skipping sync (--skip-sync)" : "Server not ready, skipping sync");
  }

  // Step 6: Run doctor
  if (!parsed.skipDoctor) {
    await logStep(++step, totalSteps, "Running configuration health check...");
    await runDoctor({ configPath });
  } else {
    await logStep(++step, totalSteps, "Skipping doctor (--skip-doctor)");
  }

  // Step 7: Launch OpenCode (if requested)
  if (parsed.launch) {
    await logStep(++step, totalSteps, "Launching OpenCode...");
    await launchOpenCode();
  }

  // Summary
  console.log("\n========================================");
  console.log("Setup complete!");
  console.log("");
  console.log("Next steps:");
  
  if (process.platform === "win32") {
    console.log('  1. Restart PowerShell or run: . "$HOME\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1"');
  } else {
    console.log(`  1. Restart your shell or source your shell profile`);
  }

  if (!serverOk) {
    switch (provider) {
      case "ollama":
        console.log("  2. Start Ollama: ollama serve");
        break;
      case "lmstudio":
        console.log("  2. Start LM Studio and load a model");
        break;
      case "vllm":
        console.log("  2. Start vLLM server with your model");
        break;
    }
    if (!parsed.launch) {
      console.log("  3. Launch OpenCode: opencode");
    }
  } else if (!parsed.launch) {
    console.log("  2. Launch OpenCode: opencode");
  }

  console.log("");
  console.log("Quick commands:");
  if (process.platform === "win32") {
    console.log("  oc-lmstudio          - Sync LM Studio and launch");
    console.log("  download-models <p> [models...] - Download models");
  } else {
    console.log(`  oc-ollama            - Sync Ollama and launch`);
    console.log(`  oc-lmstudio          - Sync LM Studio and launch`);
    console.log(`  sync-models          - Refresh model list`);
    console.log(`  download-models <p> [models...] - Download models");
  }
  console.log("  oc-doctor            - Check configuration health");
}

if (process.argv[1] && path.basename(process.argv[1]) === "full-setup.mjs") {
  await fullSetup();
}
