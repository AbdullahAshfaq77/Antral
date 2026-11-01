// Calls to the agent service (through the gateway) for agent runs,
// approvals and conversation memory.
import { request } from "./consentApi.js";

export const startRun = ({ target, task, conversationId, attachments, mode }) =>
  request("/agent/runs", { method: "POST", body: { target, task, conversationId, attachments, ...(mode ? { mode } : {}) } });

export const listRuns = () => request("/agent/runs");

export const getRun = (id) => request(`/agent/runs/${id}`);

export const cancelRun = (id) => request(`/agent/runs/${id}/cancel`, { method: "POST" });

export const approveSupervisorPlan = (id, tasks) =>
  request(`/agent/runs/${id}/supervisor/approve`, { method: "POST", body: tasks ? { tasks } : {} });
export const pauseSupervisorRun = (id) => request(`/agent/runs/${id}/supervisor/pause`, { method: "POST" });
export const resumeSupervisorRun = (id, clarification) =>
  request(`/agent/runs/${id}/supervisor/resume`, { method: "POST", body: clarification ? { clarification } : {} });
export const rollbackSupervisorCheckpoint = (id, taskId) =>
  request(`/agent/runs/${id}/supervisor/tasks/${taskId}/rollback`, { method: "POST" });
export const getSupervisorProjectSettings = (authorizationId) =>
  request(`/agent/targets/${authorizationId}/supervisor-settings`);
export const saveSupervisorProjectSettings = (authorizationId, settings) =>
  request(`/agent/targets/${authorizationId}/supervisor-settings`, { method: "PUT", body: settings });

export const answerApproval = (runId, approvalId, decision) =>
  request(`/agent/runs/${runId}/approval`, { method: "POST", body: { approvalId, decision } });

export const listConversations = () => request("/agent/conversations");

export const getConversation = (id) => request(`/agent/conversations/${id}`);

export const deleteConversation = (id) => request(`/agent/conversations/${id}`, { method: "DELETE" });

export const getTools = () => request("/agent/tools");

export const getLimits = () => request("/agent/limits");

export const listApprovals = () => request("/agent/approvals");

export const getAlwaysAllow = (authorizationId) => request(`/agent/targets/${authorizationId}/always-allow`);

export const removeAlwaysAllow = (authorizationId, rule) =>
  request(`/agent/targets/${authorizationId}/always-allow`, { method: "DELETE", body: rule ? { rule } : {} });

// Deletes a project: revokes its authorization and forgets all of its chats.
export const deleteProject = (authorizationId) => request(`/agent/projects/${authorizationId}`, { method: "DELETE" });

export const getDeviceStatus = () => request("/agent/devices");

// Opens a live Server-Sent Events stream of a run's text as the model generates
// it. Returns the EventSource (call .close() to stop). Same-origin, so the
// session cookie is sent automatically.
const API_BASE = import.meta.env.VITE_API_URL || "/api";
export const openRunStream = (id, { onText, onDone, onError } = {}) => {
  const es = new EventSource(`${API_BASE}/agent/runs/${id}/stream`, { withCredentials: true });
  es.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.type === "init") onText?.(data.result || "");
    else if (data.type === "text") onText?.(data.text || "");
    else if (data.type === "done") {
      onDone?.(data);
      es.close();
    }
  };
  es.onerror = () => {
    onError?.();
    es.close();
  };
  return es;
};
