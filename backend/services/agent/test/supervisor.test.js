import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";
import {
  canResumeSupervisor, nextFixAction, requestValidatedPlan, runMockableTaskPipeline,
  validatePlan, withinBudget,
} from "../lib/agent/supervisorCore.js";
import { applyExactPatch } from "../lib/agent/taskPatch.js";
import { parseVerifierLog, propagateVerificationExitCode } from "../lib/agent/verifier.js";

const validPlan = {
  title: "Add a main menu",
  summary: "Create a small menu with a start button.",
  tasks: [{
    title: "Create menu scene", goal: "Show a start button.", files_to_read: ["project.godot"],
    files_to_edit: ["scenes/menu.tscn"], acceptance_check: "The menu scene contains a start button.", verify_command: "",
  }],
};

test("Planner repairs invalid JSON once before accepting the plan", async () => {
  let calls = 0;
  const result = await requestValidatedPlan({
    generate: async () => { calls += 1; return { result: "not json", provider: "free-a" }; },
    repair: async ({ error }) => { calls += 1; assert.match(error, /JSON/); return { result: JSON.stringify(validPlan), provider: "free-a" }; },
    failover: async () => { throw new Error("Failover should not be needed."); },
  });
  assert.equal(calls, 2);
  assert.equal(result.plan.tasks[0].title, "Create menu scene");
});

test("Planner uses another provider after an invalid repair", async () => {
  let excluded = [];
  const result = await requestValidatedPlan({
    generate: async () => ({ result: "{}", provider: "provider-a" }),
    repair: async () => ({ result: "still invalid", provider: "provider-a" }),
    failover: async ({ excludedProviders }) => { excluded = excludedProviders; return { result: JSON.stringify(validPlan), provider: "provider-b" }; },
  });
  assert.deepEqual(excluded, ["provider-a"]);
  assert.equal(result.source.provider, "provider-b");
});

test("Planner rejects paths outside the project and unconfigured verify commands", () => {
  const unsafe = structuredClone(validPlan);
  unsafe.tasks[0].files_to_edit = ["../outside.txt"];
  assert.throws(() => validatePlan(unsafe), /invalid files_to_edit/);
  const unknownCommand = structuredClone(validPlan);
  unknownCommand.tasks[0].verify_command = "npm test";
  assert.throws(() => validatePlan(unknownCommand), /not configured/);
});

test("exact patch applier accepts one match and rejects missing or duplicate text", () => {
  assert.equal(applyExactPatch({ original: "const x = 1;\n", oldText: "const x = 1;", newText: "const x = 2;" }), "const x = 2;\n");
  assert.throws(() => applyExactPatch({ original: "x=1", oldText: "y=1", newText: "y=2" }), /did not match/);
  assert.throws(() => applyExactPatch({ original: "x=1\nx=1", oldText: "x=1", newText: "x=2" }), /matched 2 locations/);
  assert.equal(applyExactPatch({ original: null, oldText: undefined, newText: undefined, newFileContent: "new file" }), "new file");
});

test("Fixer runs are capped at three before Planner replans twice and blocks", async () => {
  const calls = [];
  const result = await runMockableTaskPipeline({
    coder: async ({ replans }) => calls.push(`coder:${replans}`),
    fixer: async ({ attempt }) => calls.push(`fixer:${attempt}`),
    verify: async () => ({ ok: false, error: "parse error" }),
    review: async () => ({ approved: true }),
    replan: async ({ replans }) => { calls.push(`planner:${replans}`); return true; },
    checkpoint: async () => calls.push("checkpoint"),
  });
  assert.equal(result.status, "blocked");
  assert.equal(calls.filter((call) => call.startsWith("fixer:")).length, 9);
  assert.equal(calls.filter((call) => call.startsWith("planner:")).length, 2);
  assert.equal(calls.filter((call) => call.startsWith("coder:")).length, 3);
  assert.equal(calls.includes("checkpoint"), false);
  assert.equal(nextFixAction({ fixerAttempts: 3, replans: 1 }), "replan");
  assert.equal(nextFixAction({ fixerAttempts: 3, replans: 2 }), "blocked");
});

