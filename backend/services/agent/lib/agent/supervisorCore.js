const normalizePath = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
const validPath = (value) => {
  const normalized = normalizePath(value);
  return Boolean(normalized && !normalized.startsWith("/") && !/^[a-z]:/i.test(normalized) && !normalized.includes(":") && !normalized.split("/").some((part) => part === "..") && !/[\u0000-\u001f]/.test(normalized));
};

export const parseJsonObject = (value) => {
  if (typeof value !== "string") throw new Error("The model did not return text.");
  const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Expected one JSON object in the model response.");
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw new Error("The model response is not valid JSON.");
  }
};

export const validatePlan = (value, { verifyCommands = [] } = {}) => {
  const plan = typeof value === "string" ? parseJsonObject(value) : value;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Plan must be a JSON object.");
  if (typeof plan.title !== "string" || !plan.title.trim() || plan.title.length > 160) throw new Error("Plan title must contain 1–160 characters.");
  if (typeof plan.summary !== "string" || !plan.summary.trim() || plan.summary.length > 2000) throw new Error("Plan summary must contain 1–2000 characters.");
  if (!Array.isArray(plan.tasks) || plan.tasks.length < 1 || plan.tasks.length > 12) throw new Error("Plan must contain 1–12 tasks.");
  const allowedCommands = new Set(verifyCommands);
  const tasks = plan.tasks.map((task, index) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`Task ${index + 1} must be an object.`);
    for (const field of ["title", "goal", "acceptance_check"]) {
      if (typeof task[field] !== "string" || !task[field].trim() || task[field].length > (field === "goal" ? 2000 : 500)) {
        throw new Error(`Task ${index + 1} needs a valid ${field}.`);
      }
    }
    for (const field of ["files_to_read", "files_to_edit"]) {
      if (!Array.isArray(task[field]) || task[field].length > 30 || task[field].some((file) => !validPath(file))) {
        throw new Error(`Task ${index + 1} has invalid ${field} paths.`);
      }
      task[field] = [...new Set(task[field].map(normalizePath))];
    }
    if (task.files_to_edit.length < 1) throw new Error(`Task ${index + 1} must list at least one file_to_edit.`);
    const verifyCommand = task.verify_command == null ? "" : String(task.verify_command).trim();
    if (verifyCommand && !allowedCommands.has(verifyCommand)) throw new Error(`Task ${index + 1} uses a verification command that is not configured for this project.`);
    return {
      title: task.title.trim(), goal: task.goal.trim(), files_to_read: task.files_to_read,
      files_to_edit: task.files_to_edit, acceptance_check: task.acceptance_check.trim(), verify_command: verifyCommand,
    };
  });
  return { title: plan.title.trim(), summary: plan.summary.trim(), tasks };
};

export const validateReview = (value) => {
  const review = typeof value === "string" ? parseJsonObject(value) : value;
  if (!review || !["approved", "changes-needed"].includes(review.verdict)) throw new Error("Reviewer verdict must be approved or changes-needed.");
  if (typeof review.summary !== "string" || !review.summary.trim()) throw new Error("Reviewer summary is required.");
  if (review.issues != null && (!Array.isArray(review.issues) || review.issues.some((issue) => typeof issue !== "string"))) throw new Error("Reviewer issues must be a list of strings.");
  return { verdict: review.verdict, summary: review.summary.trim(), issues: review.issues || [] };
};

export const validatePatches = (value, allowedFiles) => {
  const result = typeof value === "string" ? parseJsonObject(value) : value;
  if (!Array.isArray(result?.patches) || result.patches.length < 1 || result.patches.length > 30) throw new Error("Coder response must contain 1–30 patches.");
  const allowed = new Set((allowedFiles || []).map(normalizePath));
  let bytes = 0;
  return result.patches.map((patch, index) => {
    const file = normalizePath(patch?.path);
    if (!validPath(file) || !allowed.has(file)) throw new Error(`Patch ${index + 1} is outside the task's files_to_edit list.`);
    const isNew = typeof patch.new_file_content === "string";
    if (isNew ? (patch.old_text != null || patch.new_text != null) : (typeof patch.old_text !== "string" || !patch.old_text || typeof patch.new_text !== "string")) {
      throw new Error(`Patch ${index + 1} must use exact old_text/new_text or new_file_content for a new file.`);
    }
    bytes += Buffer.byteLength(isNew ? patch.new_file_content : patch.old_text + patch.new_text);
    if (bytes > 1_000_000) throw new Error("Coder response exceeds the 1 MB patch limit.");
    return isNew
      ? { path: file, new_file_content: patch.new_file_content }
      : { path: file, old_text: patch.old_text, new_text: patch.new_text };
  });
};

