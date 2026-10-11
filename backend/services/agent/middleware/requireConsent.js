import { findConsent, findActiveAuthForTarget } from "../data/consent.js";
import { CURRENT_ACCOUNT_VERSIONS, LOCAL_COMPUTER_TARGET_ENABLED, effectiveScopes } from "../lib/policies.js";
import { normalizeTarget } from "../lib/targets.js";

// Compares a user's AccountConsent against the current document versions and
// returns the list of document ids that are missing or out of date.
export const missingAccountDocuments = (consent) => {
  if (!consent || consent.status !== "active") return Object.keys(CURRENT_ACCOUNT_VERSIONS);
  return Object.entries(CURRENT_ACCOUNT_VERSIONS)
    .filter(([id, version]) => consent.versionOf(id) !== version)
    .map(([id]) => id);
};

// Gate 1: the user must have accepted the current account-level policies.
export const requireAccountConsent = async (req, res, next) => {
  try {
    const consent = findConsent(req.user.uid);
    const missing = missingAccountDocuments(consent);
    if (missing.length > 0) {
      return res.status(403).json({
        message: "Please review and accept the current policies to continue.",
        consentRequired: "account",
        missing,
      });
    }
    req.accountConsent = consent; // reused by the target gate for kill-switches
    return next();
  } catch (error) {
    return next(error);
  }
};

// Gate 2 (factory): the user must hold a current authorization for the target
// named in the request, granting every scope in `requiredScopes`.
//
// The target is read from req.body.target (POST) or req.query (GET:
// ?targetType=..&targetId=..). The resolved authorization is attached as
// req.authorization for the handler to use.
export const requireTargetAuthorization = (requiredScopes = []) => async (req, res, next) => {
  try {
    const raw =
      req.body?.target ||
      (req.query?.targetType && req.query?.targetId
        ? { type: req.query.targetType, identifier: req.query.targetId }
        : null);

    const target = normalizeTarget(raw);
    if (!target) {
      return res.status(400).json({
        message: "A valid target (type and identifier) is required.",
      });
    }
    if (target.type === "computer" && !LOCAL_COMPUTER_TARGET_ENABLED) {
      return res.status(403).json({ message: "This PC access is available only in the local desktop app." });
    }

    const auth = findActiveAuthForTarget(req.user.uid, target.type, target.identifier);

    if (!auth || !auth.isCurrentlyValid()) {
      return res.status(403).json({
        message: "This target is not authorized. Please authorize it before the agents can act on it.",
        consentRequired: "target",
        target,
        expired: Boolean(auth && !auth.isCurrentlyValid()),
      });
    }

    const notGranted = requiredScopes.filter((s) => !effectiveScopes(auth).includes(s));
    if (notGranted.length > 0) {
      return res.status(403).json({
        message: "This action needs permissions you have not granted for this target.",
        consentRequired: "scope",
        target,
        missingScopes: notGranted,
      });
    }

    // Global kill-switch: a capability the user has turned off account-wide is
    // denied everywhere, even if it was granted for this target.
    const consent = req.accountConsent ?? findConsent(req.user.uid);
    const disabled = consent?.disabledCapabilities || [];
    const blocked = requiredScopes.filter((s) => disabled.includes(s));
    if (blocked.length > 0) {
      return res.status(403).json({
        message: "This capability is currently turned off. Turn it back on to continue.",
        consentRequired: "capability-disabled",
        target,
        disabledScopes: blocked,
      });
    }

    req.authorization = auth;
    req.target = target;
    return next();
  } catch (error) {
    return next(error);
  }
};
