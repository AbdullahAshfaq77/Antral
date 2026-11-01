import axios from "axios";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { estimateTokens } from "./limits.js";
import { getLlmProfiles } from "../../data/settings.js";
import providerCatalog from "../../providers/catalog.json" with { type: "json" };

const customEnvPath = fileURLToPath(new URL("../../.env.custom", import.meta.url));
if (existsSync(customEnvPath)) {
  const { error } = dotenv.config({ path: customEnvPath, override: false, quiet: true });
  if (error) throw error;
}

// Provider-agnostic chat client. Configured providers expose an
// OpenAI-compatible /chat/completions endpoint with tool calling, so one
// adapter covers them. User-saved profiles are tried first; the agent's .env
// providers remain available as fallbacks.
//
// Every configured provider is a fallback: if the preferred one is rate
// limited, out of quota, overloaded or down, the same request goes straight to
// the next one, and the failed provider is skipped until it should be usable
// again. The switch is silent; the run just continues.
const PROVIDERS = {
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
    defaultVisionModel: "qwen/qwen3.8-27b",
    // Free tier rejects any single request above 8,000 tokens (max_tokens included).
    maxRequestTokens: 8_000,
    tier: "best",
  },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-3.8-flash",
    defaultVisionModel: "gemini-3.8-flash",
    tier: "fast",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
    defaultVisionModel: "google/gemini-3.8-flash",
    tier: "best",
  },
  cloudflare: {
    accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
    baseURL: "https://api.cloudflare.com/client/v4/accounts",
    keyEnv: "CLOUDFLARE_API_TOKEN",
    defaultModel: "@cf/openai/gpt-oss-20b",
    tier: "mid",
  },
  custom: {
    baseURLEnv: "CUSTOM_LLM_BASE_URL",
    keyEnv: "CUSTOM_LLM_API_KEY",
    modelEnv: "CUSTOM_LLM_MODEL",
    providerNameEnv: "CUSTOM_LLM_PROVIDER",
    visionModelEnv: "CUSTOM_LLM_VISION_MODEL",
  },
};

const customRequiredEnv = [
  PROVIDERS.custom.providerNameEnv,
  PROVIDERS.custom.baseURLEnv,
  PROVIDERS.custom.keyEnv,
  PROVIDERS.custom.modelEnv,
];

// Keep a read-only snapshot of values supplied by the agent's environment
// before saved desktop profiles are applied to process.env during startup.
const ENV_AT_LOAD = Object.fromEntries(
  [...new Set([
    ...Object.values(PROVIDERS).flatMap((provider) => [provider.keyEnv, provider.accountIdEnv, provider.baseURLEnv, provider.modelEnv, provider.providerNameEnv, provider.visionModelEnv]),
    "LLM_PROVIDER", "LLM_MODEL", "LLM_VISION_MODEL",
  ].filter(Boolean))].map((key) => [key, process.env[key]]),
);

export const getEnvProviders = () => {
  const env = ENV_AT_LOAD;
  const items = [];
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const key = env[provider.keyEnv]?.trim();
    const configured = id === "custom"
      ? Boolean(env[provider.providerNameEnv]?.trim() && env[provider.baseURLEnv]?.trim() && key && env[provider.modelEnv]?.trim())
      : Boolean(key && (!provider.accountIdEnv || env[provider.accountIdEnv]?.trim()));
    if (!configured) continue;
    items.push({
      id,
      name: id === "custom" ? env[provider.providerNameEnv].trim() : id[0].toUpperCase() + id.slice(1),
      source: "agent .env",
      hasKey: Boolean(key),
      model: (env.LLM_PROVIDER || "").toLowerCase() === id ? env.LLM_MODEL || env[provider.modelEnv] || provider.defaultModel : env[provider.modelEnv] || provider.defaultModel || null,
      readOnly: true,
    });
  }
  return items;
};

const hasCustomProviderConfig = () =>
  [...customRequiredEnv, PROVIDERS.custom.visionModelEnv].some((key) => process.env[key]?.trim());

const customMissingEnv = () => customRequiredEnv.filter((key) => !process.env[key]?.trim());

