import {
  existsActive,
  existsActiveForAuth,
  listRuns as listRunsData,
  getRun as getRunData,
  listAwaiting,
  listByConversation,
} from "../data/agentRuns.js";
import { getTool, listTools, publicTool } from "../lib/agent/tools/index.js";
import { findAuthByIdUser, setAlwaysAllow, setAuthStatus } from "../data/consent.js";
import { startRun, cancelRun, isRunActive } from "../lib/agent/orchestrator.js";
import { DECISIONS, resolveApproval } from "../lib/agent/approvals.js";
import {
  createConversation,
  getConversation,
  getMessages,
  listConversations,
  deleteConversation,
  deleteConversationsForTarget,
} from "../lib/agent/memory.js";
import { limitsFor } from "../lib/agent/limits.js";
import { resolveProvider } from "../lib/agent/llm.js";
import { validateAttachments } from "../lib/agent/imageAttachments.js";

const MAX_TASK_CHARS = 4000;
const ACTIVE_STATUSES = ["running", "awaiting_approval"];

// GET /tools — every registered tool and the permission it needs.
export const getTools = (_req, res) => {
  res.json({ tools: listTools().map(publicTool) });
};

// POST /runs — start an agent run on an authorized target.
// Sits behind requireAccountConsent + requireTargetAuthorization.
export const createRun = async (req, res, next) => {
  try {
    const attachments = validateAttachments(req.body?.attachments);
    const submittedTask = typeof req.body?.task === "string" ? req.body.task.trim() : "";
    const task = submittedTask || (attachments.length ? "Please describe the attached image(s)." : "");
    if (!task || task.length > MAX_TASK_CHARS) {
      return res.status(400).json({ message: `Describe the task in 1–${MAX_TASK_CHARS} characters.` });
    }

    // One run at a time per user keeps actions on their machine easy to follow.
    if (existsActive(req.user.uid, ACTIVE_STATUSES)) {
      return res.status(409).json({ message: "An agent run is already in progress. Wait for it or cancel it first." });
    }

    // Continue an existing conversation (same target), or start a new one.
    let conversationId = req.body?.conversationId;
    if (conversationId !== undefined && conversationId !== null) {
      const conversation = await getConversation(req.user.uid, conversationId);
      if (!conversation) return res.status(404).json({ message: "Conversation not found or expired." });
      if (
        conversation.target.type !== req.target.type ||
        conversation.target.identifier !== req.target.identifier
      ) {
        return res.status(400).json({ message: "This conversation belongs to a different target." });
      }
    } else {
      conversationId = await createConversation(req.user.uid, { target: req.target, title: task });
    }

    const run = await startRun({
      userUid: req.user.uid,
      authorization: req.authorization,
      target: req.target,
      task,
      attachments,
      disabledScopes: req.accountConsent?.disabledCapabilities || [],
      conversationId,
    });
    return res.status(202).json({
      run: { id: run._id, conversationId, status: run.status, toolsOffered: run.toolsOffered },
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (/No LLM provider|is not set/.test(error.message)) {
      return res.status(503).json({ message: "The AI model isn't configured on the server." });
    }
    return next(error);
  }
};

// GET /runs — the user's recent runs (without step detail).
export const listRuns = async (req, res, next) => {
  try {
    const runs = listRunsData(req.user.uid, { limit: 20 });
    return res.json({ runs });
  } catch (error) {
    return next(error);
  }
};

const findOwnRun = async (req) => getRunData(req.params.id, req.user.uid);

// GET /runs/:id — one run with its full audit log of steps.
export const getRun = async (req, res, next) => {
  try {
    const run = await findOwnRun(req);
    if (!run) return res.status(404).json({ message: "Run not found." });
    return res.json({ run });
  } catch (error) {
    return next(error);
  }
};

// POST /runs/:id/cancel — stop a run in progress.
export const cancelRunHandler = async (req, res, next) => {
  try {
    const run = await findOwnRun(req);
    if (!run) return res.status(404).json({ message: "Run not found." });
    if (!ACTIVE_STATUSES.includes(run.status) || !isRunActive(run._id)) {
      return res.status(409).json({ message: "This run is not in progress." });
    }
    cancelRun(run._id);
    return res.json({ message: "Cancelling…" });
  } catch (error) {
    return next(error);
  }
};

// GET /approvals — actions waiting for the user's decision, across runs.
export const listPendingApprovals = async (req, res, next) => {
  try {
    const runs = listAwaiting(req.user.uid);
    return res.json({
      approvals: runs
        .filter((r) => r.pendingApproval)
        .map((r) => ({ runId: r._id, task: r.task, target: r.target, ...r.pendingApproval })),
    });
  } catch (error) {
    return next(error);
  }
};

// POST /runs/:id/approval — { approvalId, decision: allow_once | allow_always | decline }
export const answerApproval = async (req, res, next) => {
  try {
    const { approvalId, decision } = req.body || {};
    if (!DECISIONS.includes(decision) || typeof approvalId !== "string") {
      return res.status(400).json({ message: `decision must be one of: ${DECISIONS.join(", ")}.` });
    }
    const run = await findOwnRun(req);
    if (!run) return res.status(404).json({ message: "Run not found." });
    if (run.pendingApproval?.id !== approvalId || !resolveApproval(run._id, approvalId, decision)) {
      return res.status(409).json({ message: "This request is no longer waiting for an answer." });
    }
    return res.json({ message: "Thanks. The agent is continuing." });
  } catch (error) {
    return next(error);
  }
};

const findOwnAuthorization = (req) => findAuthByIdUser(req.params.id, req.user.uid);

// GET /targets/:id/always-allow — the saved "Always allow" rules for a target.
export const getAlwaysAllow = async (req, res, next) => {
  try {
    const auth = await findOwnAuthorization(req);
    if (!auth) return res.status(404).json({ message: "Target not found." });
    return res.json({ rules: auth.alwaysAllow });
  } catch (error) {
    return next(error);
  }
};

// DELETE /targets/:id/always-allow — { rule } removes one rule; no rule clears all.
export const removeAlwaysAllow = async (req, res, next) => {
  try {
    const rule = typeof req.body?.rule === "string" ? req.body.rule : null;
    const auth = await findOwnAuthorization(req);
    if (!auth) return res.status(404).json({ message: "Target not found." });
    const rules = rule ? auth.alwaysAllow.filter((r) => r !== rule) : [];
    setAlwaysAllow(auth._id, rules);
    return res.json({ rules });
  } catch (error) {
    return next(error);
  }
};

// GET /conversations — the user's remembered conversations, newest first.
export const listConversationsHandler = async (req, res, next) => {
  try {
    return res.json({ conversations: await listConversations(req.user.uid) });
  } catch (error) {
    return next(error);
  }
};

// GET /conversations/:id — one conversation: summary, remembered messages and runs.
export const getConversationHandler = async (req, res, next) => {
  try {
    const conversation = await getConversation(req.user.uid, req.params.id);
    if (!conversation) return res.status(404).json({ message: "Conversation not found or expired." });
    const messages = await getMessages(req.user.uid, conversation.id);
    const runs = listByConversation(req.user.uid, conversation.id);
    return res.json({ conversation, messages, runs });
  } catch (error) {
    return next(error);
  }
};

// DELETE /conversations/:id — forget a conversation. Run audit logs are kept.
export const deleteConversationHandler = async (req, res, next) => {
  try {
    const removed = await deleteConversation(req.user.uid, req.params.id);
    if (!removed) return res.status(404).json({ message: "Conversation not found." });
    return res.json({ message: "Conversation forgotten." });
  } catch (error) {
    return next(error);
  }
};

// DELETE /projects/:id — delete a project: revoke its authorization and
// forget all of its chats. Run audit logs are kept.
export const deleteProjectHandler = async (req, res, next) => {
  try {
    const auth = await findOwnAuthorization(req);
    if (!auth || auth.status === "revoked") return res.status(404).json({ message: "Project not found." });
    const busy = existsActiveForAuth(req.user.uid, auth._id, ACTIVE_STATUSES);
    if (busy) return res.status(409).json({ message: "The agent is working in this project. Stop it first." });

    setAuthStatus(auth._id, "revoked", { revokedAt: new Date() });
    const chats = await deleteConversationsForTarget(req.user.uid, auth.target);
    return res.json({ message: "Project deleted.", chatsDeleted: chats });
  } catch (error) {
    return next(error);
  }
};

// GET /limits — each agent's context window and work limits.
export const getLimits = (_req, res) => {
  let provider;
  try {
    provider = resolveProvider().name;
  } catch {
    provider = undefined;
  }
  res.json({ limits: { orchestrator: limitsFor("orchestrator", provider) } });
};

// Connected-device status for the settings UI. Read-only: same data as the
// android_diagnose tool, plus whether this host can automate Windows.
export const getDeviceStatus = async (_req, res) => {
  const windows = { available: process.platform === "win32" };
  let android;
  try {
    android = await getTool("android_diagnose").run({}, {});
  } catch (error) {
    android = { problem: error.message };
  }
  res.json({ windows, android });
};
