// Calls to the auth service (through the gateway) for session + profile.
// Email/Google/GitHub sign-in happen client-side via the Firebase SDK; the
// backend only exchanges a verified Firebase ID token for a session.
const API_URL = import.meta.env.VITE_API_URL || "/api";

async function sessionRequest(path, { token, method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }

  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || "Something went wrong. Please try again.");
    error.status = res.status;
    throw error;
  }
  return data;
}

export const startSession = (token) =>
  sessionRequest("/auth/session", { token, method: "POST" });

export const endSession = () => sessionRequest("/auth/session", { method: "DELETE" });

export const getProfile = () => sessionRequest("/auth/profile");

export const saveProfile = (profile) =>
  sessionRequest("/auth/profile", { method: "PUT", body: profile });
