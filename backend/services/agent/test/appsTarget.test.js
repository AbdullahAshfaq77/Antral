import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { availableTools, getTool } from "../lib/agent/tools/index.js";
import { approvalRuleFor } from "../lib/agent/executor.js";
import { validateFolderArguments } from "../lib/agent/tools/apps.js";
import { LOCAL_COMPUTER_TARGET_ENABLED } from "../lib/policies.js";

test("application and process tools are scoped separately for folder targets", () => {
  const appToolNames = ["find_application", "launch_application"];
  const processToolNames = ["list_processes", "close_application"];
  const appTools = appToolNames.map((name) => getTool(name));
  const processTools = processToolNames.map((name) => getTool(name));

  assert.ok(appTools.every(Boolean));
  assert.ok(processTools.every(Boolean));
  for (const tool of appTools) {
    assert.equal(tool.scope, "launch_applications");
    assert.equal(tool.targetTypes.includes("local"), LOCAL_COMPUTER_TARGET_ENABLED);
  }
  for (const tool of processTools) {
    assert.equal(tool.scope, "manage_processes");
    assert.equal(tool.targetTypes.includes("local"), LOCAL_COMPUTER_TARGET_ENABLED);
  }

  const folderAppTools = availableTools({
    targetType: "local",
    grantedScopes: ["launch_applications"],
    disabledScopes: [],
  }).map((tool) => tool.name);
  const folderProcessTools = availableTools({
    targetType: "local",
    grantedScopes: ["manage_processes"],
    disabledScopes: [],
  }).map((tool) => tool.name);

  assert.equal(folderAppTools.includes("find_application"), LOCAL_COMPUTER_TARGET_ENABLED);
  assert.equal(folderAppTools.includes("launch_application"), LOCAL_COMPUTER_TARGET_ENABLED);
  assert.equal(folderAppTools.includes("list_processes"), false);
  assert.equal(folderAppTools.includes("close_application"), false);
  assert.equal(folderProcessTools.includes("list_processes"), LOCAL_COMPUTER_TARGET_ENABLED);
  assert.equal(folderProcessTools.includes("close_application"), LOCAL_COMPUTER_TARGET_ENABLED);
  assert.equal(folderProcessTools.includes("find_application"), false);
  assert.equal(folderProcessTools.includes("launch_application"), false);
});

test("folder-target app arguments cannot point outside the selected folder", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "antral-app-target-"));
  const root = path.join(parent, "project");
  const outside = path.join(parent, "other-project");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  try {
    await assert.doesNotReject(validateFolderArguments(["--editor", "--path", root], root));
    await assert.rejects(validateFolderArguments(["--path", outside], root), /outside the authorized target/);
    await assert.rejects(validateFolderArguments(["--path", "..\\other-project"], root), /outside the authorized target/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("process closes always require a fresh approval", () => {
  const closeTool = getTool("close_application");
  assert.equal(closeTool.mutating, true);
  assert.equal(approvalRuleFor(closeTool, { expectedName: "notepad", force: false }), null);
  assert.equal(approvalRuleFor(closeTool, { expectedName: "notepad", force: true }), null);
});
