#!/usr/bin/env node
// Parse every script in the repo. Runs on Windows, macOS and Linux, because the
// shell-loop version of this check could only ever run on one of them - which is
// how a PowerShell file with a syntax error reached main.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptDir);

async function has(command, args) {
  try {
    await execFileAsync(command, args, { timeout: 15_000 });
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

// -Command does not populate $args, so the path is embedded (single quotes doubled to escape).
const psParse = (file) => `
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$errors) | Out-Null
if ($errors) { $errors | ForEach-Object { "L$($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }
`;

const checkers = {
  ".mjs": { command: process.execPath, args: (file) => ["--check", file] },
  ".sh": { command: "bash", args: (file) => ["-n", file], probe: ["bash", ["-c", "true"]] },
  ".ps1": { command: "pwsh", args: (file) => ["-NoProfile", "-Command", psParse(file)], probe: ["pwsh", ["-NoProfile", "-Command", "exit 0"]] },
};

async function collect(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(full));
    else if (checkers[path.extname(entry.name)]) files.push(full);
  }
  return files;
}

const files = [...await collect(path.join(repoDir, "scripts")), ...await collect(path.join(repoDir, "tests"))];
const available = {};
let failures = 0;
let skipped = 0;

for (const file of files.sort()) {
  const extension = path.extname(file);
  const checker = checkers[extension];

  available[extension] ??= checker.probe ? await has(...checker.probe) : true;
  if (!available[extension]) {
    skipped += 1;
    continue;
  }

  const relative = path.relative(repoDir, file).replace(/\\/g, "/");
  try {
    await execFileAsync(checker.command, checker.args(file), { timeout: 60_000 });
    process.stdout.write(`  ok   ${relative}\n`);
  } catch (error) {
    failures += 1;
    const detail = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim().split("\n").slice(0, 4).join("\n       ");
    process.stdout.write(`  FAIL ${relative}\n       ${detail}\n`);
  }
}

if (skipped) process.stdout.write(`  (${skipped} file(s) skipped: no interpreter on this platform)\n`);
process.stdout.write(failures ? `\n${failures} file(s) failed to parse\n` : "\nAll scripts parse\n");
process.exitCode = failures ? 1 : 0;
