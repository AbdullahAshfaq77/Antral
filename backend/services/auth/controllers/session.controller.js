import { getAuth } from "firebase-admin/auth";
import { app } from "../config/firebase.js";
import { getUserByUid } from "../data/users.js";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  getSessionId,
  readSession,
  setSessionCookie,
} from "../utils/sessions.js";

const verifyFirebaseToken = async (req, res) => {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer (.+)$/i);
  if (!match) {
    res.status(401).json({ message: "Please sign in again to continue." });
    return null;
  }

  try {
    return await getAuth(app).verifyIdToken(match[1]);
  } catch (error) {
    if (["auth/argument-error", "auth/id-token-expired", "auth/invalid-id-token"].includes(error.code)) {
      res.status(401).json({ message: "Your sign-in has expired. Please sign in again." });
      return null;
    }
    throw error;
  }
};

export const startSession = async (req, res) => {
  const identity = await verifyFirebaseToken(req, res);
  if (!identity) return;
  if (!identity.email) {
    return res.status(400).json({ message: "Your account needs an email address to continue." });
  }

  const sessionId = getSessionId(req);
  await deleteSession(sessionId);

  const user = getUserByUid(identity.uid);
  const session = {
    uid: identity.uid,
    email: identity.email || "",
    provider:
      identity.firebase?.sign_in_provider === "google.com"
        ? "google"
        : identity.firebase?.sign_in_provider === "github.com"
          ? "github"
          : "email",
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
    dateOfBirth: user?.dateOfBirth || "",
    createdAt: new Date().toISOString(),
  };

  setSessionCookie(res, await createSession(session));
  return res.json({ message: "Session started." });
};

export const endSession = async (req, res) => {
  await deleteSession(getSessionId(req));
  clearSessionCookie(res);
  return res.status(204).end();
};

export const requireSession = async (req, res, next) => {
  const sessionId = getSessionId(req);
  const session = await readSession(sessionId);
  if (!session) {
    clearSessionCookie(res);
    return res.status(401).json({ message: "Your session has expired. Please sign in again." });
  }

  req.sessionId = sessionId;
  req.session = session;
  return next();
};
