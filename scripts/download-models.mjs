import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  detectOS,
  getModelsCatalog,
  getModelById,
  recommendModels,
  runCommand,
  getSystemRAM,
} from "./setup-env.mjs";

const execAsync = promisify(execFile);

async function isOllamaRunning() {
  try {
    const resp = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function getOllamaModels() {
  try {
    const resp = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

async function isLMStudioRunning() {
  try {
    const resp = await fetch("http://127.0.0.1:1234/v1/models", { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function getLMStudioModels() {
  try {
    const resp = await fetch("http://127.0.0.1:1234/v1/models", { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data || []).map((m) => m.id);
  } catch {
    return [];
  }
}

async function isVLLMRunning() {
  try {
    const resp = await fetch("http://127.0.0.1:8000/v1/models", { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function getVLLMModels() {
  try {
    const resp = await fetch("http://127.0.0.1:8000/v1/models", { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data || []).map((m) => m.id);
  } catch {
    return [];
  }
}

async function downloadOllamaModel(modelInfo) {
  const tag = modelInfo.providers.ollama.tag;
  console.log(`  Downloading Ollama model: ${tag}`);

  try {
    await runCommand("ollama", ["pull", tag], { timeout: 600_000 });
    console.log(`  ✓ Ollama model ready: ${tag}`);
    return true;
  } catch (error) {
    console.error(`  ✗ Failed to download Ollama model ${tag}: ${error.message}`);
    return false;
  }
}

async function downloadLMStudioModel(modelInfo) {
  const hfRepo = modelInfo.providers.lmstudio.hf_repo;
  const pattern = modelInfo.providers.lmstudio.gguf_file_pattern;

  console.log(`  Downloading LM Studio model from HuggingFace: ${hfRepo}`);
  console.log(`  Pattern: ${pattern}`);
  console.log(`  Note: Open LM Studio, go to "My Models" → click the download icon`);
  console.log(`  Then search for "${hfRepo}" and select the ${modelInfo.quantization} variant.`);

  try {
    const osInfo = detectOS();
    if (osInfo.type === "windows") {
      await execAsync("cmd", ["/c", "start", `https://huggingface.co/${hfRepo}`], { timeout: 5000 });
    } else if (osInfo.type === "macos") {
      await execAsync("open", [`https://huggingface.co/${hfRepo}`], { timeout: 5000 });
    } else {
      await execAsync("xdg-open", [`https://huggingface.co/${hfRepo}`], { timeout: 5000 }).catch(() => {});
    }
    console.log(`  ✓ Opened HuggingFace page for ${hfRepo}`);
    return true;
  } catch (error) {
    console.error(`  ✗ Could not open browser: ${error.message}`);
    return false;
  }
}

async function downloadVLLMModel(modelInfo, modelDir = null) {
  const hfRepo = modelInfo.providers.vllm.hf_repo;
  const targetDir = modelDir || path.join(os.homedir(), ".cache", "huggingface", "hub");

  console.log(`  Downloading vLLM model: ${hfRepo}`);
  console.log(`  Target directory: ${targetDir}`);

  try {
    await runCommand("huggingface-cli", ["download", "--repo-type", "model", hfRepo, "--cache-dir", targetDir], {
      timeout: 600_000,
    });
    console.log(`  ✓ vLLM model downloaded: ${hfRepo}`);
    return true;
  } catch (error) {
    try {
      await runCommand("git", ["clone", `https://huggingface.co/${hfRepo}`, path.join(targetDir, hfRepo.split("/")[1])], {
        timeout: 600_000,
      });
      console.log(`  ✓ vLLM model cloned via git: ${hfRepo}`);
      return true;
    } catch (gitError) {
      console.error(`  ✗ Failed to download vLLM model ${hfRepo}: ${gitError.message}`);
      return false;
    }
  }
}

import os from "node:os";

export async function downloadModels({ provider, models = null, autoSelect = true } = {}) {
  const catalog = await getModelsCatalog();
  const ramGB = await getSystemRAM();

  let modelIds = models;
  if (!modelIds && autoSelect) {
    modelIds = await recommendModels(ramGB);
    console.log(`Auto-selected ${modelIds.length} models for ${ramGB} GB RAM`);
  }
  if (!modelIds || modelIds.length === 0) {
    modelIds = catalog.default_models;
  }

  const results = [];

  switch (provider.toLowerCase()) {
    case "ollama": {
      const running = await isOllamaRunning();
      if (!running) {
        console.error("Error: Ollama is not running. Start it first.");
        return results;
      }

      const existingModels = await getOllamaModels();
      for (const modelId of modelIds) {
        const modelInfo = getModelById(catalog, modelId);
        if (!modelInfo) {
          console.warn(`  Warning: Model ${modelId} not found in catalog`);
          continue;
        }

        const tag = modelInfo.providers.ollama.tag.split(":")[0];
        if (existingModels.some((m) => m.startsWith(tag))) {
          console.log(`  ✓ Ollama model already present: ${tag}`);
          results.push({ modelId, provider, status: "exists" });
          continue;
        }

        const success = await downloadOllamaModel(modelInfo);
        results.push({ modelId, provider, status: success ? "downloaded" : "failed" });
      }
      break;
    }

    case "lmstudio": {
      for (const modelId of modelIds) {
        const modelInfo = getModelById(catalog, modelId);
        if (!modelInfo) {
          console.warn(`  Warning: Model ${modelId} not found in catalog`);
          continue;
        }

        const success = await downloadLMStudioModel(modelInfo);
        results.push({ modelId, provider, status: success ? "initiated" : "failed" });
      }
      break;
    }

    case "vllm": {
      for (const modelId of modelIds) {
        const modelInfo = getModelById(catalog, modelId);
        if (!modelInfo) {
          console.warn(`  Warning: Model ${modelId} not found in catalog`);
          continue;
        }

        const success = await downloadVLLMModel(modelInfo);
        results.push({ modelId, provider, status: success ? "downloaded" : "failed" });
      }
      break;
    }

    default:
      console.error(`Unknown provider: ${provider}`);
      console.log("Supported providers: ollama, lmstudio, vllm");
  }

  return results;
}

export async function listAvailableModels(provider) {
  switch (provider.toLowerCase()) {
    case "ollama":
      return await getOllamaModels();
    case "lmstudio":
      return await getLMStudioModels();
    case "vllm":
      return await getVLLMModels();
    default:
      console.error(`Unknown provider: ${provider}`);
      return [];
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === "download-models.mjs") {
  const args = process.argv.slice(2);
  const provider = args[0];
  const modelArgs = args.slice(1).filter((a) => !a.startsWith("--"));

  if (!provider) {
    console.log("Usage: node download-models.mjs <provider> [model-id...]");
    console.log("Providers: ollama, lmstudio, vllm");
    process.exit(1);
  }

  const models = modelArgs.length > 0 ? modelArgs : null;
  await downloadModels({ provider, models });
}
