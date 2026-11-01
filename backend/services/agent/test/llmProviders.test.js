import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import axios from "axios";
import { chat, resolveProvider } from "../lib/agent/llm.js";

// Environment routing is enabled only in provider tests. The app requires keys
// to be entered and saved in its local provider settings.
process.env.ANTRAL_ALLOW_ENV_LLM_PROVIDER = "1";

const ENV_KEYS = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_VISION_MODEL",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CUSTOM_LLM_PROVIDER",
  "CUSTOM_LLM_BASE_URL",
  "CUSTOM_LLM_API_KEY",
  "CUSTOM_LLM_MODEL",
  "CUSTOM_LLM_VISION_MODEL",
  "ANTRAL_TEST_DISABLE_SAVED_LLM_PROFILES",
];

const withEnv = (values, callback) => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  process.env.ANTRAL_TEST_DISABLE_SAVED_LLM_PROFILES = "1";
  try {
    callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
};

test("agent .env API keys are ignored unless explicitly enabled for provider tests", () => {
  const previous = process.env.ANTRAL_ALLOW_ENV_LLM_PROVIDER;
  delete process.env.ANTRAL_ALLOW_ENV_LLM_PROVIDER;
  try {
    withEnv({ LLM_PROVIDER: "groq", GROQ_API_KEY: "server-owned-key" }, () => {
      assert.throws(() => resolveProvider(), /enter your own API key/i);
    });
  } finally {
    if (previous === undefined) delete process.env.ANTRAL_ALLOW_ENV_LLM_PROVIDER;
    else process.env.ANTRAL_ALLOW_ENV_LLM_PROVIDER = previous;
  }
});

test("Cloudflare Workers AI resolves its account endpoint and tool-capable default model", () => {
  withEnv(
    {
      LLM_PROVIDER: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_API_TOKEN: "test-token",
    },
    () => {
      const provider = resolveProvider();
      assert.equal(provider.name, "cloudflare");
      assert.equal(
        provider.baseURL,
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1",
      );
      assert.equal(provider.model, "@cf/openai/gpt-oss-20b");
      assert.equal(provider.apiKey, "test-token");
    },
  );
});

