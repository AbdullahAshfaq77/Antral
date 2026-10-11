import crypto from "node:crypto";
import { updateRun } from "../../data/agentRuns.js";
import { addAlwaysAllow } from "../../data/consent.js";
import { logStep } from "./runLog.js";
import { redactSecrets } from "./redact.js";

// Allow once / Always allow / Decline — the same model as Claude Code's
// permission prompts. When the agent wants to change something, the run pauses
// in the background with a pending approval; the user answers from the UI
// whenever they're ready and the run picks up from there.

export const DECISIONS = ["allow_once", "allow_always", "decline"];
const APPROVAL_TTL_MS = 30 * 60 * 1000; // unanswered for 30 min -> declined

// runId -> { id, resolve }
const waiting = new Map();

const redactArgs = (args) => JSON.parse(redactSecrets(JSON.stringify(args ?? {})));

// Pauses the run until the user decides. Resolves to one of DECISIONS, or
// "expired" / "cancelled".
export const requestApproval = async ({ run, tool, args, summary, rule, signal }) => {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  const pending = { id, tool, summary, args: redactArgs(args), rule, requestedAt: new Date(), expiresAt };

  updateRun(run._id, { status: "awaiting_approval", pendingApproval: pending });
  await logStep(run._id, { kind: "approval_request", tool, args: pending.args, content: summary });

  const decision = await new Promise((resolve) => {
    const done = (d) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      waiting.delete(String(run._id));
      resolve(d);
    };
    const onAbort = () => done("cancelled");
    const timer = setTimeout(() => done("expired"), APPROVAL_TTL_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.set(String(run._id), { id, resolve: done });
  });

  if (decision === "allow_always" && rule) {
    addAlwaysAllow(run.authorizationId, rule);
  }
  if (decision !== "cancelled") {
    updateRun(run._id, { status: "running", pendingApproval: null });
  }
  await logStep(run._id, {
    kind: "approval",
    tool,
    ok: decision === "allow_once" || decision === "allow_always",
    content:
      decision === "allow_always" && rule
        ? `allow_always (saved rule "${rule}")`
        : decision,
  });
  return decision;
};

// Called from the API when the user answers. Returns false if that approval
// is no longer waiting (already answered, expired, or the run stopped).
export const resolveApproval = (runId, approvalId, decision) => {
  const entry = waiting.get(String(runId));
  if (!entry || entry.id !== approvalId) return false;
  entry.resolve(decision);
  return true;
};
