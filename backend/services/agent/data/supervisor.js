import crypto from "node:crypto";
import { db } from "../../../shared/localdb.js";

const now = () => Date.now();
const parse = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
const fromPlanRow = (row) => {
  if (!row) return null;
  const tasks = db.prepare("SELECT * FROM supervisor_tasks WHERE run_id = ? ORDER BY task_order").all(row.run_id).map(fromTaskRow);
  const attempts = db.prepare("SELECT * FROM supervisor_attempts WHERE run_id = ? ORDER BY started_at").all(row.run_id).map((item) => ({
    id: item.id, taskId: item.task_id, attempt: item.attempt, role: item.role, childRunId: item.child_run_id,
    status: item.status, provider: item.provider, model: item.model, error: item.error, result: item.result,
    startedAt: item.started_at, finishedAt: item.finished_at,
  }));
  const events = db.prepare("SELECT * FROM supervisor_events WHERE run_id = ? ORDER BY id DESC LIMIT 100").all(row.run_id).reverse().map((item) => ({
    id: item.id, taskId: item.task_id, kind: item.kind, role: item.role, provider: item.provider,
    model: item.model, message: item.message, detail: parse(item.detail, {}), at: item.at,
  }));
  return {
    runId: row.run_id, userUid: row.user_uid, status: row.status, phase: row.phase,
    plan: parse(row.plan_json, {}), planMarkdown: row.plan_md, currentTaskIndex: row.current_task_index,
    currentChildRunId: row.current_child_run_id, currentRole: row.current_role, clarification: row.clarification,
    replanCount: row.replan_count, modelCalls: row.model_calls, tokenCount: row.token_count,
    deadlineAt: row.deadline_at, lastError: row.last_error, tasks, attempts, events,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
};
const fromTaskRow = (row) => ({
  id: row.id, runId: row.run_id, order: row.task_order, title: row.title, goal: row.goal,
  filesToRead: parse(row.files_to_read, []), filesToEdit: parse(row.files_to_edit, []),
  acceptanceCheck: row.acceptance_check, verifyCommand: row.verify_command, status: row.status,
  attempts: row.attempts, replans: row.replans, lastError: row.last_error,
  coderAttemptDone: Boolean(row.iteration_coder_done),
  unverified: Boolean(row.unverified), checkpointPath: row.checkpoint_path,
  changedFiles: parse(row.changed_files, []), createdAt: row.created_at, updatedAt: row.updated_at,
  pendingPatches: parse(row.pending_patches, []),
  fixerAttempts: row.fixer_attempts, modelCalls: row.task_model_calls, tokenCount: row.task_token_count, deadlineAt: row.task_deadline_at,
});

export const createSupervisorPlan = ({ runId, userUid, deadlineAt, status = "planning", phase = "intake" }) => {
  const at = now();
  db.prepare(`INSERT INTO supervisor_plans (run_id,user_uid,status,phase,deadline_at,created_at,updated_at)
    VALUES (@runId,@userUid,@status,@phase,@deadlineAt,@at,@at)`).run({ runId, userUid, status, phase, deadlineAt, at });
  return getSupervisorPlan(runId, userUid);
};

export const getSupervisorPlan = (runId, userUid) => {
  const row = db.prepare("SELECT * FROM supervisor_plans WHERE run_id = ? AND user_uid = ?").get(runId, userUid);
  return fromPlanRow(row);
};

export const hasSupervisorRun = (runId) => Boolean(db.prepare("SELECT 1 FROM supervisor_plans WHERE run_id = ?").get(runId));

export const updateSupervisorPlan = (runId, fields) => {
  const mapping = {
    status: "status", phase: "phase", currentTaskIndex: "current_task_index", currentChildRunId: "current_child_run_id", currentRole: "current_role",
    clarification: "clarification", replanCount: "replan_count", modelCalls: "model_calls", tokenCount: "token_count",
    deadlineAt: "deadline_at", lastError: "last_error",
  };
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === "plan") { sets.push("plan_json = ?"); values.push(JSON.stringify(value)); }
    else if (key === "planMarkdown") { sets.push("plan_md = ?"); values.push(String(value || "")); }
    else if (mapping[key]) { sets.push(`${mapping[key]} = ?`); values.push(value == null ? "" : value); }
  }
  if (!sets.length) return;
  sets.push("updated_at = ?"); values.push(now(), runId);
  db.prepare(`UPDATE supervisor_plans SET ${sets.join(", ")} WHERE run_id = ?`).run(...values);
};