test("mocked model workflow verifies, fixes, reviews, and checkpoints in order", async () => {
  const calls = [];
  let verifies = 0;
  const result = await runMockableTaskPipeline({
    coder: async () => calls.push("coder"),
    fixer: async ({ attempt }) => calls.push(`fixer:${attempt}`),
    verify: async () => { verifies += 1; calls.push("verify"); return verifies === 1 ? { ok: false, error: "syntax" } : { ok: true }; },
    review: async () => { calls.push("reviewer"); return { approved: true }; },
    replan: async () => { calls.push("planner"); return true; },
    checkpoint: async () => calls.push("checkpoint"),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["coder", "verify", "fixer:1", "verify", "reviewer", "checkpoint"]);
});

test("hard run budgets stop model work and interrupted runs can resume after restart", () => {
  assert.equal(withinBudget({ deadlineAt: Date.now() + 1000, modelCalls: 32, tokenCount: 0 }).ok, false);
  assert.equal(withinBudget({ deadlineAt: Date.now() + 1000, modelCalls: 1, tokenCount: 120_000 }).ok, false);
  assert.equal(canResumeSupervisor({ supervisorStatus: "interrupted", runStatus: "interrupted" }), true);
  assert.equal(canResumeSupervisor({ supervisorStatus: "blocked", runStatus: "blocked", lastError: "The supervisor reached its model-call limit." }), false);
});

test("verifier recognizes Godot script errors and passing logs", () => {
  const broken = [
    "exit code 1",
    "SCRIPT ERROR: Parse Error: Expected expression.",
    "   at: GDScript::reload (res://scripts/car.gd:12)",
    "ERROR: Failed to load script with error Parse error.",
  ].join("\n");
  const failed = parseVerifierLog(broken);
  assert.equal(failed.ok, false);
  assert.match(failed.firstError, /SCRIPT ERROR/);
  assert.equal(failed.shortStack.length, 1);
  assert.deepEqual(parseVerifierLog("exit code 0\nGodot Engine v4\n"), { ok: true, exitCode: 0, firstError: null, shortStack: [] });
});

test("verifier propagates the launched command's exit status through PowerShell", () => {
  const wrapped = propagateVerificationExitCode("npm test");
  assert.match(wrapped, /^npm test/);
  assert.match(wrapped, /\$antralVerificationExitCode = \$LASTEXITCODE/);
  assert.match(wrapped, /if \(-not \$antralVerificationSucceeded\) \{ exit 1 \}/);
});

test("SQLite plan state survives module reload and restart marks active state interrupted", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "antral-supervisor-test-"));
  const previous = process.env.ANTRAL_DATA_DIR;
  process.env.ANTRAL_DATA_DIR = directory;
  let db;
  try {
    ({ db } = await import("../../../shared/localdb.js"));
    const suffix = Date.now();
    const store = await import(`../data/supervisor.js?test=${suffix}`);
    const runStore = await import(`../data/agentRuns.js?test=${suffix}`);
    const runId = `supervisor-test-${suffix}`;
    store.createSupervisorPlan({ runId, userUid: "test-user", deadlineAt: Date.now() + 10_000 });
    store.updateSupervisorPlan(runId, { phase: "verifying", currentTaskIndex: 2, status: "running" });
    const reloaded = await import(`../data/supervisor.js?reload=${suffix}`);
    assert.equal(reloaded.getSupervisorPlan(runId, "test-user").currentTaskIndex, 2);
    runStore.markInterrupted();
    assert.equal(reloaded.getSupervisorPlan(runId, "test-user").status, "interrupted");
  } finally {
    db?.close();
    if (previous === undefined) delete process.env.ANTRAL_DATA_DIR;
    else process.env.ANTRAL_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
