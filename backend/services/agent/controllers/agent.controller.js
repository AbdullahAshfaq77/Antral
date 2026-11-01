import axios from "axios";
import fs from "node:fs/promises";
import {
  existsActive,
  existsActiveForAuth,
  listRuns as listRunsData,
  getRun as getRunData,
  listAwaiting,
  listByConversation,
} from "../data/agentRuns.js";
import { subscribeRun } from "../lib/agent/runEvents.js";
import { getTool, listTools, publicTool } from "../lib/agent/tools/index.js";
import { findAuthByIdUser, setAlwaysAllow, setAuthStatus } from "../data/consent.js";
import { startRun, cancelRun, isRunActive } from "../lib/agent/orchestrator.js";
import {
  approveSupervisorPlan, answerSupervisorChildApproval, hasSupervisorPlan, isSupervisorActive,
  pauseSupervisor, resumeSupervisor, rollbackSupervisorCheckpoint, startSupervisor, stopSupervisor, syncSupervisorRun,
} from "../lib/agent/supervisor.js";
import { getProjectSupervisorSettings, setProjectSupervisorSettings } from "../data/supervisor.js";
import { findGodotExecutable } from "../lib/agent/verifier.js";
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
import { resolveProvider, PROVIDER_META, activeProvider, providerHealth, resetProviderHealth } from "../lib/agent/llm.js";
import { getLlmConfig, setLlmConfig, maskSecret, getToolApiSettings, setToolApiSettings } from "../data/settings.js";
import { getLlmProfiles, setLlmProfiles, getRoleModels, setRoleModels } from "../data/settings.js";
import providerCatalog from "../providers/catalog.json" with { type: "json" };
import { validateAttachments } from "../lib/agent/imageAttachments.js";

const MAX_TASK_CHARS = 4000;
const ACTIVE_STATUSES = ["running", "awaiting_approval", "awaiting_plan_approval"];
const profileHasRequiredCredentials = (profile) => {
  const preset = providerCatalog.presets.find((item) => item.id === profile.id);
  return (preset?.requiredFields || []).every((field) => Boolean(String(profile[field] || "").trim()));
};
const publicProviderProfile = ({ apiKey, apiKeyEncrypted, ...profile }) => ({
  ...profile,
  hasKey: Boolean(apiKey),
  keyLast4: apiKey ? maskSecret(apiKey).slice(-4) : null,
});

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

    const runInput = {
      userUid: req.user.uid,
      authorization: req.authorization,
      target: req.target,
      task,
      attachments,
      disabledScopes: req.accountConsent?.disabledCapabilities || [],
      conversationId,
    };
    const run = req.body?.mode === "plan" ? await startSupervisor(runInput) : await startRun({ ...runInput, attachments });
    return res.status(202).json({
      run: { id: run._id, conversationId, status: run.status, toolsOffered: run.toolsOffered, ...(run.supervisor ? { supervisor: run.supervisor, authorizationId: run.authorizationId } : {}) },
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
    const runs = listRunsData(req.user.uid, { limit: 20 }).map((run) => syncSupervisorRun(run, req.user.uid));
    return res.json({ runs });
  } catch (error) {
    return next(error);
  }
};

const findOwnRun = async (req) => getRunData(req.params.id, req.user.uid);

const authorizationForRun = (run, userUid) => {
  const authorization = findAuthByIdUser(run.authorizationId, userUid);
  if (!authorization || !authorization.isCurrentlyValid()) {
    const error = new Error("This target authorization was revoked or expired. Re-authorize the project before continuing.");
    error.status = 403;
    throw error;
  }
  return authorization;
};

// GET /runs/:id/stream — Server-Sent Events: pushes the model's text live as it
// is generated, then a "done" event. Falls back gracefully if the run already
// finished (sends the final text immediately). The UI also still polls, so this
// is a pure enhancement.
export const streamRun = (req, res) => {
  const id = req.params.id;
  const run = getRunData(id, req.user.uid, { withSteps: false });
  if (!run) return res.status(404).json({ message: "Run not found." });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // client gone
    }
  };

  // Sync the current text immediately so a late subscriber catches up.
  send({ type: "init", status: run.status, result: run.result || "" });

  if (!ACTIVE_STATUSES.includes(run.status)) {
    send({ type: "done", status: run.status });
    return res.end();
  }

  let ping;
  const cleanup = () => {
    clearInterval(ping);
    unsubscribe();
  };
  const unsubscribe = subscribeRun(id, (event) => {
    send(event);
    if (event.type === "done") {
      cleanup();
      res.end();
    }
  });
  ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // ignore
    }
  }, 15000);
  req.on("close", cleanup);
  return undefined;
};