const saveTask = db.prepare(`INSERT INTO supervisor_tasks
  (id,run_id,task_order,title,goal,files_to_read,files_to_edit,acceptance_check,verify_command,status,created_at,updated_at)
  VALUES (@id,@runId,@order,@title,@goal,@filesToRead,@filesToEdit,@acceptanceCheck,@verifyCommand,'pending',@at,@at)`);
export const replaceSupervisorTasks = (runId, tasks) => {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM supervisor_tasks WHERE run_id = ?").run(runId);
    tasks.forEach((task, index) => saveTask.run({
      id: crypto.randomUUID(), runId, order: index, title: task.title, goal: task.goal,
      filesToRead: JSON.stringify(task.files_to_read), filesToEdit: JSON.stringify(task.files_to_edit),
      acceptanceCheck: task.acceptance_check, verifyCommand: task.verify_command || "", at: now(),
    }));
  });
  tx();
};

export const updateSupervisorTask = (taskId, fields) => {
  const mapping = {
    status: "status", attempts: "attempts", replans: "replans", lastError: "last_error", coderAttemptDone: "iteration_coder_done",
    unverified: "unverified", checkpointPath: "checkpoint_path", fixerAttempts: "fixer_attempts",
    modelCalls: "task_model_calls", tokenCount: "task_token_count", deadlineAt: "task_deadline_at",
  };
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === "changedFiles") { sets.push("changed_files = ?"); values.push(JSON.stringify(value || [])); }
    else if (key === "pendingPatches") { sets.push("pending_patches = ?"); values.push(JSON.stringify(value || [])); }
    else if (mapping[key]) { sets.push(`${mapping[key]} = ?`); values.push(key === "unverified" ? Number(Boolean(value)) : value); }
  }
  if (!sets.length) return;
  sets.push("updated_at = ?"); values.push(now(), taskId);
  db.prepare(`UPDATE supervisor_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
};

export const updateSupervisorTaskDefinition = (taskId, task) => {
  db.prepare(`UPDATE supervisor_tasks SET title=?,goal=?,files_to_read=?,files_to_edit=?,acceptance_check=?,verify_command=?,updated_at=? WHERE id=?`)
    .run(task.title, task.goal, JSON.stringify(task.files_to_read), JSON.stringify(task.files_to_edit), task.acceptance_check, task.verify_command || "", now(), taskId);
};

export const createSupervisorAttempt = ({ runId, taskId, attempt, role }) => {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO supervisor_attempts (id,run_id,task_id,attempt,role,started_at) VALUES (?,?,?,?,?,?)")
    .run(id, runId, taskId, attempt, role, now());
  return id;
};
export const updateSupervisorAttempt = (id, fields) => {
  const allowed = { childRunId: "child_run_id", status: "status", provider: "provider", model: "model", error: "error", result: "result", finishedAt: "finished_at" };
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields || {})) if (allowed[key]) { sets.push(`${allowed[key]} = ?`); values.push(value ?? ""); }
  if (!sets.length) return;
  values.push(id);
  db.prepare(`UPDATE supervisor_attempts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
};

export const addSupervisorEvent = ({ runId, taskId = null, kind, role = "", provider = "", model = "", message = "", detail = {} }) => {
  db.prepare("INSERT INTO supervisor_events (run_id,task_id,kind,role,provider,model,message,detail,at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(runId, taskId, kind, role, provider, model, message, JSON.stringify(detail), now());
};

export const getProjectSupervisorSettings = (authorizationId, userUid) => {
  const row = db.prepare("SELECT * FROM supervisor_project_settings WHERE authorization_id = ? AND user_uid = ?").get(authorizationId, userUid);
  return row ? { authorizationId, godotPath: row.godot_path, godotSmokeFrames: row.godot_smoke_frames, verifyCommands: parse(row.verify_commands, []) } : { authorizationId, godotPath: "", godotSmokeFrames: 120, verifyCommands: [] };
};
export const setProjectSupervisorSettings = (authorizationId, userUid, { godotPath = "", godotSmokeFrames = 120, verifyCommands = [] }) => {
  db.prepare(`INSERT INTO supervisor_project_settings (authorization_id,user_uid,godot_path,godot_smoke_frames,verify_commands,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(authorization_id) DO UPDATE SET godot_path=excluded.godot_path,
    godot_smoke_frames=excluded.godot_smoke_frames,verify_commands=excluded.verify_commands,updated_at=excluded.updated_at`)
    .run(authorizationId, userUid, godotPath, godotSmokeFrames, JSON.stringify(verifyCommands), now());
  return getProjectSupervisorSettings(authorizationId, userUid);
};
