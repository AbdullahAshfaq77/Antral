// Verifies Firebase ID tokens WITHOUT the Firebase Admin private key, using
// Google's public certificates. This lets the desktop app ship with no secret:
// Google/GitHub/email sign-in all happen client-side via the Firebase SDK, and
// the backend only checks the resulting ID token's signature and claims.
import { readFileSync } from "node:fs";
import { importX509, jwtVerify, decodeProtectedHeader } from "jose";

const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let certs = null;
let certsExpireAt = 0;

const loadCerts = async () => {
  if (certs && Date.now() < certsExpireAt) return certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Could not fetch Google signing certificates (${res.status}).`);
  const data = await res.json(); // { "<kid>": "-----BEGIN CERTIFICATE-----..." }
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") || "");
  certsExpireAt = Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000;
  certs = data;
  return certs;
};

// The Firebase project id (NOT a secret — it's in the frontend bundle too).
// From FIREBASE_PROJECT_ID, or a shipped config/firebase-public.json.
let cachedProjectId;
const projectId = () => {
  if (cachedProjectId !== undefined) return cachedProjectId;
  cachedProjectId = (process.env.FIREBASE_PROJECT_ID || "").trim() || null;
  if (!cachedProjectId) {
    try {
      const file = new URL("./firebase-public.json", import.meta.url);
      cachedProjectId = JSON.parse(readFileSync(file, "utf8")).projectId || null;
    } catch {
      cachedProjectId = null;
    }
  }
  return cachedProjectId;
};

// Returns { uid, email, firebase } like the admin SDK's verifyIdToken, or
// throws. Errors get a `.code` so the caller can map them to a 401.
export const verifyIdToken = async (token) => {
  const pid = projectId();
  if (!pid) {
    throw new Error("FIREBASE_PROJECT_ID is not set (or config/firebase-public.json is missing).");
  }

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    const e = new Error("Malformed token.");
    e.code = "auth/invalid-id-token";
    throw e;
  }
  if (header.alg !== "RS256") {
    const e = new Error("Unexpected token algorithm.");
    e.code = "auth/invalid-id-token";
    throw e;
  }

  const all = await loadCerts();
  const pem = all[header.kid];
  if (!pem) {
    const e = new Error("Unknown token signing key.");
    e.code = "auth/invalid-id-token";
    throw e;
  }

  try {
    const key = await importX509(pem, "RS256");
    const { payload } = await jwtVerify(token, key, {
      issuer: `https://securetoken.google.com/${pid}`,
      audience: pid,
    });
    if (!payload.sub) {
      const e = new Error("Invalid token subject.");
      e.code = "auth/invalid-id-token";
      throw e;
    }
    return {
      uid: payload.sub,
      email: payload.email,
      firebase: payload.firebase,
    };
  } catch (error) {
    if (!error.code) {
      error.code = /exp/i.test(error.message) ? "auth/id-token-expired" : "auth/invalid-id-token";
    }
    throw error;
  }
};