// GET /runs/:id — one run with its full audit log of steps.
export const getRun = async (req, res, next) => {
  try {
    let run = await findOwnRun(req);
    if (!run) return res.status(404).json({ message: "Run not found." });
    run = syncSupervisorRun(run, req.user.uid);
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
    if (hasSupervisorPlan(run._id)) {
      if (!stopSupervisor(run, req.user.uid)) return res.status(409).json({ message: "This supervisor run has already stopped." });
      return res.json({ message: "Stopping the supervisor…" });
    }
    if (!ACTIVE_STATUSES.includes(run.status) || !isRunActive(run._id)) {
      return res.status(409).json({ message: "This run is not in progress." });
    }
    cancelRun(run._id);
    return res.json({ message: "Cancelling…" });
  } catch (error) {
    return next(error);
  }
};

export const approveSupervisorPlanHandler = async (req, res, next) => {
  try {
    const run = await findOwnRun(req);
    if (!run || !hasSupervisorPlan(run._id)) return res.status(404).json({ message: "Supervisor plan not found." });
    const authorization = authorizationForRun(run, req.user.uid);
    const supervisor = await approveSupervisorPlan({
      run, userUid: req.user.uid, authorization,
      disabledScopes: req.accountConsent?.disabledCapabilities || [], tasks: req.body?.tasks,
    });
    return res.json({ supervisor });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    return next(error);
  }
};

export const pauseSupervisorHandler = async (req, res, next) => {
  try {
    const run = await findOwnRun(req);
    if (!run || !hasSupervisorPlan(run._id)) return res.status(404).json({ message: "Supervisor run not found." });
    if (!pauseSupervisor(run, req.user.uid)) return res.status(409).json({ message: "This supervisor run is not active." });
    return res.json({ message: "Run paused." });
  } catch (error) { return next(error); }
};

export const resumeSupervisorHandler = async (req, res, next) => {
  try {
    const run = await findOwnRun(req);
    if (!run || !hasSupervisorPlan(run._id)) return res.status(404).json({ message: "Supervisor run not found." });
    const authorization = authorizationForRun(run, req.user.uid);
    const supervisor = await resumeSupervisor({
      run, userUid: req.user.uid, authorization,
      disabledScopes: req.accountConsent?.disabledCapabilities || [], clarification: req.body?.clarification || "",
    });
    return res.json({ supervisor });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    return res.status(400).json({ message: error.message || "Could not resume this run." });
  }
};

export const rollbackSupervisorCheckpointHandler = async (req, res, next) => {
  try {
    const run = await findOwnRun(req);
    if (!run || !hasSupervisorPlan(run._id)) return res.status(404).json({ message: "Supervisor run not found." });
    const authorization = authorizationForRun(run, req.user.uid);
    const originalStatus = run.status;
    await rollbackSupervisorCheckpoint({ run, userUid: req.user.uid, taskId: req.params.taskId, authorization, signal: new AbortController().signal });
    updateRun(run._id, { status: originalStatus, pendingApproval: null });
    return res.json({ message: "Checkpoint restored." });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    return res.status(400).json({ message: error.message || "Could not restore this checkpoint." });
  }
};

const findSupervisorSettingsAuthorization = async (req) => {
  const authorization = await findAuthByIdUser(req.params.id, req.user.uid);
  if (!authorization || !authorization.isCurrentlyValid()) return null;
  return authorization;
};

export const getSupervisorProjectSettings = async (req, res, next) => {
  try {
    const authorization = await findSupervisorSettingsAuthorization(req);
    if (!authorization) return res.status(404).json({ message: "Project not found or authorization expired." });
    if (authorization.target.type !== "local") return res.status(400).json({ message: "Supervisor verification settings currently require a local folder project." });
    const settings = getProjectSupervisorSettings(authorization._id, req.user.uid);
    const detected = await findGodotExecutable(settings.godotPath);
    return res.json({ settings: { ...settings, godotPath: settings.godotPath || detected || "" }, godotDetected: Boolean(detected) });
  } catch (error) { return next(error); }
};

