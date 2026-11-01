// Calls to the agent service (through the gateway) for policies and consent.
const API_URL = import.meta.env.VITE_API_URL || "/api";

export async function request(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }

  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || "Something went wrong. Please try again.");
    error.status = res.status;
    error.payload = data;
    throw error;
  }
  return data;
}

export const getPolicies = () => request("/agent/consent/policies");

export const getConsentStatus = () => request("/agent/consent/status");

// AI provider setup (the user's own API key, stored locally on their machine).
export const getLlmSettings = () => request("/agent/settings/llm");

export const setLlmSettings = (body) => request("/agent/settings/llm", { method: "PUT", body });
export const testLlmConnection = (body) => request("/agent/settings/llm/test", { method: "POST", body });
export const getToolApiSettings = () => request("/agent/settings/integrations");
export const setToolApiSettings = (integrations) => request("/agent/settings/integrations", { method: "PUT", body: { integrations } });

export const acceptAccountPolicies = (versions) =>
  request("/agent/consent/account", { method: "POST", body: { versions } });

export const withdrawAccountConsent = () =>
  request("/agent/consent/account", { method: "DELETE" });

export const authorizeTarget = (authorization) =>
  request("/agent/consent/target", { method: "POST", body: authorization });

export const updateTargetScopes = (id, scopes) =>
  request(`/agent/consent/target/${id}`, { method: "PATCH", body: { scopes } });

export const revokeTargetAuthorization = (id) =>
  request(`/agent/consent/target/${id}`, { method: "DELETE" });

export const setDisabledCapabilities = (disabled) =>
  request("/agent/consent/capabilities", { method: "PUT", body: { disabled } });