// Provider name → time (ms) before which it is skipped after a failure.
const coolingUntil = new Map();
// A timeout cools down only that provider/model pair; its other models can still run.
const modelCoolingUntil = new Map();
const invalidProviders = new Set();
const failureCounts = new Map();
const healthStatus = new Map();
const modelKey = (provider) => JSON.stringify([provider.name, provider.model]);
export const resetProviderHealth = () => { coolingUntil.clear(); modelCoolingUntil.clear(); invalidProviders.clear(); failureCounts.clear(); healthStatus.clear(); };
export const providerHealth = () => Object.fromEntries(healthStatus);

// Metadata the UI needs to render the "enter your API key" screen.
export const PROVIDER_META = Object.entries(PROVIDERS).filter(([id]) => id !== "custom").map(([id, p]) => ({
  id,
  needsAccountId: Boolean(p.accountIdEnv),
  defaultModel: p.defaultModel,
}));

// Only a provider saved by this Antral installation counts as active. If the
// user has not chosen a model, use the preset's suggested default when one is
// available; custom gateways can be saved first and assigned a model later.
const hasUsableModel = (profile) => {
  if (profile.models?.length) return profile.models.some((model) => model.enabled !== false);
  return Boolean(providerCatalog.presets.find((item) => item.id === profile.id)?.suggestedModels?.length);
};
const hasRequiredCredentials = (profile) => {
  const preset = providerCatalog.presets.find((item) => item.id === profile.id);
  return (preset?.requiredFields || []).every((field) => Boolean(String(profile[field] || "").trim()));
};
export const activeProvider = () => getLlmProfiles().find((profile) => profile.enabled && hasUsableModel(profile) && hasRequiredCredentials(profile))?.id || null;

const isConfigured = (name) => {
  const provider = PROVIDERS[name];
  if (name === "custom") return customMissingEnv().length === 0;
  return [provider.keyEnv, provider.accountIdEnv].filter(Boolean).every((key) => process.env[key]?.trim());
};

const configuredNames = () => Object.keys(PROVIDERS).filter(isConfigured);

const preferredName = () =>
  (hasCustomProviderConfig() && customMissingEnv().length === 0 ? "custom" : "") ||
  (process.env.LLM_PROVIDER || "").trim().toLowerCase() ||
  configuredNames()[0];

// LLM_MODEL / LLM_VISION_MODEL name a model of the preferred provider, so
// fallbacks always use their own defaults.
const describe = (name, { vision }) => {
  const definition = PROVIDERS[name];
  const provider =
    name === "custom"
      ? {
          ...definition,
          baseURL: process.env[definition.baseURLEnv]?.trim(),
          defaultModel: process.env[definition.modelEnv]?.trim(),
          defaultVisionModel: process.env[definition.visionModelEnv]?.trim() || null,
          keyEnv: definition.keyEnv,
          label: process.env[definition.providerNameEnv]?.trim(),
          tier: "fast",
        }
      : definition;
  const own = name === preferredName();
  const accountId = provider.accountIdEnv ? process.env[provider.accountIdEnv].trim() : null;
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error(`${provider.accountIdEnv} must be a 32-character Cloudflare account ID.`);
  }
  if (name === "custom") {
    let url;
    try {
      url = new URL(provider.baseURL);
    } catch {
      throw new Error("CUSTOM_LLM_BASE_URL must be a valid HTTP or HTTPS URL.");
    }
    const isLocalHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (!["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && !isLocalHttp)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "CUSTOM_LLM_BASE_URL must use HTTPS (or local loopback HTTP) and must not contain credentials, query, or fragment.",
      );
    }
    provider.baseURL = url.href.replace(/\/+$/, "");
  }
  const model = vision
    ? (name !== "custom" && own && process.env.LLM_VISION_MODEL) || provider.defaultVisionModel
    : (name !== "custom" && own && process.env.LLM_MODEL) || provider.defaultModel;
  return {
    name,
    ...provider,
    baseURL: accountId ? `${provider.baseURL}/${accountId}/ai/v1` : provider.baseURL,
    apiKey: process.env[provider.keyEnv],
    model,
  };
};

