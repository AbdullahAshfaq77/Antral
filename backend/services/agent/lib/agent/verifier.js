import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPowerShell } from "./shell.js";
import { registerTool } from "./tools/registry.js";
import { redactSecrets } from "./redact.js";

export const parseVerifierLog = (rawLog) => {
  const lines = String(rawLog || "").split(/\r?\n/);
  const codeLine = lines.find((line) => /^exit code -?\d+$/i.test(line.trim()));
  const exitCode = codeLine ? Number(codeLine.trim().replace(/^exit code /i, "")) : null;
  const errorPattern = /SCRIPT ERROR|parse error|failed loading resource|failed to load script|\bERROR\b|missing (?:resource|dependency)|cannot open/i;
  const firstError = lines.find((line) => errorPattern.test(line)) || (exitCode !== 0 ? lines.find((line) => /\b(error|failed|exception)\b/i.test(line)) : null) || null;
  const shortStack = lines.filter((line) => /^\s*(?:at:|res:\/\/|\s+at\s)/i.test(line)).slice(0, 5);
  return { ok: exitCode === 0 && !firstError, exitCode, firstError, shortStack };
};

export const propagateVerificationExitCode = (command) => `${String(command || "")}
$antralVerificationSucceeded = $?
$antralVerificationExitCode = $LASTEXITCODE
if ($null -ne $antralVerificationExitCode) { exit $antralVerificationExitCode }
if (-not $antralVerificationSucceeded) { exit 1 }`;

export const findGodotExecutable = async (configuredPath = "") => {
  const candidates = [];
  if (String(configuredPath || "").trim()) candidates.push(String(configuredPath).trim());
  const appData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const directories = [
    path.join(appData, "Programs", "Godot"), path.join(programFiles, "Godot"),
    path.join(programFilesX86, "Godot"), "C:\\Godot",
  ].filter(Boolean);
  for (const dir of directories) {
    for (const name of ["Godot_v4.5-stable_win64_console.exe", "Godot_v4.4-stable_win64_console.exe", "Godot_v4.3-stable_win64_console.exe", "Godot.exe", "godot.exe", "godot4.exe"]) candidates.push(path.join(dir, name));
    const entries = await fs.readdir(dir).catch(() => []);
    for (const name of entries.filter((entry) => /godot.*\.exe$/i.test(entry))) candidates.push(path.join(dir, name));
  }
  for (const candidate of [...new Set(candidates)]) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return path.resolve(candidate);
  }
  return null;
};

const dataDirectory = process.env.ANTRAL_DATA_DIR || fileURLToPath(new URL("../../../../.data", import.meta.url));

export const runVerificationCommand = async ({ command, runId, taskId, root, signal }) => {
  const output = await runPowerShell(propagateVerificationExitCode(command), { cwd: root, signal, timeoutMs: 120_000, executionPolicy: "Bypass" });
  const safeOutput = redactSecrets(String(output || ""));
  const directory = path.join(dataDirectory, "supervisor-logs");
  await fs.mkdir(directory, { recursive: true });
  const rawLogPath = path.join(directory, `${runId}-${taskId}.log`);
  await fs.writeFile(rawLogPath, safeOutput, "utf8");
  return { ...parseVerifierLog(safeOutput), rawLogPath };
};

registerTool({
  name: "run_verify_command",
  category: "computer",
  description: "Run one supervisor-approved project verification command from the configured per-project whitelist.",
  scope: "execute_powershell",
  targetTypes: ["local", "computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Exact command selected by the deterministic supervisor." },
      authorizationId: { type: "string", description: "Internal project authorization identifier." },
      taskId: { type: "string", description: "Internal task identifier." },
    },
    required: ["command", "authorizationId", "taskId"],
  },
  describe: ({ command }) => `Run project verification: ${String(command || "").slice(0, 300)}`,
  ruleFor: ({ authorizationId }) => authorizationId ? `verify_command:${authorizationId}` : null,
  run: async ({ command, taskId }, ctx) => {
    if (!ctx.trustedVerifyCommand || command !== ctx.trustedVerifyCommand) throw new Error("The supervisor rejected a verification command that is not on this project's approved list.");
    return runVerificationCommand({ command, runId: ctx.supervisorRunId, taskId, root: ctx.root, signal: ctx.signal });
  },
});
