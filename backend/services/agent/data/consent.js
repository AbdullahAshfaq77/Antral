// Account consent + target authorizations in the shared local SQLite database
// (replaces the Mongoose AccountConsent and TargetAuthorization models). The
// returned objects keep the same shape and instance methods the call sites use
// (consent.versionOf(id), auth.isCurrentlyValid()).
import crypto from "node:crypto";
import { db } from "../../../shared/localdb.js";

const nowMs = () => Date.now();
const toDate = (ms) => (ms == null ? null : new Date(Number(ms)));
const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// AccountConsent
// ---------------------------------------------------------------------------
const toConsent = (row) => {
  if (!row) return null;
  const accepted = parse(row.accepted, []);
  return {
    _id: row.user_uid,
    userUid: row.user_uid,
    userEmail: row.user_email || "",
    accepted,
    status: row.status || "active",
    withdrawnAt: toDate(row.withdrawn_at),
    disabledCapabilities: parse(row.disabled_capabilities, []),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    versionOf(documentId) {
      const entry = accepted.find((a) => a.documentId === documentId);
      return entry ? entry.version : null;
    },
  };
};

const _getConsent = db.prepare("SELECT * FROM account_consent WHERE user_uid = ?");

export const findConsent = (userUid) => toConsent(_getConsent.get(userUid));

// Upsert used when accepting policies: replaces the accepted set + status.
export const upsertAccountConsent = (userUid, { userEmail, accepted, status, withdrawnAt, ip, userAgent }) => {
  const now = nowMs();
  db.prepare(`
    INSERT INTO account_consent (user_uid, user_email, accepted, status, withdrawn_at, disabled_capabilities, ip, user_agent, created_at, updated_at)
    VALUES (@uid, @email, @accepted, @status, @withdrawnAt, '[]', @ip, @ua, @now, @now)
    ON CONFLICT(user_uid) DO UPDATE SET
      user_email = excluded.user_email,
      accepted = excluded.accepted,
      status = excluded.status,
      withdrawn_at = excluded.withdrawn_at,
      ip = excluded.ip,
      user_agent = excluded.user_agent,
      updated_at = excluded.updated_at
  `).run({
    uid: userUid,
    email: userEmail || "",
    accepted: JSON.stringify(accepted || []),
    status: status || "active",
    withdrawnAt: withdrawnAt ? withdrawnAt.getTime() : null,
    ip: ip || "",
    ua: userAgent || "",
    now,
  });
  return findConsent(userUid);
};

export const withdrawConsent = (userUid) => {
  db.prepare("UPDATE account_consent SET status = 'withdrawn', withdrawn_at = ?, updated_at = ? WHERE user_uid = ?")
    .run(nowMs(), nowMs(), userUid);
  return findConsent(userUid);
};

// Returns the updated consent, or null if the user has none yet.
export const setDisabledCapabilities = (userUid, list) => {
  const res = db
    .prepare("UPDATE account_consent SET disabled_capabilities = ?, updated_at = ? WHERE user_uid = ?")
    .run(JSON.stringify([...new Set(list)]), nowMs(), userUid);
  return res.changes ? findConsent(userUid) : null;
};

export const addDisabledCapability = (userUid, scope) => {
  const c = findConsent(userUid);
  if (!c) return null;
  if (!c.disabledCapabilities.includes(scope)) {
    return setDisabledCapabilities(userUid, [...c.disabledCapabilities, scope]);
  }
  return c;
};

export const removeDisabledCapability = (userUid, scope) => {
  const c = findConsent(userUid);
  if (!c) return null;
  return setDisabledCapabilities(userUid, c.disabledCapabilities.filter((s) => s !== scope));
};

