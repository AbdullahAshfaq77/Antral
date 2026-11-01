// Agent runs + their step audit log in the shared local SQLite database
// (replaces the Mongoose AgentRun model). Steps are stored as rows so the
// frequent "append one step" is a single insert, not a rewrite of the whole run.
import crypto from "node:crypto";
import { db } from "../../../shared/localdb.js";

const nowMs = () => Date.now();
const toDate = (ms) => (ms == null ? null : new Date(Number(ms)));
const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

const toStep = (row) => ({
  kind: row.kind,
  tool: row.tool || "",
  ...(row.args != null ? { args: parse(row.args, undefined) } : {}),
  ...(row.ok != null ? { ok: !!row.ok } : {}),
  content: row.content || "",
  ...(row.duration_ms != null ? { durationMs: Number(row.duration_ms) } : {}),
  at: toDate(row.at),
});

const toRun = (row, { withSteps = false } = {}) => {
  if (!row) return null;
  const run = {
    _id: row.id,
    userUid: row.user_uid,
    authorizationId: row.authorization_id,
    target: { type: row.target_type, identifier: row.target_id, label: row.target_label || "" },
    conversationId: row.conversation_id,
    task: row.task,
    continuedBy: row.continued_by,
    contextLimit: Number(row.context_limit || 0),
    contextTokensUsed: Number(row.context_tokens_used || 0),
    status: row.status,
    pendingApproval: parse(row.pending_approval, null),
    toolsOffered: parse(row.tools_offered, []),
    result: row.result || "",
    error: row.error || "",
    provider: row.provider || "",
    model: row.model || "",
    finishedAt: toDate(row.finished_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  if (withSteps) {
    run.steps = db
      .prepare("SELECT * FROM agent_run_steps WHERE run_id = ? ORDER BY seq ASC")
      .all(row.id)
      .map(toStep);
  }
  return run;
};

const _getById = db.prepare("SELECT * FROM agent_runs WHERE id = ?");

export const createRun = ({ userUid, authorizationId, conversationId, target, task, toolsOffered = [], provider = "", model = "", contextLimit = 0 }) => {
  const id = crypto.randomUUID();
  const now = nowMs();
  db.prepare(`
    INSERT INTO agent_runs
      (id, user_uid, authorization_id, target_type, target_id, target_label, conversation_id, task,
       tools_offered, status, context_limit, provider, model, created_at, updated_at)
    VALUES
      (@id, @uid, @authId, @type, @identifier, @label, @convId, @task,
       @tools, 'running', @contextLimit, @provider, @model, @now, @now)
  `).run({
    id,
    uid: userUid,
    authId: authorizationId,
    type: target.type,
    identifier: target.identifier,
    label: target.label || "",
    convId: conversationId,
    task,
    tools: JSON.stringify(toolsOffered),
    contextLimit,
    provider,
    model,
    now,
  });
  return toRun(_getById.get(id));
};

export const existsActive = (userUid, statuses) => {
  const marks = statuses.map(() => "?").join(",");
  return !!db
    .prepare(`SELECT 1 FROM agent_runs WHERE user_uid = ? AND status IN (${marks}) LIMIT 1`)
    .get(userUid, ...statuses);
};

export const existsActiveForAuth = (userUid, authorizationId, statuses) => {
  const marks = statuses.map(() => "?").join(",");
  return !!db
    .prepare(`SELECT 1 FROM agent_runs WHERE user_uid = ? AND authorization_id = ? AND status IN (${marks}) LIMIT 1`)
    .get(userUid, authorizationId, ...statuses);
};

export const listRuns = (userUid, { limit = 20 } = {}) =>
  db
    .prepare("SELECT * FROM agent_runs WHERE user_uid = ? ORDER BY created_at DESC LIMIT ?")
    .all(userUid, limit)
    .map((r) => toRun(r));

export const getRun = (id, userUid, { withSteps = true } = {}) => {
  const row = _getById.get(id);
  if (!row || row.user_uid !== userUid) return null;
  return toRun(row, { withSteps });
};

export const listAwaiting = (userUid) =>
  db
    .prepare("SELECT * FROM agent_runs WHERE user_uid = ? AND status = 'awaiting_approval'")
    .all(userUid)
    .map((r) => toRun(r));

export const listByConversation = (userUid, conversationId) =>
  db
    .prepare("SELECT * FROM agent_runs WHERE user_uid = ? AND conversation_id = ? ORDER BY created_at ASC")
    .all(userUid, conversationId)
    .map((r) => toRun(r));

// Maps camelCase run fields to columns for a partial update ($set equivalent).
const COLUMN = {
  status: "status",
  result: "result",
  error: "error",
  provider: "provider",
  model: "model",
  contextTokensUsed: "context_tokens_used",
  continuedBy: "continued_by",
  task: "task",
  toolsOffered: "tools_offered",
};

export const updateRun = (id, fields) => {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === "pendingApproval") {
      sets.push("pending_approval = ?");
      vals.push(v == null ? null : JSON.stringify(v));
    } else if (k === "finishedAt") {
      sets.push("finished_at = ?");
      vals.push(v == null ? null : (v instanceof Date ? v.getTime() : Number(v)));
    } else if (COLUMN[k]) {
      sets.push(`${COLUMN[k]} = ?`);
      vals.push(k === "toolsOffered" ? JSON.stringify(v || []) : v);
    }
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  vals.push(nowMs());
  vals.push(id);
  db.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
};

const _nextSeq = db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM agent_run_steps WHERE run_id = ?");
const _insertStep = db.prepare(
  "INSERT INTO agent_run_steps (run_id, seq, kind, tool, args, ok, content, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);

export const appendStep = (runId, step) => {
  const seq = _nextSeq.get(runId).n;
  _insertStep.run(
    runId,
    seq,
    step.kind,
    step.tool || "",
    step.args != null ? JSON.stringify(step.args) : null,
    step.ok == null ? null : step.ok ? 1 : 0,
    step.content || "",
    step.durationMs != null ? step.durationMs : null,
    (step.at instanceof Date ? step.at : new Date()).getTime(),
  );
  db.prepare("UPDATE agent_runs SET updated_at = ? WHERE id = ?").run(nowMs(), runId);
};

// Runs that were executing when the process stopped can't resume.
export const markInterrupted = () => {
  const now = nowMs();
  const result = db.prepare(
    "UPDATE agent_runs SET status = 'interrupted', pending_approval = NULL, error = ?, finished_at = ?, updated_at = ? WHERE status IN ('running','awaiting_approval')",
  ).run("The agent service restarted during this run.", now, now);
  db.prepare("UPDATE supervisor_plans SET status = 'interrupted', updated_at = ? WHERE status = 'running'").run(now);
  return result;
};