export const updateSupervisorProjectSettings = async (req, res, next) => {
  try {
    const authorization = await findSupervisorSettingsAuthorization(req);
    if (!authorization) return res.status(404).json({ message: "Project not found or authorization expired." });
    if (authorization.target.type !== "local") return res.status(400).json({ message: "Supervisor verification settings currently require a local folder project." });
    const body = req.body || {};
    const godotPath = typeof body.godotPath === "string" ? body.godotPath.trim() : "";
    if (godotPath.length > 1024) return res.status(400).json({ message: "Godot path is too long." });
    if (godotPath && !(await fs.stat(godotPath).then((stat) => stat.isFile()).catch(() => false))) return res.status(400).json({ message: "Choose an existing Godot executable file." });
    const godotSmokeFrames = Number(body.godotSmokeFrames ?? 120);
    if (!Number.isInteger(godotSmokeFrames) || godotSmokeFrames < 1 || godotSmokeFrames > 600) return res.status(400).json({ message: "Smoke-run frames must be from 1 to 600." });
    const verifyCommands = body.verifyCommands ?? [];
    if (!Array.isArray(verifyCommands) || verifyCommands.length > 10 || verifyCommands.some((command) => typeof command !== "string" || !command.trim() || command.length > 500 || /[\r\n\u0000]/.test(command))) {
      return res.status(400).json({ message: "Add up to 10 single-line verification commands, each no longer than 500 characters." });
    }
    const settings = setProjectSupervisorSettings(authorization._id, req.user.uid, {
      godotPath, godotSmokeFrames, verifyCommands: [...new Set(verifyCommands.map((command) => command.trim()))],
    });
    return res.json({ settings, godotDetected: Boolean(await findGodotExecutable(godotPath)) });
  } catch (error) { return next(error); }
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
    if (hasSupervisorPlan(run._id) && run.pendingApproval?.childRunId) {
      const resolved = answerSupervisorChildApproval(run, req.user.uid, approvalId, decision, resolveApproval);
      if (!resolved) return res.status(409).json({ message: "This request is no longer waiting for an answer." });
      return res.json({ message: "Thanks. The agent is continuing." });
    }
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
    const runs = listByConversation(req.user.uid, conversation.id).map((run) => syncSupervisorRun(run, req.user.uid));
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

// GET /settings/llm — the current AI provider setup (never returns the key).
export const getLlmSettings = (_req, res) => {
  const cfg = getLlmConfig();
  const profiles = getLlmProfiles();
  const active = activeProvider();
  const activeProfile = profiles.find((profile) => profile.id === active);
  res.json({
    configured: Boolean(active),
    provider: active,
    model: activeProfile?.models?.find((model) => model.enabled !== false)?.id || cfg.model || null,
    accountId: activeProfile?.accountId || cfg.accountId,
    hasKey: Boolean(activeProfile?.apiKey || cfg.apiKey),
    providers: PROVIDER_META,
    catalog: providerCatalog.presets,
    profiles: profiles.map(publicProviderProfile),
    roleModels: getRoleModels(),
    health: providerHealth(),
  });
};

// PUT /settings/llm — save the user's own AI provider + key (stored locally).
export const updateLlmSettings = (req, res) => {
  if (Array.isArray(req.body?.profiles)) {
    const profiles = req.body.profiles;
    if (profiles.length > 50) return res.status(400).json({ message: "Too many provider profiles." });
    const ids = new Set();
    for (const profile of profiles) {
      if (!profile || typeof profile.id !== "string" || !/^[a-z0-9-]{1,64}$/i.test(profile.id) || ids.has(profile.id)) {
        return res.status(400).json({ message: "Each provider needs a unique identifier." });
      }
      ids.add(profile.id);
      const preset = providerCatalog.presets.find((item) => item.id === profile.id);
      if (!preset && profile.kind !== "openai-compatible") return res.status(400).json({ message: "Unknown provider preset." });
      if (profile.models == null) profile.models = [];
      if (!Array.isArray(profile.models) || profile.models.some((m) => !m || typeof m.id !== "string" || !m.id.trim())) return res.status(400).json({ message: "Models must be a list of model IDs, or left empty to use the provider default." });
      if (profile.models.some((m) => !["cheap", "fast", "mid", "best"].includes(m.tier))) return res.status(400).json({ message: "Choose a supported model tier." });
      if (preset?.requiredFields.includes("accountId") && profile.accountId && !/^[a-f0-9]{32}$/i.test(String(profile.accountId))) return res.status(400).json({ message: "Cloudflare needs a 32-character Account ID." });
      if (profile.apiKey && (typeof profile.apiKey !== "string" || profile.apiKey.length > 8192)) return res.status(400).json({ message: "API keys must be no longer than 8192 characters." });
      const base = String(profile.baseUrl || preset?.baseUrl || "").trim();
      let url;
      try { url = new URL(base); } catch { return res.status(400).json({ message: "Enter a valid provider base URL." }); }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
        return res.status(400).json({ message: "Provider URLs must use HTTPS or local loopback HTTP and cannot include credentials, query, or fragment." });
      }
      profile.baseUrl = url.href.replace(/\/+$/, "");
      if (!profile.apiKey) profile.apiKey = getLlmProfiles().find((p) => p.id === profile.id)?.apiKey || "";
      profile.name = String(profile.name || preset?.name || profile.id).slice(0, 80);
      profile.enabled = Boolean(profile.enabled);
      profile.priority = Number.isFinite(profile.priority) ? profile.priority : 0;
    }
    const roleModels = req.body.roles || getRoleModels();
    if (!roleModels || typeof roleModels !== "object" || Array.isArray(roleModels)) return res.status(400).json({ message: "Role model settings must be an object." });
    const validRoles = new Set(["clarifier", "planner", "researcher", "coder", "fixer", "reviewer", "memory-keeper"]);
    for (const [role, pinned] of Object.entries(roleModels)) {
      if (!validRoles.has(role)) return res.status(400).json({ message: "Unknown role in model settings." });
      if (pinned === "auto" || pinned === "") continue;
      const [providerId, modelId] = String(pinned).split(/:(.*)/s, 2);
      const profileModel = profiles.some((p) => p.id === providerId && p.enabled && profileHasRequiredCredentials(p) && p.models.some((m) => m.id === modelId && m.enabled !== false));
      if (!profileModel) return res.status(400).json({ message: `The selected model for ${role} is not configured.` });
    }
    setLlmProfiles(profiles);
    setRoleModels(roleModels);
    resetProviderHealth();
    return res.json({ message: "Provider and role settings saved. Changes apply to the next message.", configured: profiles.some((p) => p.enabled && profileHasRequiredCredentials(p)), profiles: profiles.map(publicProviderProfile) });
  }
  const { provider, apiKey, accountId, model, visionModel } = req.body || {};
  const meta = PROVIDER_META.find((p) => p.id === provider);
  if (!meta) return res.status(400).json({ message: "Choose a supported AI provider." });

  const existing = getLlmConfig();
  const keepingKey = existing.provider === provider && existing.apiKey;
  if (!apiKey && !keepingKey) {
    return res.status(400).json({ message: "Enter your API key." });
  }
  if (meta.needsAccountId && !accountId && !(keepingKey && existing.accountId)) {
    return res.status(400).json({ message: "This provider needs an Account ID." });
  }

  setLlmConfig({ provider, apiKey, accountId, model, visionModel });
  const cfg = getLlmConfig();
  getLlmProfiles(); // migrate this user-entered legacy key into the encrypted profile store
  return res.json({
    message: "AI provider saved. It applies to your next message.",
    configured: Boolean(cfg.provider && cfg.apiKey),
    provider: cfg.provider,
    model: cfg.model,
  });
};