test("Cloudflare Workers AI requires both account ID and API token", () => {
  withEnv(
    { LLM_PROVIDER: "cloudflare", CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" },
    () => assert.throws(() => resolveProvider(), /CLOUDFLARE_API_TOKEN is not set/),
  );
});

test("Cloudflare Workers AI is excluded from vision requests", () => {
  withEnv(
    {
      LLM_PROVIDER: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_API_TOKEN: "test-token",
    },
    () => assert.throws(() => resolveProvider({ vision: true }), /No vision-capable LLM provider is configured/),
  );
});

test("invalid Cloudflare account IDs are rejected before requests are made", () => {
  withEnv(
    {
      LLM_PROVIDER: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "not-an-account-id",
      CLOUDFLARE_API_TOKEN: "test-token",
    },
    () => assert.throws(() => resolveProvider(), /must be a 32-character Cloudflare account ID/),
  );
});

test("a configured custom OpenAI-compatible provider takes priority over built-ins", () => {
  withEnv(
    {
      LLM_PROVIDER: "groq",
      GROQ_API_KEY: "test-groq-key",
      CUSTOM_LLM_PROVIDER: "My Free API",
      CUSTOM_LLM_BASE_URL: "https://api.example.com/v1/",
      CUSTOM_LLM_API_KEY: "test-custom-key",
      CUSTOM_LLM_MODEL: "free-model",
    },
    () => {
      const provider = resolveProvider();
      assert.equal(provider.name, "custom");
      assert.equal(provider.baseURL, "https://api.example.com/v1");
      assert.equal(provider.model, "free-model");
      assert.equal(provider.apiKey, "test-custom-key");
      assert.equal(provider.label, "My Free API");
    },
  );
});

test("partial custom provider configuration fails clearly instead of silently falling back", () => {
  withEnv(
    { GROQ_API_KEY: "test-groq-key", CUSTOM_LLM_PROVIDER: "My Free API" },
    () => assert.throws(() => resolveProvider(), /Custom LLM provider configuration is incomplete/),
  );
});

test("custom provider base URLs must be safe HTTP or HTTPS URLs", () => {
  withEnv(
    {
      CUSTOM_LLM_PROVIDER: "My Free API",
      CUSTOM_LLM_BASE_URL: "javascript:alert(1)",
      CUSTOM_LLM_API_KEY: "test-custom-key",
      CUSTOM_LLM_MODEL: "free-model",
    },
    () => assert.throws(() => resolveProvider(), /CUSTOM_LLM_BASE_URL must use HTTPS/),
  );
});

test("custom providers reject non-local HTTP endpoints that would expose the API key", () => {
  withEnv(
    {
      CUSTOM_LLM_PROVIDER: "My Free API",
      CUSTOM_LLM_BASE_URL: "http://api.example.com/v1",
      CUSTOM_LLM_API_KEY: "test-custom-key",
      CUSTOM_LLM_MODEL: "free-model",
    },
    () => assert.throws(() => resolveProvider(), /must use HTTPS \(or local loopback HTTP\)/),
  );
});

test("custom provider API calls use its configured endpoint and model", async () => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    CUSTOM_LLM_PROVIDER: "My Free API",
    CUSTOM_LLM_BASE_URL: "https://api.example.com/v1",
    CUSTOM_LLM_API_KEY: "test-custom-key",
    CUSTOM_LLM_MODEL: "free-model",
    ANTRAL_TEST_DISABLE_SAVED_LLM_PROFILES: "1",
  });

  const originalPost = axios.post;
  let request;
  axios.post = async (url, body, options) => {
    request = { url, body, options };
    return { data: { choices: [{ message: { role: "assistant", content: "Custom provider response" } }] } };
  };

  try {
    const result = await chat({ messages: [{ role: "user", content: "Hello" }] });
    assert.equal(request.url, "https://api.example.com/v1/chat/completions");
    assert.equal(request.body.model, "free-model");
    assert.equal(request.options.headers.Authorization, "Bearer test-custom-key");
    assert.equal(result.provider, "My Free API");
    assert.equal(result.message.content, "Custom provider response");
  } finally {
    axios.post = originalPost;
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("an empty provider reply fails over instead of becoming a successful empty run", async () => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    LLM_PROVIDER: "groq",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
    ANTRAL_TEST_DISABLE_SAVED_LLM_PROFILES: "1",
  });

  const originalPost = axios.post;
  const requests = [];
  axios.post = async (url, _body, options) => {
    requests.push({ url, streaming: options.responseType === "stream" });
    if (url.includes("groq.com") && options.responseType === "stream") {
      return {
        data: Readable.from(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]),
      };
    }
    if (options.responseType === "stream") {
      return {
        data: Readable.from([
          'data: {"choices":[{"delta":{"content":"Recovered response"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    }
    const content = url.includes("groq.com") ? "" : "Recovered response";
    return { data: { choices: [{ message: { role: "assistant", content } }] } };
  };

  try {
    const result = await chat({
      messages: [{ role: "user", content: "Add this car to the garage." }],
      onToken: () => {},
    });
    assert.equal(result.message.content, "Recovered response");
    assert.deepEqual(requests, [
      { url: "https://api.groq.com/openai/v1/chat/completions", streaming: true },
      { url: "https://openrouter.ai/api/v1/chat/completions", streaming: true },
    ]);
  } finally {
    axios.post = originalPost;
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("an empty reply from every configured provider is reported as an error", async () => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, { LLM_PROVIDER: "groq", GROQ_API_KEY: "test-groq-key", ANTRAL_TEST_DISABLE_SAVED_LLM_PROFILES: "1" });

  const originalPost = axios.post;
  axios.post = async () => ({ data: { choices: [{ message: { role: "assistant", content: "  " } }] } });

  try {
    await assert.rejects(
      chat({ messages: [{ role: "user", content: "Add this car to the garage." }] }),
      /The model returned an empty response/,
    );
  } finally {
    axios.post = originalPost;
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