// Planner repair/failover policy. The model adapters are injected so this
// control path can be tested without network calls.
export const requestValidatedPlan = async ({ generate, repair, failover, verifyCommands = [] }) => {
  const attempts = [];
  const validate = (response) => {
    attempts.push(response);
    return validatePlan(response?.result, { verifyCommands });
  };
  const first = await generate();
  try { return { plan: validate(first), source: first, attempts }; }
  catch (firstError) {
    const second = await repair({ previous: first, error: firstError.message });
    try { return { plan: validate(second), source: second, attempts }; }
    catch (repairError) {
      if (!failover) throw new Error(`Planner response and repair were invalid: ${repairError.message}`);
      const excludedProviders = [...new Set([first?.provider, second?.provider].filter(Boolean))];
      const fallback = await failover({ previous: second, error: repairError.message, excludedProviders });
      try { return { plan: validate(fallback), source: fallback, attempts }; }
      catch (fallbackError) { throw new Error(`Planner response, repair, and provider fallback were invalid: ${fallbackError.message}`); }
    }
  }
};

export const nextFixAction = ({ fixerAttempts, replans, maxFixerAttempts = 3, maxReplans = 2 }) => {
  if (fixerAttempts < maxFixerAttempts) return "fix";
  if (replans < maxReplans) return "replan";
  return "blocked";
};

export const canResumeSupervisor = ({ supervisorStatus, runStatus, lastError = "" }) => {
  if (!("paused interrupted blocked stopped".split(" ").includes(supervisorStatus) || runStatus === "interrupted")) return false;
  return !/(?:model-call|token|30-minute).*(?:limit|reached)/i.test(lastError);
};

// Small model-adapter workflow used by deterministic orchestration tests. Its
// limits and decision function are shared with the persisted supervisor.
export const runMockableTaskPipeline = async ({ coder, fixer, verify, review, replan, checkpoint, maxFixerAttempts = 3, maxReplans = 2 }) => {
  let replans = 0;
  let lastError = "";
  while (true) {
    await coder({ replans });
    let verdict = await verify();
    if (verdict?.ok) {
      const reviewed = await review();
      if (reviewed?.approved) {
        await checkpoint();
        return { status: "completed", replans, fixerAttempts: 0 };
      }
      lastError = reviewed?.error || "Reviewer requested changes.";
    } else lastError = verdict?.error || "Verification failed.";
    let fixerAttempts = 0;
    while (fixerAttempts < maxFixerAttempts) {
      await fixer({ attempt: fixerAttempts + 1, error: lastError });
      fixerAttempts += 1;
      verdict = await verify();
      if (!verdict?.ok) { lastError = verdict?.error || "Verification failed."; continue; }
      const reviewed = await review();
      if (reviewed?.approved) {
        await checkpoint();
        return { status: "completed", replans, fixerAttempts };
      }
      lastError = reviewed?.error || "Reviewer requested changes.";
    }
    const disposition = nextFixAction({ fixerAttempts, replans, maxFixerAttempts, maxReplans });
    if (disposition === "blocked") return { status: "blocked", replans, fixerAttempts, error: lastError };
    const next = await replan({ replans: replans + 1, error: lastError });
    if (!next) return { status: "blocked", replans, fixerAttempts, error: lastError };
    replans += 1;
  }
};

export const renderPlanMarkdown = (plan) => [
  `# ${plan.title}`, "", plan.summary, "", "## Tasks", "",
  ...plan.tasks.flatMap((task, index) => [
    `### ${index + 1}. ${task.title}`, "", task.goal, "",
    `- Files to read: ${task.files_to_read.join(", ") || "None listed"}`,
    `- Files to edit: ${task.files_to_edit.join(", ")}`,
    `- Acceptance check: ${task.acceptance_check}`,
    `- Verification: ${task.verify_command || "Project verifier / unconfigured"}`, "",
  ]),
].join("\n");

export const withinBudget = ({ startedAt, deadlineAt, modelCalls, tokenCount }, { maxCalls = 32, maxTokens = 120_000, now = Date.now() } = {}) => {
  if (now >= deadlineAt) return { ok: false, reason: "The supervisor reached its wall-time limit." };
  if (modelCalls >= maxCalls) return { ok: false, reason: "The supervisor reached its model-call limit." };
  if (tokenCount >= maxTokens) return { ok: false, reason: "The supervisor reached its token limit." };
  return { ok: true };
};

export { normalizePath, validPath };