const describeProfile = (profile, { tier, modelId } = {}) => {
  const preset = providerCatalog.presets.find((item) => item.id === profile.id);
  const configuredModels = profile.models || [];
  const models = configuredModels.length
    ? configuredModels.filter((model) => model.enabled !== false)
    : (preset?.suggestedModels || []).map((model) => ({ ...model, enabled: true, priority: 0 }));
  const ordered = models.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const chosen = ordered.find((model) => model.id === modelId) || (tier && ordered.find((model) => model.tier === tier)) || ordered[0];
  if (!profile.enabled || !chosen || !hasRequiredCredentials(profile)) return null;
  const baseURL = String(profile.baseUrl || preset?.baseUrl || "").trim().replace(/\/+$/, "");
  return { name: profile.id, label: profile.name || preset?.name || profile.id, baseURL: profile.kind === "cloudflare" && profile.accountId ? `${baseURL}/${profile.accountId}/ai/v1` : baseURL, apiKey: profile.apiKey || undefined, model: chosen.id, tier: chosen.tier || "fast", profile: true, maxRequestTokens: 0 };
};

// Saved user profiles are tried before .env providers. Timed-out models are
// skipped until their cooldown expires; other configured models remain ready.
const providerChain = ({ vision = false, tier } = {}) => {
  // Desktop users must add their own key in Settings. Server env providers are
  // supported only by the isolated provider tests and never used by the app.
  const allowEnvProviders = process.env.ANTRAL_ALLOW_ENV_LLM_PROVIDER === "1";
  const names = allowEnvProviders
    ? (() => {
        if (hasCustomProviderConfig() && customMissingEnv().length) {
          throw new Error(`Custom LLM provider configuration is incomplete. Set ${customMissingEnv().join(", ")} in backend/services/agent/.env.custom.`);
        }
        const preferred = preferredName();
        if (preferred && !PROVIDERS[preferred]) throw new Error(`Unknown LLM provider "${preferred}".`);
        if (preferred && !isConfigured(preferred)) {
          const missing = [PROVIDERS[preferred].keyEnv, PROVIDERS[preferred].accountIdEnv]
            .filter((key) => key && !process.env[key]?.trim());
          throw new Error(`LLM provider "${preferred}" is selected but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.`);
        }
        const configured = configuredNames().filter((name) => !vision || PROVIDERS[name].defaultVisionModel);
        return [preferred, ...configured.filter((name) => name !== preferred)].filter((name) => name && configured.includes(name));
      })()
    : [];
  const now = Date.now();
  const ready = names.filter((n) => (coolingUntil.get(n) || 0) <= now);
  const cooling = names
    .filter((n) => (coolingUntil.get(n) || 0) > now)
    .sort((a, b) => coolingUntil.get(a) - coolingUntil.get(b));
  const legacy = [...ready, ...cooling].map((n) => describe(n, { vision }));
  const savedProfiles = process.env.ANTRAL_TEST_DISABLE_SAVED_LLM_PROFILES === "1" ? [] : getLlmProfiles();
  const profiles = savedProfiles.filter((profile) => !invalidProviders.has(profile.id)).flatMap((profile) =>
    (profile.models || []).filter((model) => model.enabled !== false).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((model) => describeProfile(profile, { tier, modelId: model.id })).filter(Boolean),
  );
  const chain = [...profiles.sort((a, b) => {
    const priority = (savedProfiles.find((p) => p.id === a.name)?.priority ?? 0) - (savedProfiles.find((p) => p.id === b.name)?.priority ?? 0);
    if (priority) return priority;
    return (coolingUntil.get(a.name) || 0) - (coolingUntil.get(b.name) || 0);
  }), ...(allowEnvProviders ? legacy.filter((provider) => !invalidProviders.has(provider.name)) : [])];
  const readyModels = chain.filter((provider) => (modelCoolingUntil.get(modelKey(provider)) || 0) <= now);
  if (readyModels.length) return readyModels;
  if (chain.length) {
    const retryAt = Math.min(...chain.map((provider) => modelCoolingUntil.get(modelKey(provider)) || now));
    const minutes = Math.max(1, Math.ceil((retryAt - now) / 60_000));
    throw new Error(`All configured AI models are in a timeout cooldown. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
  if (vision) throw new Error("No vision-capable LLM provider is configured. Add your own vision-capable provider in Settings → AI providers.");
  throw new Error("No user AI provider is configured. Open Settings → AI providers, choose a provider, and enter your own API key.");
};

// The provider the next request will go to first.
export const resolveProvider = ({ vision = false } = {}) => providerChain({ vision })[0];

export const selectModel = (role, pinnedModel) => {
  const tier = typeof role === "string" ? role : role?.tier;
  if (pinnedModel) {
    const [providerId, modelId] = String(pinnedModel).split(/:(.*)/s, 2);
    const pinned = providerChain().find((provider) => provider.name === providerId && provider.model === modelId);
    if (pinned) return pinned;
  }
  const chain = providerChain({ tier });
  if (!tier) return chain[0];
  const exact = chain.filter((provider) => provider.tier === tier);
  const degraded = chain.filter((provider) => provider.tier !== tier);
  const selected = exact[0] || degraded[0];
  return selected ? { ...selected, degraded: selected.tier !== tier, requestedTier: tier } : null;
};

// Used when a structured response remains invalid after its one repair call.
// Keep the existing provider priority and role tier, but choose a different
// configured provider/model for the next bounded attempt.
export const selectFallbackModel = (role, excludedProviders = []) => {
  const tier = typeof role === "string" ? role : role?.tier;
  const excluded = new Set(excludedProviders || []);
  const chain = providerChain({ tier }).filter((provider) => !excluded.has(provider.name));
  if (!chain.length) return null;
  const exact = chain.find((provider) => provider.tier === tier);
  const selected = exact || chain[0];
  return { ...selected, ...(tier ? { degraded: selected.tier !== tier, requestedTier: tier } : {}) };
};

// Converts registry tools to the OpenAI function-tool format.
export const toToolSchemas = (tools) =>
  tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

const MAX_RETRIES = 1;
// While another provider is available, only retry the same one if it asks to
// wait this little; otherwise move on at once.
const QUICK_RETRY_MS = 2_000;
// Keep a run from waiting too long on a model that has stopped responding.
const PROVIDER_TIMEOUT_MS = 30_000;
const UNRESPONSIVE_COOLDOWN_MS = 10 * 60_000;

// The provider's error text. Gemini wraps its error body in an array.
const providerMessage = (error) => {
  const data = error.response?.data;
  return (Array.isArray(data) ? data[0] : data)?.error?.message || "";
};

// How long to wait before retrying a rate-limited or overloaded request:
// the Retry-After header, the "try again in 24.9s" hint, or backoff.
const retryDelayMs = (error, attempt) => {
  const header = Number(error.response?.headers?.["retry-after"]);
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 600_000);
  const hint = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(providerMessage(error));
  if (hint) return (Number(hint[1] || 0) * 60 + Number(hint[2])) * 1000 + 500;
  return Math.min(30_000 * 2 ** attempt, 600_000);
};

const NETWORK_CODES = ["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNABORTED", "ECONNREFUSED", "EPIPE"];
const isRetryable = (error) => {
  const status = error.response?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  // Transient network/DNS blips (e.g. a momentary resolver failure).
  return NETWORK_CODES.includes(error.code) || NETWORK_CODES.some((c) => (error.message || "").includes(c));
};
const isUnresponsive = (error) =>
  Boolean(error.unresponsive || error.stalled) ||
  [408, 504].includes(error.response?.status) ||
  ["ECONNABORTED", "ETIMEDOUT"].includes(error.code) ||
  /timed? ?out|timeout|stream stalled/i.test(error.message || "");

// The request was bigger than the provider accepts in one go (Groq answers
// 413 "Request too large ... tokens per minute"). Waiting never helps; the
// caller has to send less.
export const isTooLarge = (error) =>
  error.response?.status === 413 ||
  /request too large|context length|maximum context|too many tokens/i.test(providerMessage(error));

// How long to skip a provider after it failed.
const cooldownMs = (error, providerName) => {
  const status = error.response?.status;
  if (status === 401 || status === 403 || status === 404) return 30 * 60_000; // bad key or model
  if (status === 429) return retryDelayMs(error, Math.max(0, (failureCounts.get(providerName) || 1) - 1));
  if (isRetryable(error)) return (failureCounts.get(providerName) || 0) >= 3 ? 60_000 : 0;
  return 60_000;
};

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });

const hasImages = (messages) =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((part) => part.type === "image_url"));

const hasAssistantOutput = (message) =>
  (typeof message?.content === "string" && message.content.trim().length > 0) ||
  (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0);

// One model turn. Returns { message, usage, provider, model }. A failed,
// empty, or timed-out response advances to the next configured model. When
// `onToken` is given, the turn is streamed and `onToken` receives the full
// assistant text so far as it arrives.
export const chat = async (args) => {
  const { messages, tools = [], maxTokens = 0, signal, tier, pinnedModel, onProviderSwitch } = args;
  let chain = providerChain({ vision: hasImages(messages), tier });
  let pinned;
  if (pinnedModel) {
    const [providerId, modelId] = String(pinnedModel).split(/:(.*)/s, 2);
    pinned = chain.find((provider) => provider.name === providerId && provider.model === modelId);
  }
  if (tier) {
    const exact = chain.filter((provider) => provider.tier === tier);
    const fallback = chain.filter((provider) => provider.tier !== tier);
    chain = [...exact, ...fallback];
  }
  // A role's explicit model choice comes first; the other configured models
  // remain available if it fails to respond.
  if (pinned) chain = [pinned, ...chain.filter((provider) => provider !== pinned)];
  const needed = estimateTokens(messages) + Math.ceil(JSON.stringify(tools).length / 4) + maxTokens;
  const fits = chain.filter((p) => !p.maxRequestTokens || needed <= p.maxRequestTokens);
  const candidates = fits.length ? fits : chain;

  let lastError;
  for (const [index, provider] of candidates.entries()) {
    if (invalidProviders.has(provider.name)) continue;
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw new Error("cancelled");
      try {
        const result = await chatOnce(provider, args);
        coolingUntil.delete(provider.name);
        modelCoolingUntil.delete(modelKey(provider));
        failureCounts.delete(provider.name);
        healthStatus.set(provider.name, { status: "healthy" });
        if (index > 0) onProviderSwitch?.({
          from: `${candidates[index - 1].label || candidates[index - 1].name} · ${candidates[index - 1].model}`,
          to: `${provider.label || provider.name} · ${provider.model}`,
          reason: "model unavailable or not responding",
        });
        if (provider.tier && tier && provider.tier !== tier) result.degraded = true;
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        if (error.unresponsive) {
          const until = Date.now() + UNRESPONSIVE_COOLDOWN_MS;
          modelCoolingUntil.set(modelKey(provider), until);
          healthStatus.set(provider.name, { status: "down", until });
          break;
        }
        if (isRetryable(error)) failureCounts.set(provider.name, (failureCounts.get(provider.name) || 0) + 1);
        if (error.response?.status === 401 || error.response?.status === 403) {
          invalidProviders.add(provider.name);
          healthStatus.set(provider.name, { status: "invalid_key" });
          break;
        }
        const wait = isRetryable(error) ? retryDelayMs(error, attempt) : Infinity;
        const canRetry = attempt < MAX_RETRIES && wait <= QUICK_RETRY_MS;
        if (canRetry) {
          await sleep(wait, signal);
          continue;
        }
        if (!isTooLarge(error)) {
          const cooldown = cooldownMs(error, provider.name);
          if (cooldown > 0) {
            const until = Date.now() + cooldown;
            coolingUntil.set(provider.name, until);
            healthStatus.set(provider.name, { status: error.response?.status === 429 ? "cooling" : "down", until });
          } else healthStatus.set(provider.name, { status: "down" });
        }
        break;
      }
    }
  }
  throw lastError;
};

// Gemini 3 requires a thought signature on every tool call it is shown. Calls
// made by another provider (after a failover) have none, so they get Google's
// documented placeholder; other providers get the calls without the field.
const SKIP_SIGNATURE = { google: { thought_signature: "skip_thought_signature_validator" } };
const messagesFor = (providerName, messages) =>
  messages.map((m) => {
    if (!m.tool_calls?.length) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map(({ extra_content, ...call }) =>
        providerName === "gemini"
          ? { ...call, extra_content: extra_content?.google?.thought_signature ? extra_content : SKIP_SIGNATURE }
          : call,
      ),
    };
  });

// Drains a stream to a string (used to read an error body that came back as a
// stream when the request was made with responseType: "stream").
const drain = (stream) =>
  new Promise((resolve) => {
    let out = "";
    stream.on("data", (c) => (out += c.toString("utf8")));
    stream.on("end", () => resolve(out));
    stream.on("error", () => resolve(out));
  });

// Parses an OpenAI-style SSE stream, accumulating assistant text and tool
// calls. Calls onToken(fullTextSoFar) as visible text arrives. Returns the
// same shape as a non-streamed turn.
const consumeStream = async (stream, provider, signal, onToken) => {
  let text = "";
  let usage;
  const toolCalls = [];
  let buffer = "";
  const handle = (payload) => {
    if (payload === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.usage) usage = json.usage;
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      text += delta.content;
      try {
        onToken(text);
      } catch {
        // a live-preview callback must never break the stream
      }
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0;
      const slot = (toolCalls[i] ||= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      if (tc.type) slot.type = tc.type;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
  };
  await new Promise((resolve, reject) => {
    // Watchdog: if the provider stalls mid-stream (no data for a while), stop
    // waiting so the caller can fall back instead of "loading" forever.
    let idle;
    const bumpIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        const e = new Error("stream stalled");
        e.stalled = true;
        cleanup();
        stream.destroy();
        reject(e);
      }, PROVIDER_TIMEOUT_MS);
    };
    const cleanup = () => {
      if (idle) clearTimeout(idle);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      stream.destroy();
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => {
      bumpIdle();
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (line.startsWith("data:")) handle(line.slice(5).trim());
      }
    });
    stream.on("end", () => {
      cleanup();
      resolve();
    });
    stream.on("error", (e) => {
      cleanup();
      reject(e);
    });
    bumpIdle();
  });
  const message = {
    role: "assistant",
    content: text,
    ...(toolCalls.length ? { tool_calls: toolCalls.filter(Boolean) } : {}),
  };
  return { message, usage, provider: provider.label || provider.name, model: provider.model };
};

const chatOnce = async (provider, { messages, tools = [], signal, maxTokens, onToken }) => {
  const streaming = typeof onToken === "function";
  try {
    const body = {
      model: provider.model,
      messages: messagesFor(provider.name, messages),
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      temperature: 0.2,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    const headers = { ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}), "Content-Type": "application/json" };
    const url = `${provider.baseURL}/chat/completions`;

    if (streaming) {
      const { data } = await axios.post(url, body, { headers, timeout: PROVIDER_TIMEOUT_MS, signal, responseType: "stream" });
      const result = await consumeStream(data, provider, signal, onToken);
      if (!hasAssistantOutput(result.message)) throw new Error("The model returned an empty response.");
      return result;
    }

    const { data } = await axios.post(url, body, { headers, timeout: PROVIDER_TIMEOUT_MS, signal });
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error("The model returned no message.");
    if (!hasAssistantOutput(message)) throw new Error("The model returned an empty response.");
    return { message, usage: data.usage, provider: provider.label || provider.name, model: provider.model };
  } catch (error) {
    // A streamed request's error body comes back as a stream; read it so the
    // retry logic and message extraction below see plain data.
    if (streaming && error.response?.data && typeof error.response.data.on === "function") {
      const raw = await drain(error.response.data);
      try {
        error.response.data = JSON.parse(raw);
      } catch {
        error.response.data = raw;
      }
    }
    // Never surface the request config (it holds the API key).
    // Keep status/headers for the retry logic; message is safe to show.
    const detail = providerMessage(error) || error.message;
    const wrapped = new Error(`LLM request to ${provider.label || provider.name} failed: ${detail}`);
    wrapped.response = error.response && {
      status: error.response.status,
      headers: error.response.headers,
      data: error.response.data,
    };
    wrapped.code = error.code;
    wrapped.unresponsive = isUnresponsive(error);
    throw wrapped;
  }
};