export const testLlmConnection = async (req, res) => {
  const { baseUrl, apiKey, model, provider, accountId } = req.body || {};
  if (typeof baseUrl !== "string") return res.status(400).json({ message: "A provider base URL is required." });
  const requestedModel = typeof model === "string" ? model.trim() : "";
  if (!requestedModel || requestedModel.length > 256) return res.status(400).json({ message: "Enter a model ID of 1–256 characters before testing this provider." });
  if (apiKey != null && (typeof apiKey !== "string" || apiKey.length > 8192)) return res.status(400).json({ message: "API keys must be no longer than 8192 characters." });
  if (typeof provider !== "string" || !providerCatalog.presets.some((item) => item.id === provider)) return res.status(400).json({ message: "Choose a supported provider." });
  let url;
  try { url = new URL(baseUrl); } catch { return res.status(400).json({ message: "Enter a valid provider URL." }); }
  const savedProfile = getLlmProfiles().find((profile) => profile.id === provider);
  const effectiveApiKey = (typeof apiKey === "string" && apiKey.trim()) || savedProfile?.apiKey;
  const effectiveAccountId = accountId || savedProfile?.accountId;
  const preset = providerCatalog.presets.find((item) => item.id === provider);
  if (preset?.requiredFields.includes("apiKey") && !effectiveApiKey) return res.status(400).json({ message: "Enter your own API key before testing this provider." });
  if (provider === "cloudflare") {
    if (!/^[a-f0-9]{32}$/i.test(String(effectiveAccountId || ""))) return res.status(400).json({ message: "Cloudflare needs a 32-character Account ID." });
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${effectiveAccountId}/ai/v1`;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) return res.status(400).json({ message: "Provider URL must use HTTPS or local loopback HTTP." });
  try {
    const response = await axios.post(`${url.href.replace(/\/+$/, "")}/chat/completions`, {
      model: requestedModel,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 8,
      stream: false,
    }, {
      timeout: 15000,
      headers: effectiveApiKey ? { Authorization: `Bearer ${effectiveApiKey}` } : {},
      maxRedirects: 0,
      maxContentLength: 128 * 1024,
      maxBodyLength: 16 * 1024,
    });
    if (!response.data?.choices?.[0]?.message) {
      return res.json({ status: "invalid_response", message: "The provider responded, but did not return a chat completion for this model." });
    }
    let models = [];
    try {
      const modelResponse = await axios.get(`${url.href.replace(/\/+$/, "")}/models`, {
        timeout: 5000,
        headers: effectiveApiKey ? { Authorization: `Bearer ${effectiveApiKey}` } : {},
        maxRedirects: 0,
        maxContentLength: 128 * 1024,
      });
      if (Array.isArray(modelResponse.data?.data)) {
        models = modelResponse.data.data.map((item) => item.id).filter((id) => typeof id === "string").slice(0, 200);
      }
    } catch {
      // Model discovery is optional; a successful chat completion is the test.
    }
    return res.json({ status: "ok", message: "API key and model test succeeded.", models });
  } catch (error) {
    const code = error.response?.status;
    if (code === 401 || code === 403) return res.status(200).json({ status: "invalid_key", message: "The provider rejected this key." });
    if (code === 429) return res.status(200).json({ status: "rate_limited", message: "The provider rate limited the connection test." });
    if (code === 400 || code === 404) return res.status(200).json({ status: "model_unavailable", message: "The provider rejected the model or chat-completions endpoint. Check the model ID and base URL." });
    if (code) return res.status(200).json({ status: "unreachable", message: `Provider returned HTTP ${code}.` });
    return res.status(200).json({ status: "unreachable", message: "Provider could not be reached." });
  }
};

// Tool integrations are separate from model providers: these keys enable
// GitHub repository access and web research/extraction tools.
export const getToolApiSettingsHandler = (_req, res) => {
  const settings = getToolApiSettings();
  res.json({
    github: { hasKey: Boolean(settings.githubToken) },
    tavily: { hasKey: Boolean(settings.tavilyApiKey) },
    crawl4ai: { hasKey: Boolean(settings.crawl4aiApiToken), baseUrl: settings.crawl4aiUrl || "" },
  });
};

export const updateToolApiSettingsHandler = (req, res) => {
  const updates = req.body?.integrations;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) return res.status(400).json({ message: "Integration settings are required." });
  const allowed = new Set(["githubToken", "tavilyApiKey", "crawl4aiApiToken", "crawl4aiUrl"]);
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.has(key)) return res.status(400).json({ message: "Unknown integration setting." });
    if (value !== null && (typeof value !== "string" || value.length > 8192)) return res.status(400).json({ message: "API keys and URLs must be no longer than 8192 characters." });
  }
  if (typeof updates.crawl4aiUrl === "string" && updates.crawl4aiUrl.trim()) {
    let url;
    try { url = new URL(updates.crawl4aiUrl.trim()); } catch { return res.status(400).json({ message: "Enter a valid Crawl4AI URL." }); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) return res.status(400).json({ message: "Crawl4AI must use HTTPS or local loopback HTTP and cannot include credentials, query, or fragment." });
    updates.crawl4aiUrl = url.href.replace(/\/+$/, "");
  }
  try {
    setToolApiSettings(updates);
    return res.json({ message: "Tool integration settings saved.", integrations: getToolApiSettingsHandlerValue() });
  } catch (error) {
    console.error("Could not save encrypted tool integration settings:", error);
    return res.status(500).json({ message: error.message || "Could not save tool integration settings." });
  }
};

const getToolApiSettingsHandlerValue = () => {
  const settings = getToolApiSettings();
  return { github: { hasKey: Boolean(settings.githubToken) }, tavily: { hasKey: Boolean(settings.tavilyApiKey) }, crawl4ai: { hasKey: Boolean(settings.crawl4aiApiToken), baseUrl: settings.crawl4aiUrl || "" } };
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
