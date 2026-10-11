import {
  findConsent,
  listAuthByUser,
  upsertAccountConsent,
  withdrawConsent,
  setDisabledCapabilities as setDisabledCaps,
  upsertAuthorization,
  updateAuthScopes,
  revokeAuth,
} from "../data/consent.js";
import {
  publicAccountDocuments,
  publicTargetAuthorization,
  publicScopes,
  CURRENT_ACCOUNT_VERSIONS,
  CURRENT_TARGET_AUTH_VERSION,
  AUTHORIZATION_BASIS_IDS,
  isValidScope,
  TARGET_AUTH_TTL_DAYS,
  LOCAL_COMPUTER_TARGET_ENABLED,
} from "../lib/policies.js";
import { normalizeTarget } from "../lib/targets.js";
import { missingAccountDocuments } from "../middleware/requireConsent.js";
import { requestAudit } from "../middleware/attachUser.js";

const serializeAuthorization = (doc) => ({
  id: doc._id,
  target: doc.target,
  scopes: doc.scopes,
  basis: doc.attestation?.basis,
  status: doc.isCurrentlyValid() ? "active" : doc.status === "active" ? "expired" : doc.status,
  expiresAt: doc.expiresAt,
  createdAt: doc.createdAt,
});

// GET /consent/policies — the documents, scopes and current versions to show.
export const getPolicies = (_req, res) => {
  return res.json({
    accountDocuments: publicAccountDocuments(),
    targetAuthorization: publicTargetAuthorization(),
    scopes: publicScopes(),
    features: { computerTarget: LOCAL_COMPUTER_TARGET_ENABLED },
    versions: {
      account: CURRENT_ACCOUNT_VERSIONS,
      targetAuthorization: CURRENT_TARGET_AUTH_VERSION,
    },
  });
};

// GET /consent/status — the current user's account consent + authorizations.
export const getConsentStatus = async (req, res) => {
  const consent = findConsent(req.user.uid);
  const authorizations = listAuthByUser(req.user.uid, { excludeRevoked: true });

  const missing = missingAccountDocuments(consent);
  return res.json({
    account: {
      accepted: missing.length === 0,
      missing,
      acceptedVersions: Object.fromEntries(
        (consent?.accepted || []).map((a) => [a.documentId, a.version]),
      ),
      status: consent?.status || "none",
      disabledCapabilities: consent?.disabledCapabilities || [],
    },
    authorizations: authorizations.map(serializeAuthorization),
  });
};

// POST /consent/account — record acceptance of the current account policies.
// Body must echo the current versions, so a user can't silently accept stale text.
export const acceptAccountPolicies = async (req, res) => {
  const { versions } = req.body ?? {};
  if (!versions || typeof versions !== "object") {
    return res.status(400).json({ message: "Which policy versions are you accepting?" });
  }

  const mismatched = Object.entries(CURRENT_ACCOUNT_VERSIONS).filter(
    ([id, current]) => versions[id] !== current,
  );
  if (mismatched.length > 0) {
    return res.status(409).json({
      message: "The policies have been updated. Please reload and review the latest version.",
      current: CURRENT_ACCOUNT_VERSIONS,
    });
  }

  const now = new Date();
  const accepted = Object.entries(CURRENT_ACCOUNT_VERSIONS).map(([documentId, version]) => ({
    documentId,
    version,
    acceptedAt: now,
  }));
  const audit = requestAudit(req);

  upsertAccountConsent(req.user.uid, {
    userEmail: req.user.email,
    accepted,
    status: "active",
    withdrawnAt: null,
    ip: audit.ip,
    userAgent: audit.userAgent,
  });

  return res.status(200).json({ message: "Thanks — your acceptance has been recorded." });
};

// DELETE /consent/account — withdraw account-level consent (stops processing).
export const withdrawAccountConsent = async (req, res) => {
  withdrawConsent(req.user.uid);
  return res.status(200).json({ message: "Your consent has been withdrawn." });
};

