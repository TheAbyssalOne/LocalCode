import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function loadCatalog() {
  for (const candidate of [path.join(scriptDir, "models.json"), path.join(scriptDir, "..", "models.json")]) {
    try {
      return JSON.parse(await fs.readFile(candidate, "utf8"));
    } catch {}
  }
  throw new Error("models.json not found next to the scripts or in the repository root");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("close", (code) => (
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`))
    ));
    child.on("error", (error) => reject(new Error(`${command} could not be started: ${error.message}`)));
  });
}

function variantFor(model, provider, quant) {
  const key = provider === "vllm" ? "vllm" : "ollama";
  const candidates = model.variants.filter((variant) => variant[key]);
  if (!candidates.length) throw new Error(`${model.id} has no ${provider} variant`);
  if (!quant) return candidates[candidates.length - 1];

  const match = candidates.find((variant) => variant.quant === quant);
  if (!match) throw new Error(`${model.id} has no '${quant}' variant for ${provider}`);
  return match;
}

export async function downloadModel({ provider, modelId, quant, catalog }) {
  const resolved = catalog ?? await loadCatalog();
  const model = resolved.models.find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Unknown model '${modelId}'. Known: ${resolved.models.map((m) => m.id).join(", ")}`);
  }

  const variant = variantFor(model, provider, quant);

  switch (provider) {
    case "ollama":
      await run("ollama", ["pull", variant.ollama]);
      return { modelId, provider, ref: variant.ollama };

    case "vllm":
      if (variant.gated) {
        process.stdout.write(`  ! ${variant.vllm} is gated: accept its licence and export HF_TOKEN first.\n`);
      }
      await run("hf", ["download", variant.vllm]);
      return { modelId, provider, ref: variant.vllm };

    case "lmstudio":
      await run("lms", ["get", variant.gguf ?? variant.vllm ?? variant.ollama]);
      return { modelId, provider, ref: variant.gguf ?? variant.ollama };

    default:
      throw new Error(`Unsupported provider '${provider}'. Use ollama, vllm or lmstudio.`);
  }
}

export async function downloadModels({ provider, models = [], quant = null }) {
  const catalog = await loadCatalog();
  const ids = models.length ? models : [catalog.default_model];
  const results = [];

  for (const modelId of ids) {
    try {
      results.push({ ...await downloadModel({ provider, modelId, quant, catalog }), status: "ok" });
    } catch (error) {
      process.stderr.write(`  ✗ ${modelId}: ${error.message}\n`);
      results.push({ modelId, provider, status: "failed", error: error.message });
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [provider, ...models] = process.argv.slice(2);

  if (!provider) {
    process.stdout.write("Usage: node download-models.mjs <ollama|vllm|lmstudio> [model-id...]\n");
    process.exit(1);
  }

  const results = await downloadModels({ provider, models: models.filter((arg) => !arg.startsWith("-")) });
  const failed = results.filter((result) => result.status === "failed");
  process.stdout.write(`\n${results.length - failed.length}/${results.length} models ready\n`);
  process.exitCode = failed.length ? 1 : 0;
}
