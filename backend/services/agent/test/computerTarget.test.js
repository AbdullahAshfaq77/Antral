import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeTarget } from "../lib/targets.js";
import { resolveComputerPath } from "../lib/agent/pathGuard.js";
import { validateReadOnlyCommand } from "../lib/agent/tools/powershell.js";
import { approvalRuleFor, requiresUserApproval } from "../lib/agent/executor.js";

test("This PC uses a fixed target identifier and display name", () => {
  assert.deepEqual(
    normalizeTarget({ type: "computer", identifier: "THIS-PC", label: "arbitrary" }),
    { type: "computer", identifier: "this-pc", label: "This PC" },
  );
  assert.equal(normalizeTarget({ type: "computer", identifier: "C:\\" }), null);
});

test("computer file paths resolve locally and reject network paths", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "antral-computer-"));
  try {
    assert.equal(await resolveComputerPath(folder), path.resolve(folder));
    const networkPath = process.platform === "win32" ? "\\\\server\\share\\secret.txt" : "//server/share/secret.txt";
    await assert.rejects(resolveComputerPath(networkPath), /Network and device paths/);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test("global PowerShell inspection permits local absolute paths but still rejects network paths", () => {
  const localPath = process.platform === "win32" ? "C:\\Users" : "/home";
  assert.equal(validateReadOnlyCommand(`Get-ChildItem "${localPath}"`, { computerTarget: true }).ok, true);
  assert.equal(validateReadOnlyCommand(`Get-ChildItem "${localPath}"`).ok, false);
  assert.equal(validateReadOnlyCommand('Get-ChildItem "\\\\server\\share"', { computerTarget: true }).ok, false);
});

test("This PC asks before commands and changes, and offers an always-allow rule", () => {
  const computer = { type: "computer" };
  const local = { type: "local" };
  const readCommand = { name: "run_powershell_readonly", mutating: false, ruleFor: () => "read_command" };
  const writeFile = { name: "write_file", mutating: true, ruleFor: () => "write_file" };
  const readFile = { name: "read_file", mutating: false, ruleFor: () => null };

  assert.equal(requiresUserApproval(readCommand, computer), true);
  assert.equal(approvalRuleFor(readCommand, {}), "read_command");
  assert.equal(requiresUserApproval(writeFile, computer), true);
  assert.equal(approvalRuleFor(writeFile, {}), "write_file");
  assert.equal(requiresUserApproval(readFile, computer), false);
  assert.equal(requiresUserApproval(readCommand, local), false);
  assert.equal(approvalRuleFor({ name: "run_powershell_readonly", mutating: false }, {}), "run_powershell_readonly");
});
