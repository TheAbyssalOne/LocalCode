import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { getConfigPath, readConfig } from "./sync-core.mjs";

const execFileAsync = promisify(execFile);
const configPath = getConfigPath();
let failures = 0;
let warnings = 0;

function ok(message) {
  console.log(`✓ ${message}`);
}

function warn(message) {
  warnings += 1;
  console.log(`! ${message}`);
}

function fail(message) {
  failures += 1;
  console.log(`✗ ${message}`);
}

async function getOpenCodeVersion() {
  try {
    const { stdout } = await execFileAsync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function hasEmbeddedSecret(value) {
  if (typeof value !== "string") return false;
  if (/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return false;
  return /^(?:sk-|xai-|gsk_|fw_|Bearer\s+)[A-Za-z0-9._-]{8,}/i.test(value);
}

console.log("OpenCode Local Setup doctor\n");
const version = await getOpenCodeVersion();
if (version) ok(`OpenCode ${version} is available`);
else warn("OpenCode is not in PATH; install it from https://opencode.ai/docs/");

try {
  await fs.access(configPath);
  ok(`Config found: ${configPath}`);
} catch {
  warn(`Config does not exist yet: ${configPath}`);
}

try {
  const cfg = await readConfig(configPath);
  if (cfg.$schema === "https://opencode.ai/config.json") ok("Current OpenCode schema is configured");
  else warn("Config does not reference https://opencode.ai/config.json");

  const providers = Object.entries(cfg.provider ?? {});
  ok(`${providers.length} custom provider${providers.length === 1 ? "" : "s"} configured`);

  for (const [providerId, provider] of providers) {
    const baseURL = provider?.options?.baseURL;
    if (!baseURL) warn(`${providerId}: missing options.baseURL`);

    // Config shape alone is a weak signal: a valid config against a dead port still
    // means no models in OpenCode. Probe, but never fail on it - a laptop with a
    // sleeping GPU box is a normal state, not a broken install.
    if (baseURL) {
      const modelCount = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
        signal: AbortSignal.timeout(2000),
      })
        .then(async (response) => (response.ok ? (await response.json())?.data?.length ?? 0 : null))
        .catch(() => null);

      if (modelCount === null) {
        warn(`${providerId}: ${baseURL} is not responding; start the server, then run sync-models`);
      } else if (modelCount === 0) {
        warn(`${providerId}: reachable but serving no models`);
      } else {
        const configured = Object.keys(provider?.models ?? {}).length;
        ok(`${providerId}: serving ${modelCount} model${modelCount === 1 ? "" : "s"}`);
        if (configured === 0) {
          warn(`${providerId}: none are in your config yet; run sync-models`);
        }
      }
    }
    if (hasEmbeddedSecret(provider?.options?.apiKey)) fail(`${providerId}: literal API key found; use {env:VARIABLE}`);

    for (const [header, value] of Object.entries(provider?.options?.headers ?? {})) {
      if (header.toLowerCase() === "authorization" && !/^\{env:/.test(String(value))) {
        fail(`${providerId}: literal Authorization header found in config`);
      }
    }

    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      if (Object.hasOwn(model, "tools")) fail(`${providerId}/${modelId}: legacy model field 'tools' must be 'tool_call'`);
      if (model.limit && (!model.limit.context || !model.limit.output)) {
        fail(`${providerId}/${modelId}: model.limit requires context and output`);
      }
    }
  }
} catch (error) {
  fail(error.message);
}

console.log(`\n${failures} error${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
process.exitCode = failures ? 1 : 0;
