/**
 * Install lifecycle: inspect, reset and remove.
 *
 * Everything here is surgical. LocalCode writes into files it does not own - your shell
 * profile and your opencode.json - so removal touches only what it added: the marker
 * block it wrote, and the provider entries it created. Agents, MCP servers, permissions,
 * themes and keybindings are never touched.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfigPath, getDefaultConfigDir, readConfig, writeConfig } from "./sync-core.mjs";

export const START_MARKER = "# >>> opencode-local-setup >>>";
export const END_MARKER = "# <<< opencode-local-setup <<<";

/** Providers LocalCode manages. Anything else in the config belongs to the user. */
export const MANAGED_PROVIDERS = new Set(["vllm", "ollama", "lmstudio", "llamacpp", "local"]);

export function setupDir() {
  return process.env.OPENCODE_LOCAL_SETUP_DIR ?? path.join(getDefaultConfigDir(), "local-setup");
}

export function shellProfiles() {
  const home = os.homedir();
  if (os.platform() === "win32") {
    return [
      path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
      path.join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    ];
  }
  return [path.join(home, ".bashrc"), path.join(home, ".zshrc"), path.join(home, ".profile")];
}

/** Strip the marker block, leaving the rest of the file byte-for-byte intact. */
export function removeMarkerBlock(content) {
  const lines = content.split("\n");
  const kept = [];
  let skipping = false;
  let removed = false;

  for (const line of lines) {
    if (line.trim() === START_MARKER) { skipping = true; removed = true; continue; }
    if (line.trim() === END_MARKER) { skipping = false; continue; }
    if (!skipping) kept.push(line);
  }

  // Collapse the blank run the block leaves behind, but keep a trailing newline.
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  return { content: text ? `${text}\n` : "", removed };
}

async function pathExists(target) {
  return fs.access(target).then(() => true, () => false);
}

async function dirSizeBytes(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSizeBytes(full);
    else total += await fs.stat(full).then((s) => s.size, () => 0);
  }
  return total;
}

/** What is installed right now, without changing anything. */
export async function inspect() {
  const dir = setupDir();
  const configPath = getConfigPath();

  const installed = await pathExists(dir);
  const files = installed ? (await fs.readdir(dir).catch(() => [])) : [];
  const bytes = installed ? await dirSizeBytes(dir) : 0;

  const profiles = [];
  for (const profile of shellProfiles()) {
    const content = await fs.readFile(profile, "utf8").catch(() => null);
    if (content?.includes(START_MARKER)) profiles.push(profile);
  }

  let config = null;
  if (await pathExists(configPath)) {
    const cfg = await readConfig(configPath).catch(() => null);
    if (cfg) {
      const all = Object.keys(cfg.provider ?? {});
      config = {
        path: configPath,
        managed: all.filter((id) => MANAGED_PROVIDERS.has(id)),
        foreign: all.filter((id) => !MANAGED_PROVIDERS.has(id)),
        hasAgents: Boolean(cfg.agent),
        hasMcp: Boolean(cfg.mcp),
      };
    }
  }

  const envFile = path.join(dir, ".env.local");
  return {
    installed,
    setupDir: dir,
    fileCount: files.length,
    sizeMb: Number((bytes / 1024 ** 2).toFixed(1)),
    hasEnvFile: await pathExists(envFile),
    envFile,
    profiles,
    config,
  };
}

export function renderStatus(state) {
  const lines = ["", "  LocalCode installation", ""];

  lines.push(state.installed
    ? `    Files         ${state.fileCount} in ${state.setupDir} (${state.sizeMb} MB)`
    : "    Files         not installed");

  lines.push(`    Environment   ${state.hasEnvFile ? state.envFile : "none"}`);
  lines.push(state.profiles.length
    ? `    Shell         ${state.profiles.join(", ")}`
    : "    Shell         no profile modified");

  if (state.config) {
    lines.push(`    Config        ${state.config.path}`);
    lines.push(`      managed     ${state.config.managed.join(", ") || "none"}`);
    if (state.config.foreign.length) {
      lines.push(`      yours       ${state.config.foreign.join(", ")} (never touched)`);
    }
    const keeps = [state.config.hasAgents && "agents", state.config.hasMcp && "mcp servers"].filter(Boolean);
    if (keeps.length) lines.push(`      preserved   ${keeps.join(", ")}`);
  } else {
    lines.push("    Config        none");
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Remove what LocalCode installed.
 *
 * `keepConfig` leaves opencode.json alone entirely - useful when you want the provider
 * entries to survive because a server is still running.
 */
export async function uninstall({ keepConfig = false, dryRun = false } = {}) {
  const actions = [];
  const dir = setupDir();

  if (await pathExists(dir)) {
    actions.push({ action: "remove directory", target: dir });
    if (!dryRun) await fs.rm(dir, { recursive: true, force: true });
  }

  for (const profile of shellProfiles()) {
    const content = await fs.readFile(profile, "utf8").catch(() => null);
    if (!content?.includes(START_MARKER)) continue;

    const { content: cleaned, removed } = removeMarkerBlock(content);
    if (!removed) continue;
    actions.push({ action: "unwire shell", target: profile });
    if (!dryRun) await fs.writeFile(profile, cleaned, "utf8");
  }

  if (!keepConfig) {
    const configPath = getConfigPath();
    if (await pathExists(configPath)) {
      const cfg = await readConfig(configPath).catch(() => null);
      const removedProviders = [];

      for (const id of Object.keys(cfg?.provider ?? {})) {
        if (MANAGED_PROVIDERS.has(id)) {
          removedProviders.push(id);
          delete cfg.provider[id];
        }
      }

      if (removedProviders.length) {
        actions.push({ action: "remove providers", target: removedProviders.join(", ") });
        if (!dryRun) await writeConfig(cfg, configPath);
      }
    }
  }

  return actions;
}

/** Restore a minimal, schema-valid config, keeping everything LocalCode does not own. */
export async function resetConfig({ dryRun = false } = {}) {
  const configPath = getConfigPath();
  const cfg = await readConfig(configPath);

  const before = Object.keys(cfg.provider ?? {});
  for (const id of before) {
    if (MANAGED_PROVIDERS.has(id)) delete cfg.provider[id];
  }

  cfg.$schema = "https://opencode.ai/config.json";
  cfg.autoupdate ??= "notify";
  cfg.share ??= "manual";

  if (!dryRun) await writeConfig(cfg, configPath);

  return {
    configPath,
    cleared: before.filter((id) => MANAGED_PROVIDERS.has(id)),
    kept: before.filter((id) => !MANAGED_PROVIDERS.has(id)),
  };
}
