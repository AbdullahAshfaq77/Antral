import { kvGet } from "../../../shared/localdb.js";

// Must match the auth service's session cookie name and key layout.
const SESSION_COOKIE = "antral_session";
const sessionKey = (sessionId) => `session:${sessionId}`;

const getSessionId = (req) => {
  const cookieHeader = req.headers.cookie || "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const sessionId = cookie?.slice(SESSION_COOKIE.length + 1);
  return sessionId && /^[a-f0-9]{64}$/.test(sessionId) ? sessionId : null;
};

// Resolves the logged-in user from the shared session store and attaches it as
// req.user = { uid, email }. Rejects the request if there is no valid session.
export const attachUser = async (req, res, next) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) {
      return res.status(401).json({ message: "Please sign in to continue." });
    }

    const raw = kvGet(sessionKey(sessionId));
    if (!raw) {
      return res.status(401).json({ message: "Your session has expired. Please sign in again." });
    }

    const session = JSON.parse(raw);
    if (!session?.uid) {
      return res.status(401).json({ message: "Please sign in again to continue." });
    }

    req.user = { uid: session.uid, email: session.email || "" };
    return next();
  } catch (error) {
    return next(error);
  }
};

// The client IP and user agent, recorded with each consent as proof.
export const requestAudit = (req) => ({
  ip:
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "",
  userAgent: (req.headers["user-agent"] || "").toString().slice(0, 500),
});