// POST /consent/target — authorize a specific target with a set of scopes.
export const authorizeTarget = async (req, res) => {
  const { target: rawTarget, attestation, scopes, authorizationVersion } = req.body ?? {};

  const target = normalizeTarget(rawTarget);
  if (!target) {
    return res.status(400).json({ message: "A valid target (type and identifier) is required." });
  }
  if (target.type === "computer" && !LOCAL_COMPUTER_TARGET_ENABLED) {
    return res.status(403).json({ message: "This PC access is available only in the local desktop app." });
  }

  if (!attestation || attestation.ownershipConfirmed !== true) {
    return res.status(400).json({
      message: "You must confirm you own or are authorized to test this target.",
    });
  }
  if (!AUTHORIZATION_BASIS_IDS.includes(attestation.basis)) {
    return res.status(400).json({ message: "Select the basis for your authorization." });
  }

  if (!Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ message: "Grant at least one permission for this target." });
  }
  const invalid = scopes.filter((s) => !isValidScope(s));
  if (invalid.length > 0) {
    return res.status(400).json({ message: "One or more permissions are not recognized." });
  }

  if (authorizationVersion !== CURRENT_TARGET_AUTH_VERSION) {
    return res.status(409).json({
      message: "The authorization terms have been updated. Please reload and review them.",
      current: CURRENT_TARGET_AUTH_VERSION,
    });
  }

  const expiresAt = new Date(Date.now() + TARGET_AUTH_TTL_DAYS * 24 * 60 * 60 * 1000);
  const audit = requestAudit(req);

  // Re-authorizing an existing target replaces its active record.
  const doc = upsertAuthorization(req.user.uid, {
    target,
    attestation: { ownershipConfirmed: true, basis: attestation.basis },
    scopes: [...new Set(scopes)],
    authorizationVersion,
    expiresAt,
    ip: audit.ip,
    userAgent: audit.userAgent,
  });

  return res.status(201).json({
    message: "Target authorized.",
    authorization: serializeAuthorization(doc),
  });
};

// PATCH /consent/target/:id — turn individual permissions on/off for a target
// without re-doing the whole authorization. Body: { scopes: [...] }.
export const updateTargetScopes = async (req, res) => {
  const { id } = req.params;
  const { scopes } = req.body ?? {};

  if (!Array.isArray(scopes)) {
    return res.status(400).json({ message: "Provide the permissions to keep for this target." });
  }
  const invalid = scopes.filter((s) => !isValidScope(s));
  if (invalid.length > 0) {
    return res.status(400).json({ message: "One or more permissions are not recognized." });
  }

  const doc = updateAuthScopes(id, req.user.uid, scopes);

  if (!doc) {
    return res.status(404).json({ message: "Authorization not found." });
  }
  return res.status(200).json({
    message: "Permissions updated.",
    authorization: serializeAuthorization(doc),
  });
};

// DELETE /consent/target/:id — revoke a target authorization.
export const revokeTargetAuthorization = async (req, res) => {
  const { id } = req.params;
  const doc = revokeAuth(id, req.user.uid);

  if (!doc) {
    return res.status(404).json({ message: "Authorization not found." });
  }
  return res.status(200).json({ message: "Authorization revoked." });
};

// PUT /consent/capabilities — set the global kill-switches: the list of
// capabilities the user has turned off account-wide. Available any time.
export const setDisabledCapabilities = async (req, res) => {
  const { disabled } = req.body ?? {};
  if (!Array.isArray(disabled)) {
    return res.status(400).json({ message: "Provide the capabilities to turn off." });
  }
  const invalid = disabled.filter((s) => !isValidScope(s));
  if (invalid.length > 0) {
    return res.status(400).json({ message: "One or more capabilities are not recognized." });
  }

  const doc = setDisabledCaps(req.user.uid, disabled);

  if (!doc) {
    return res.status(409).json({
      message: "Accept the policies before managing capabilities.",
    });
  }
  return res.status(200).json({
    message: "Capabilities updated.",
    disabledCapabilities: doc.disabledCapabilities,
  });
};