// ---------------------------------------------------------------------------
// TargetAuthorization
// ---------------------------------------------------------------------------
const toAuth = (row) => {
  if (!row) return null;
  const expiresAt = toDate(row.expires_at);
  return {
    _id: row.id,
    userUid: row.user_uid,
    target: { type: row.target_type, identifier: row.target_id, label: row.target_label || "" },
    attestation: { ownershipConfirmed: !!row.attestation_owner, basis: row.attestation_basis },
    scopes: parse(row.scopes, []),
    alwaysAllow: parse(row.always_allow, []),
    authorizationVersion: row.authorization_version,
    status: row.status || "active",
    expiresAt,
    revokedAt: toDate(row.revoked_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    isCurrentlyValid() {
      return this.status === "active" && this.expiresAt instanceof Date && this.expiresAt > new Date();
    },
  };
};

const _getAuthById = db.prepare("SELECT * FROM target_authorization WHERE id = ?");
const _getAuthByTarget = db.prepare(
  "SELECT * FROM target_authorization WHERE user_uid = ? AND target_type = ? AND target_id = ?",
);

export const findAuthById = (id) => toAuth(_getAuthById.get(id));

export const findAuthByIdUser = (id, userUid) => {
  const a = toAuth(_getAuthById.get(id));
  return a && a.userUid === userUid ? a : null;
};

export const findAuthForTarget = (userUid, type, identifier) =>
  toAuth(_getAuthByTarget.get(userUid, type, identifier));

export const findActiveAuthForTarget = (userUid, type, identifier) => {
  const a = toAuth(_getAuthByTarget.get(userUid, type, identifier));
  return a && a.status === "active" ? a : null;
};

export const listAuthByUser = (userUid, { excludeRevoked = false } = {}) => {
  const rows = excludeRevoked
    ? db.prepare("SELECT * FROM target_authorization WHERE user_uid = ? AND status != 'revoked' ORDER BY created_at DESC").all(userUid)
    : db.prepare("SELECT * FROM target_authorization WHERE user_uid = ? ORDER BY created_at DESC").all(userUid);
  return rows.map(toAuth);
};

// Create or replace the active authorization for a target (re-authorizing
// overwrites the existing record for that user+target).
export const upsertAuthorization = (userUid, { target, attestation, scopes, authorizationVersion, expiresAt, ip, userAgent }) => {
  const existing = _getAuthByTarget.get(userUid, target.type, target.identifier);
  const now = nowMs();
  const id = existing ? existing.id : crypto.randomUUID();
  db.prepare(`
    INSERT INTO target_authorization
      (id, user_uid, target_type, target_id, target_label, attestation_owner, attestation_basis,
       scopes, always_allow, authorization_version, status, expires_at, revoked_at, ip, user_agent, created_at, updated_at)
    VALUES
      (@id, @uid, @type, @identifier, @label, 1, @basis,
       @scopes, @alwaysAllow, @ver, 'active', @expiresAt, NULL, @ip, @ua, @createdAt, @now)
    ON CONFLICT(id) DO UPDATE SET
      target_label = excluded.target_label,
      attestation_basis = excluded.attestation_basis,
      scopes = excluded.scopes,
      authorization_version = excluded.authorization_version,
      status = 'active',
      expires_at = excluded.expires_at,
      revoked_at = NULL,
      ip = excluded.ip,
      user_agent = excluded.user_agent,
      updated_at = excluded.updated_at
  `).run({
    id,
    uid: userUid,
    type: target.type,
    identifier: target.identifier,
    label: target.label || "",
    basis: attestation.basis,
    scopes: JSON.stringify([...new Set(scopes)]),
    alwaysAllow: JSON.stringify(existing ? parse(existing.always_allow, []) : []),
    ver: authorizationVersion,
    expiresAt: expiresAt.getTime(),
    ip: ip || "",
    ua: userAgent || "",
    createdAt: existing ? existing.created_at : now,
    now,
  });
  return findAuthById(id);
};

// Returns updated auth, or null if no matching active record.
export const updateAuthScopes = (id, userUid, scopes) => {
  const res = db
    .prepare("UPDATE target_authorization SET scopes = ?, updated_at = ? WHERE id = ? AND user_uid = ? AND status = 'active'")
    .run(JSON.stringify([...new Set(scopes)]), nowMs(), id, userUid);
  return res.changes ? findAuthById(id) : null;
};

export const revokeAuth = (id, userUid) => {
  const res = db
    .prepare("UPDATE target_authorization SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND user_uid = ? AND status != 'revoked'")
    .run(nowMs(), nowMs(), id, userUid);
  return res.changes ? findAuthById(id) : null;
};

const setScopes = (id, scopes) =>
  db.prepare("UPDATE target_authorization SET scopes = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify([...new Set(scopes)]), nowMs(), id);

export const addAuthScope = (id, scope) => {
  const a = findAuthById(id);
  if (a) setScopes(id, [...a.scopes, scope]);
};
export const removeAuthScope = (id, scope) => {
  const a = findAuthById(id);
  if (a) setScopes(id, a.scopes.filter((s) => s !== scope));
};

export const setAlwaysAllow = (id, rules) =>
  db.prepare("UPDATE target_authorization SET always_allow = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(rules), nowMs(), id);

export const addAlwaysAllow = (id, rule) => {
  const a = findAuthById(id);
  if (a && !a.alwaysAllow.includes(rule)) setAlwaysAllow(id, [...a.alwaysAllow, rule]);
};

export const setAuthStatus = (id, status, { revokedAt } = {}) =>
  db.prepare("UPDATE target_authorization SET status = ?, revoked_at = ?, updated_at = ? WHERE id = ?")
    .run(status, revokedAt ? revokedAt.getTime() : null, nowMs(), id);
