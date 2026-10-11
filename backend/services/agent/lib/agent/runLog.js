import { appendStep, updateRun } from "../../data/agentRuns.js";

const MAX_LOG_CHARS = 20_000;

// Appends one entry to a run's audit log. Async so existing callers that do
// `await logStep(...)` or `logStep(...).catch(...)` keep working.
export const logStep = async (runId, step) => {
  const entry = { ...step, at: new Date() };
  if (typeof entry.content === "string" && entry.content.length > MAX_LOG_CHARS) {
    entry.content = `${entry.content.slice(0, MAX_LOG_CHARS)}\n… truncated`;
  }
  appendStep(runId, entry);
};

export const finishRun = async (runId, fields) =>
  updateRun(runId, { ...fields, pendingApproval: null, finishedAt: new Date() });
