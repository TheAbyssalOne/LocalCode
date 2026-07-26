import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { canSyncBaseURL, fetchModels } from "./sync-core.mjs";

const execFileAsync = promisify(execFile);

async function run(command, args, timeout = 5000) {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", timeout });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(output) {
  return String(output ?? "")
    .split("\n")
    .map((line) => {
      const [name, mib] = line.split(",").map((part) => part.trim());
      return { name, vramGb: Math.round(Number(mib) / 1024) };
    })
    .filter((card) => card.name && Number.isFinite(card.vramGb) && card.vramGb > 0);
}

/** Parse `wsl --list --quiet`, which emits UTF-16LE that Node reads as NUL-interleaved. */
export function parseWslDistros(output) {
  return String(output ?? "")
    .replace(/\0/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function detectGpu() {
  const nvidia = await run("nvidia-smi", [
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (nvidia) {
    const cards = parseNvidiaSmi(nvidia);

    if (cards.length) {
      // Budget against the largest card; --tensor-parallel pools them explicitly.
      return { vendor: "nvidia", cards, vramGb: Math.max(...cards.map((c) => c.vramGb)) };
    }
  }

  const rocm = await run("rocm-smi", ["--showmeminfo", "vram", "--csv"]);
  if (rocm) {
    const bytes = rocm.match(/(\d{9,})/)?.[1];
    if (bytes) return { vendor: "rocm", cards: [], vramGb: Math.round(Number(bytes) / 1024 ** 3) };
    return { vendor: "rocm", cards: [], vramGb: 0 };
  }

  if (os.platform() === "darwin" && os.arch() === "arm64") {
    // Unified memory: the GPU can address most of system RAM, so there is no separate VRAM figure.
    return { vendor: "apple", cards: [{ name: "Apple Silicon", vramGb: 0 }], vramGb: 0 };
  }

  return { vendor: "none", cards: [], vramGb: 0 };
}

export async function detectWsl2() {
  if (os.platform() !== "win32") return { available: false, distros: [] };

  const list = await run("wsl.exe", ["--list", "--quiet"], 10_000);
  if (list === null) return { available: false, distros: [] };

  const distros = parseWslDistros(list);
  if (!distros.length) return { available: false, distros: [] };

  // A listed distro is not a usable one: Docker's helper VMs appear here but have no shell.
  // vLLM needs a real Linux userspace, so prove bash runs before claiming WSL2 is available.
  const probe = await run("wsl.exe", ["-e", "bash", "-lc", "echo localcode-ok"], 20_000);
  const usable = probe?.replace(/\0/g, "").includes("localcode-ok") ?? false;

  return { available: usable, distros, listedOnly: !usable };
}

export async function detectDocker() {
  const version = await run("docker", ["version", "--format", "{{.Server.Version}}"], 10_000);
  return { available: Boolean(version), version };
}

export async function detectPython() {
  for (const command of os.platform() === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    const output = await run(command, ["--version"]);
    const match = output?.match(/(\d+)\.(\d+)/);
    if (match) {
      const [major, minor] = [Number(match[1]), Number(match[2])];
      return { command, version: `${major}.${minor}`, meetsVllm: major === 3 && minor >= 9 };
    }
  }
  return { command: null, version: null, meetsVllm: false };
}

export async function detectCommand(name) {
  const probe = os.platform() === "win32"
    ? await run("where.exe", [name])
    : await run("sh", ["-c", `command -v ${name}`]);
  return Boolean(probe);
}

const SERVER_ENDPOINTS = {
  vllm: "http://127.0.0.1:8000/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  llamacpp: "http://127.0.0.1:8080/v1",
};

async function probeEndpoint(baseURL, timeoutMs) {
  if (!canSyncBaseURL(baseURL)) return null;
  try {
    const models = await fetchModels({
      baseURL,
      fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }),
    });
    return models.map((model) => model.id);
  } catch {
    return null;
  }
}

export async function detectRunningServers(timeoutMs = 1500) {
  const entries = await Promise.all(
    Object.entries(SERVER_ENDPOINTS).map(async ([id, baseURL]) => {
      const models = await probeEndpoint(baseURL, timeoutMs);
      return models ? [id, { baseURL, models }] : null;
    }),
  );
  return Object.fromEntries(entries.filter(Boolean));
}

export async function detect({ probeServers = true } = {}) {
  const [gpu, wsl2, docker, python, ollama, opencode, servers] = await Promise.all([
    detectGpu(),
    detectWsl2(),
    detectDocker(),
    detectPython(),
    detectCommand("ollama"),
    detectCommand("opencode"),
    probeServers ? detectRunningServers() : Promise.resolve({}),
  ]);

  return {
    platform: os.platform(),
    arch: os.arch(),
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    nodeVersion: process.version,
    gpu,
    wsl2,
    docker,
    python,
    has: { ollama, opencode },
    servers,
  };
}

export { SERVER_ENDPOINTS };
