import axios from "axios";
import { estimateTokens } from "./limits.js";

// Provider-agnostic chat client. Configured providers expose an
// OpenAI-compatible /chat/completions endpoint with tool calling, so one
// adapter covers them. LLM_PROVIDER (and optionally LLM_MODEL) picks the
// preferred one; otherwise the first configured provider is preferred.
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
  },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-3.8-flash",
    defaultVisionModel: "gemini-3.8-flash",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
    defaultVisionModel: "google/gemini-3.8-flash",
  },
  cloudflare: {
    accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
    baseURL: "https://api.cloudflare.com/client/v4/accounts",
    keyEnv: "CLOUDFLARE_API_TOKEN",
    defaultModel: "@cf/openai/gpt-oss-20b",
  },
};

// Provider name → time (ms) before which it is skipped after a failure.
const coolingUntil = new Map();

// Metadata the UI needs to render the "enter your API key" screen.
export const PROVIDER_META = Object.entries(PROVIDERS).map(([id, p]) => ({
  id,
  needsAccountId: Boolean(p.accountIdEnv),
  defaultModel: p.defaultModel,
}));

// Desktop app: the user supplies their own key. The stored config is applied
// onto process.env so the existing provider logic (which reads env) picks it up.
// The provider that would actually answer right now, based on env (which
// includes any stored key already applied). Null when nothing is configured.
export const activeProvider = () => {
  const names = configuredNames();
  if (!names.length) return null;
  const pref = preferredName();
  return names.includes(pref) ? pref : names[0];
};

export const applyProviderConfig = ({ provider, apiKey, accountId, model, visionModel } = {}) => {
  if (!provider || !PROVIDERS[provider]) return false;
  const p = PROVIDERS[provider];
  process.env.LLM_PROVIDER = provider;
  if (apiKey) process.env[p.keyEnv] = apiKey;
  if (accountId && p.accountIdEnv) process.env[p.accountIdEnv] = accountId;
  if (model) process.env.LLM_MODEL = model;
  else delete process.env.LLM_MODEL;
  if (visionModel) process.env.LLM_VISION_MODEL = visionModel;
  else delete process.env.LLM_VISION_MODEL;
  return true;
};

const isConfigured = (name) => {
  const provider = PROVIDERS[name];
  return [provider.keyEnv, provider.accountIdEnv].filter(Boolean).every((key) => process.env[key]?.trim());
};

const configuredNames = () => Object.keys(PROVIDERS).filter(isConfigured);

const preferredName = () => (process.env.LLM_PROVIDER || "").trim().toLowerCase() || configuredNames()[0];

// LLM_MODEL / LLM_VISION_MODEL name a model of the preferred provider, so
// fallbacks always use their own defaults.
const describe = (name, { vision }) => {
  const provider = PROVIDERS[name];
  const own = name === preferredName();
  const accountId = provider.accountIdEnv ? process.env[provider.accountIdEnv].trim() : null;
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error(`${provider.accountIdEnv} must be a 32-character Cloudflare account ID.`);
  }
  const model = vision
    ? (own && process.env.LLM_VISION_MODEL) || provider.defaultVisionModel
    : (own && process.env.LLM_MODEL) || provider.defaultModel;
  return {
    name,
    ...provider,
    baseURL: accountId ? `${provider.baseURL}/${accountId}/ai/v1` : provider.baseURL,
    apiKey: process.env[provider.keyEnv],
    model,
  };
};

// Preferred provider first, then the other configured ones. Providers cooling
// down after a failure go last, soonest-available first, so a request is
// never refused just because every provider failed recently.
const providerChain = ({ vision = false } = {}) => {
  const preferred = preferredName();
  if (preferred && !PROVIDERS[preferred]) throw new Error(`Unknown LLM provider "${preferred}".`);
  if (preferred && !isConfigured(preferred)) {
    const missing = [PROVIDERS[preferred].keyEnv, PROVIDERS[preferred].accountIdEnv]
      .filter((key) => key && !process.env[key]?.trim());
    throw new Error(`LLM provider "${preferred}" is selected but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.`);
  }
  const configured = configuredNames().filter((name) => !vision || PROVIDERS[name].defaultVisionModel);
  const names = [preferred, ...configured.filter((n) => n !== preferred)]
    .filter((name) => name && configured.includes(name));
  if (!names.length) {
    if (vision) throw new Error("No vision-capable LLM provider is configured.");
    throw new Error(
      "No LLM provider configured. Set GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, or both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
    );
  }
  const now = Date.now();
  const ready = names.filter((n) => (coolingUntil.get(n) || 0) <= now);
  const cooling = names
    .filter((n) => (coolingUntil.get(n) || 0) > now)
    .sort((a, b) => coolingUntil.get(a) - coolingUntil.get(b));
  return [...ready, ...cooling].map((n) => describe(n, { vision }));
};

