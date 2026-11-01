import { findConsent, findAuthById } from "../../data/consent.js";
import { missingAccountDocuments } from "../../middleware/requireConsent.js";
import { effectiveScopes } from "../policies.js";
import { getTool } from "./tools/index.js";
import { redactSecrets } from "./redact.js";
import { requestApproval } from "./approvals.js";
import { roleAllowsTool } from "./roles.js";

const MAX_RESULT_CHARS = 30_000;

export const requiresUserApproval = (tool, target) =>
  tool.mutating || (target?.type === "computer" && tool.name.startsWith("run_"));

// The "Always allow" rule this call would save/match (same idea as Claude
// Code's "don't ask again"). Read-only commands share one rule per tool.
export const approvalRuleFor = (tool, args) => {
  if (tool.ruleFor) return tool.ruleFor(args);
  return tool.mutating ? null : tool.name;
};

// Re-checks consent at the moment of each tool call — not just when the run
// started — so revoking a target, withdrawing consent or flipping a
// kill-switch stops a run that is already in progress.
// Returns { denial } or { auth }.
const checkPermission = async ({ userUid, authorizationId, scope }) => {
  const consent = findConsent(userUid);
  const auth = findAuthById(authorizationId);
  if (missingAccountDocuments(consent).length) return { denial: "Account consent is no longer active." };
  if (!auth || auth.userUid !== userUid || !auth.isCurrentlyValid()) {
    return { denial: "The target authorization was revoked or has expired." };
  }
  if (scope === null) return { auth }; // touches no system resource
  if (!effectiveScopes(auth).includes(scope)) return { denial: `Permission "${scope}" is not granted for this target.` };
  if ((consent.disabledCapabilities || []).includes(scope)) return { denial: `Capability "${scope}" is turned off.` };
  return { auth };
};

const DECLINE_MESSAGES = {
  decline:
    "The user declined this action. Do not retry it. Continue another way, or explain what you would have done and why.",
  expired: "No answer from the user within 30 minutes, so this action was declined. Do not retry it.",
  cancelled: "The run was cancelled.",
};

// Runs one tool call requested by the model. Never throws: failures are
// returned as text so the model can see what went wrong and adjust.
// Returns { ok, denied, content, durationMs }.
export const executeToolCall = async ({ name, args, run, ctx }) => {
  const started = Date.now();
  const tool = getTool(name);
  const elapsed = () => Date.now() - started;

  if (!tool || !run.toolsOffered.includes(name)) {
    return { ok: false, denied: true, content: `Tool "${name}" is not available in this run.`, durationMs: 0 };
  }
  if (run.roleConfig && !roleAllowsTool(run.roleConfig, name)) {
    return { ok: false, denied: true, content: `Tool "${name}" is outside the active role's capabilities.`, durationMs: elapsed() };
  }
  if (["coder", "fixer"].includes(run.roleConfig?.id) && ["write_file", "edit_file", "make_directory"].includes(name)) {
    return { ok: false, denied: true, content: `The ${run.roleConfig.id} role must use apply_task_patch for planned file changes.`, durationMs: elapsed() };
  }
  if (["coder", "fixer"].includes(run.roleConfig?.id) && name === "apply_task_patch") {
    const requested = String(args?.path || "").replace(/\\/g, "/").replace(/^\.\//, "");
    const allowed = run.roleAllowedFiles || [];
    const matches = allowed.some((file) => file === requested);
    if (!matches) return { ok: false, denied: true, content: `Coder may edit only files listed in the active task: ${allowed.join(", ") || "none"}.`, durationMs: elapsed() };
  }
  if (["coder", "fixer", "reviewer"].includes(run.roleConfig?.id) && name === "read_file") {
    const requested = String(args?.path || "").replace(/\\/g, "/").replace(/^\.\//, "");
    const allowed = run.roleAllowedFiles || [];
    if (!allowed.includes(requested)) return { ok: false, denied: true, content: `This role may read only files declared in the task context: ${allowed.join(", ") || "none"}.`, durationMs: elapsed() };
  }
  if (run.roleConfig?.id === "memory-keeper" && ["write_file", "edit_file"].includes(name)) {
    const path = String(args?.path || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!(path.toLowerCase() === "project.md" || /^repo-map\/.*(?:index|map).*(?:\.md|\.json|\.txt)?$/i.test(path))) {
      return { ok: false, denied: true, content: "Memory keeper can write only PROJECT.md and repository map/index files.", durationMs: elapsed() };
    }
  }

  const permission = { userUid: run.userUid, authorizationId: run.authorizationId, scope: tool.scope };
  let { denial, auth } = await checkPermission(permission);
  if (denial) return { ok: false, denied: true, content: `Denied: ${denial}`, durationMs: elapsed() };

  // Changes and commands ask first unless the user saved an "Always allow"
  // rule for this target that covers the call.
  const needsApproval = requiresUserApproval(tool, run.target);
  if (needsApproval) {
    const rule = approvalRuleFor(tool, args);
    if (!(rule && auth.alwaysAllow.includes(rule))) {
      const decision = await requestApproval({
        run,
        tool: name,
        args,
        summary: tool.describe ? tool.describe(args) : name,
        rule,
        signal: ctx.signal,
      });
      if (decision !== "allow_once" && decision !== "allow_always") {
        return { ok: false, denied: true, content: DECLINE_MESSAGES[decision], durationMs: elapsed() };
      }
      // Permissions may have changed while the run was waiting.
      ({ denial } = await checkPermission(permission));
      if (denial) return { ok: false, denied: true, content: `Denied: ${denial}`, durationMs: elapsed() };
    }
  }

  try {
    const result = await tool.run(args || {}, ctx);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const clipped = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… truncated` : text;
    return { ok: true, denied: false, content: redactSecrets(clipped), durationMs: elapsed() };
  } catch (error) {
    return { ok: false, denied: false, content: redactSecrets(`Error: ${error.message}`), durationMs: elapsed() };
  }
};
