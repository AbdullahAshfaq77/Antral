import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { chat, resetProviderHealth } from "../lib/agent/llm.js";
import { maskSecret } from "../data/maskSecret.js";

// Keep environment-provider access confined to the mocked router tests.
process.env.ANTRAL_ALLOW_ENV_LLM_PROVIDER = "1";
const ENV = ["LLM_PROVIDER", "LLM_MODEL", "GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CUSTOM_LLM_PROVIDER", "CUSTOM_LLM_BASE_URL", "CUSTOM_LLM_API_KEY", "CUSTOM_LLM_MODEL", "ANTRAL_TEST_DISABLE_SAVED_LLM_PROFILES"];
const withProviders = async (values, fn) => {
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  for (const key of ENV) delete process.env[key];
  Object.assign(process.env, values);
  process.env.ANTRAL_TEST_DISABLE_SAVED_LLM_PROFILES = "1";
  const original = axios.post;
  resetProviderHealth();
  try { await fn((impl) => { axios.post = impl; }); }
  finally {
    axios.post = original;
    resetProviderHealth();
    for (const key of ENV) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
};
const ok = (text) => ({ data: { choices: [{ message: { role: "assistant", content: text } }] } });
const httpError = (status, message = "provider failure") => Object.assign(new Error(message), { response: { status, headers: {} } });

test("router fails over after 429 and 5xx without real network calls", async () => {
  for (const status of [429, 503]) await withProviders({ LLM_PROVIDER: "groq", GROQ_API_KEY: "test-a", GEMINI_API_KEY: "test-b" }, async (mock) => {
    const urls = [];
    mock(async (url) => { urls.push(url); if (url.includes("groq.com")) throw httpError(status); return ok("fallback"); });
    const result = await chat({ messages: [{ role: "user", content: "test" }] });
    assert.equal(result.message.content, "fallback");
    assert.equal(urls.length, 2);
    assert.match(urls[1], /generativelanguage\.googleapis\.com/);
  });
});

test("401 disables that provider for subsequent model calls", async () => {
  await withProviders({ LLM_PROVIDER: "groq", GROQ_API_KEY: "test-a", GEMINI_API_KEY: "test-b" }, async (mock) => {
    const urls = [];
    mock(async (url) => { urls.push(url); if (url.includes("groq.com")) throw httpError(401, "invalid"); return ok("fallback"); });
    await chat({ messages: [{ role: "user", content: "test" }] });
    urls.length = 0;
    await chat({ messages: [{ role: "user", content: "test again" }] });
    assert.ok(urls.every((url) => !url.includes("groq.com")));
  });
});

test("network timeout falls back, and all-down pauses with an error", async () => {
  await withProviders({ LLM_PROVIDER: "groq", GROQ_API_KEY: "test-a", GEMINI_API_KEY: "test-b" }, async (mock) => {
    mock(async (url) => { if (url.includes("groq.com")) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); return ok("fallback"); });
    assert.equal((await chat({ messages: [{ role: "user", content: "test" }] })).message.content, "fallback");
  });
  await withProviders({ LLM_PROVIDER: "groq", GROQ_API_KEY: "test-a", GEMINI_API_KEY: "test-b" }, async (mock) => {
    mock(async () => { throw httpError(503); });
    await assert.rejects(chat({ messages: [{ role: "user", content: "test" }] }), /failed/);
  });
});

test("role tier falls back to an available tier and marks it degraded", async () => {
  await withProviders({ LLM_PROVIDER: "groq", GROQ_API_KEY: "test-a" }, async (mock) => {
    mock(async () => ok("degraded result"));
    const result = await chat({ messages: [{ role: "user", content: "test" }], tier: "cheap" });
    assert.equal(result.degraded, true);
  });
});

test("key masking exposes only the final four characters", () => {
  assert.equal(maskSecret("secret-provider-key-1234"), "••••1234");
  assert.equal(maskSecret(""), null);
});