// The provider the next request will go to first.
export const resolveProvider = ({ vision = false } = {}) => providerChain({ vision })[0];

// Converts registry tools to the OpenAI function-tool format.
export const toToolSchemas = (tools) =>
  tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

const MAX_RETRIES = 4;
const MAX_WAIT_MS = 90_000;
// While another provider is available, only retry the same one if it asks to
// wait this little; otherwise move on at once.
const QUICK_RETRY_MS = 2_000;

// The provider's error text. Gemini wraps its error body in an array.
const providerMessage = (error) => {
  const data = error.response?.data;
  return (Array.isArray(data) ? data[0] : data)?.error?.message || "";
};

// How long to wait before retrying a rate-limited or overloaded request:
// the Retry-After header, the "try again in 24.9s" hint, or backoff.
const retryDelayMs = (error, attempt) => {
  const header = Number(error.response?.headers?.["retry-after"]);
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const hint = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(providerMessage(error));
  if (hint) return (Number(hint[1] || 0) * 60 + Number(hint[2])) * 1000 + 500;
  return 1_000 * 2 ** attempt;
};

const isRetryable = (error) => {
  const status = error.response?.status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || error.code === "ECONNRESET";
};

// The request was bigger than the provider accepts in one go (Groq answers
// 413 "Request too large ... tokens per minute"). Waiting never helps; the
// caller has to send less.
export const isTooLarge = (error) =>
  error.response?.status === 413 ||
  /request too large|context length|maximum context|too many tokens/i.test(providerMessage(error));

// How long to skip a provider after it failed.
const cooldownMs = (error) => {
  const status = error.response?.status;
  if (status === 401 || status === 403 || status === 404) return 30 * 60_000; // bad key or model
  if (isRetryable(error)) return Math.min(Math.max(retryDelayMs(error, 0), 30_000), 60 * 60_000);
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

// One model turn. Returns { message, usage, provider, model }. Fails over to
// the next provider instead of waiting; only the last one left is retried
// patiently. When `onToken` is given, the turn is streamed and `onToken` is
// called with the full assistant text so far as it arrives.
export const chat = async (args) => {
  const { messages, tools = [], maxTokens = 0, signal } = args;
  const chain = providerChain({ vision: hasImages(messages) });
  const needed = estimateTokens(messages) + Math.ceil(JSON.stringify(tools).length / 4) + maxTokens;
  const fits = chain.filter((p) => !p.maxRequestTokens || needed <= p.maxRequestTokens);
  const candidates = fits.length ? fits : chain;

  let lastError;
  for (const [index, provider] of candidates.entries()) {
    const last = index === candidates.length - 1;
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw new Error("cancelled");
      try {
        const result = await chatOnce(provider, args);
        coolingUntil.delete(provider.name);
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        const wait = isRetryable(error) ? retryDelayMs(error, attempt) : Infinity;
        const canRetry = last ? attempt < MAX_RETRIES && wait <= MAX_WAIT_MS : attempt === 0 && wait <= QUICK_RETRY_MS;
        if (canRetry) {
          await sleep(wait, signal);
          continue;
        }
        if (!isTooLarge(error)) coolingUntil.set(provider.name, Date.now() + cooldownMs(error));
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
      onToken(text);
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
    const onAbort = () => {
      stream.destroy();
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (line.startsWith("data:")) handle(line.slice(5).trim());
      }
    });
    stream.on("end", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    stream.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
  const message = {
    role: "assistant",
    content: text,
    ...(toolCalls.length ? { tool_calls: toolCalls.filter(Boolean) } : {}),
  };
  return { message, usage, provider: provider.name, model: provider.model };
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
    const { data } = await axios.post(`${provider.baseURL}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      timeout: 120_000,
      signal,
      ...(streaming ? { responseType: "stream" } : {}),
    });
    if (streaming) return await consumeStream(data, provider, signal, onToken);
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error("The model returned no message.");
    return { message, usage: data.usage, provider: provider.name, model: provider.model };
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
    const wrapped = new Error(`LLM request to ${provider.name} failed: ${detail}`);
    wrapped.response = error.response && {
      status: error.response.status,
      headers: error.response.headers,
      data: error.response.data,
    };
    wrapped.code = error.code;
    throw wrapped;
  }
};
