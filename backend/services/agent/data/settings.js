// App-level settings in the shared local SQLite database. In the desktop app
// each install holds its own AI provider + API key here (the user's own key,
// entered on first run). Single-user per install, so these are global app
// settings, not per-user.
import { kvGet, kvSet, kvDel } from "../../../shared/localdb.js";
import { encryptSecret, decryptSecret } from "./secretStore.js";
export { maskSecret } from "./maskSecret.js";

const K = {
  provider: "setting:llm_provider",
  apiKey: "setting:llm_api_key",
  accountId: "setting:llm_account_id",
  model: "setting:llm_model",
  visionModel: "setting:llm_vision_model",
  providers: "setting:llm_provider_profiles",
  roleModels: "setting:llm_role_models",
  toolCredentials: "setting:tool_api_credentials",
};

const TOOL_CREDENTIAL_FIELDS = new Set(["githubToken", "tavilyApiKey", "crawl4aiApiToken"]);
const TOOL_SETTINGS_FIELDS = new Set([...TOOL_CREDENTIAL_FIELDS, "crawl4aiUrl"]);

export const getToolApiSettings = () => {
  try {
    const saved = JSON.parse(kvGet(K.toolCredentials) || "{}");
    return Object.fromEntries(Object.entries(saved).filter(([key]) => TOOL_SETTINGS_FIELDS.has(key)).map(([key, value]) => [key, TOOL_CREDENTIAL_FIELDS.has(key) && value ? decryptSecret(value) : value]));
  } catch { return {}; }
};

export const setToolApiSettings = (updates) => {
  const current = getToolApiSettings();
  for (const [key, value] of Object.entries(updates || {})) {
    if (!TOOL_SETTINGS_FIELDS.has(key)) continue;
    if (value === null) { delete current[key]; continue; }
    if (typeof value !== "string" || !value.trim()) continue;
    current[key] = value.trim();
  }
  // Persist API credentials encrypted; URLs are not secrets.
  const serialized = Object.fromEntries(Object.entries(current).map(([key, value]) => [
    key,
    TOOL_CREDENTIAL_FIELDS.has(key) && value ? encryptSecret(value) : value,
  ]));
  kvSet(K.toolCredentials, JSON.stringify(serialized));
};

export const getRoleModels = () => {
  try { return JSON.parse(kvGet(K.roleModels) || "{}"); } catch { return {}; }
};
export const setRoleModels = (models) => kvSet(K.roleModels, JSON.stringify(models));

export const migrateRetiredOpenRouterFreeModel = (profile) => {
  if (profile.id !== "openrouter" || !Array.isArray(profile.models)) return profile;
  let migrated = false;
  const models = profile.models.map((model) => {
    if (model.id !== "openai/gpt-oss-120b:free") return model;
    migrated = true;
    return { ...model, id: "openrouter/free" };
  });
  return migrated ? { ...profile, models } : profile;
};

const getSecret = (key) => {
  const stored = kvGet(key);
  if (!stored) return null;
  const plain = decryptSecret(stored);
  if (!String(stored).startsWith("dpapi:")) kvSet(key, encryptSecret(plain));
  return plain;
};

export const getLlmProfiles = () => {
  const saved = kvGet(K.providers);
  if (saved) {
    try {
      const storedProfiles = JSON.parse(saved);
      const profiles = storedProfiles.map(migrateRetiredOpenRouterFreeModel);
      if (profiles.some((profile, index) => profile !== storedProfiles[index])) setLlmProfiles(profiles);
      return profiles.map((profile) => ({ ...profile, apiKey: profile.apiKeyEncrypted ? decryptSecret(profile.apiKeyEncrypted) : profile.apiKey || "" }));
    } catch { return []; }
  }
  // One-time compatibility view over the legacy single-provider settings.
  const legacy = { provider: kvGet(K.provider), apiKey: getSecret(K.apiKey), accountId: kvGet(K.accountId), model: kvGet(K.model) };
  const profiles = legacy.provider ? [{
    id: legacy.provider, name: legacy.provider, kind: legacy.provider === "gemini" ? "gemini" : legacy.provider === "cloudflare" ? "cloudflare" : "openai-compatible",
    baseUrl: "", apiKey: legacy.apiKey || "", accountId: legacy.accountId || "", enabled: true, priority: 0,
    models: legacy.model ? [{ id: legacy.model, tier: "fast", enabled: true, priority: 0 }] : [], migrated: true,
  }] : [];
  if (profiles.length) {
    setLlmProfiles(profiles);
    kvDel(K.apiKey);
  }
  return profiles;
};

export const setLlmProfiles = (profiles) => {
  kvSet(K.providers, JSON.stringify(profiles.map(({ apiKey, apiKeyEncrypted, ...profile }) => ({
    ...profile,
    ...(apiKey ? { apiKeyEncrypted: encryptSecret(apiKey) } : apiKeyEncrypted ? { apiKeyEncrypted } : {}),
  }))));
};

export const getLlmConfig = () => ({
  provider: kvGet(K.provider) || null,
  apiKey: getSecret(K.apiKey),
  accountId: kvGet(K.accountId) || null,
  model: kvGet(K.model) || null,
  visionModel: kvGet(K.visionModel) || null,
});

// Sets only the fields provided. An empty string clears an optional field.
export const setLlmConfig = ({ provider, apiKey, accountId, model, visionModel }) => {
  if (provider != null) kvSet(K.provider, provider);
  if (apiKey) kvSet(K.apiKey, encryptSecret(apiKey)); // never clear the key with an empty value
  const optional = (key, value) => {
    if (value === undefined) return;
    if (value) kvSet(key, value);
    else kvDel(key);
  };
  optional(K.accountId, accountId);
  optional(K.model, model);
  optional(K.visionModel, visionModel);
};
