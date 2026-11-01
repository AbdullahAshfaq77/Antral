import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { testLlmConnection } from "../controllers/agent.controller.js";

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

test("provider connection test exercises the entered model with the entered key", async () => {
  const originalPost = axios.post;
  const originalGet = axios.get;
  let request;
  axios.post = async (url, body, options) => {
    request = { url, body, options };
    return { data: { choices: [{ message: { role: "assistant", content: "OK" } }] } };
  };
  axios.get = async () => ({ data: { data: [{ id: "provider-model" }, { id: "another-model" }] } });

  try {
    const response = createResponse();
    await testLlmConnection({
      body: {
        baseUrl: "https://provider.example/v1",
        apiKey: "test-api-key",
        model: "provider-model",
        provider: "custom",
      },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "ok");
    assert.equal(request.url, "https://provider.example/v1/chat/completions");
    assert.equal(request.body.model, "provider-model");
    assert.equal(request.body.stream, false);
    assert.equal(request.options.headers.Authorization, "Bearer test-api-key");
    assert.doesNotMatch(JSON.stringify(response.body), /test-api-key/);
    assert.deepEqual(response.body.models, ["provider-model", "another-model"]);
  } finally {
    axios.post = originalPost;
    axios.get = originalGet;
  }
});

test("provider connection test succeeds when model discovery is unsupported", async () => {
  const originalPost = axios.post;
  const originalGet = axios.get;
  axios.post = async () => ({ data: { choices: [{ message: { role: "assistant", content: "OK" } }] } });
  axios.get = async () => {
    throw Object.assign(new Error("not supported"), { response: { status: 404 } });
  };

  try {
    const response = createResponse();
    await testLlmConnection({
      body: { baseUrl: "https://provider.example/v1", apiKey: "test-key", model: "provider-model", provider: "custom" },
    }, response);
    assert.equal(response.body.status, "ok");
    assert.deepEqual(response.body.models, []);
  } finally {
    axios.post = originalPost;
    axios.get = originalGet;
  }
});

test("provider connection test reports invalid keys and unavailable models", async () => {
  const originalPost = axios.post;
  try {
    const response = createResponse();
    axios.post = async () => {
      throw Object.assign(new Error("request failed"), { response: { status: 401 } });
    };
    await testLlmConnection({
      body: { baseUrl: "https://provider.example/v1", apiKey: "bad-key", model: "provider-model", provider: "custom" },
    }, response);
    assert.equal(response.body.status, "invalid_key");

    axios.post = async () => {
      throw Object.assign(new Error("request failed"), { response: { status: 404 } });
    };
    const unavailable = createResponse();
    await testLlmConnection({
      body: { baseUrl: "https://provider.example/v1", apiKey: "test-key", model: "missing-model", provider: "custom" },
    }, unavailable);
    assert.equal(unavailable.body.status, "model_unavailable");
  } finally {
    axios.post = originalPost;
  }
});

test("provider connection test rejects a missing model before making a request", async () => {
  const originalPost = axios.post;
  axios.post = async () => {
    throw new Error("A request should not be made without a model ID.");
  };

  try {
    const response = createResponse();
    await testLlmConnection({
      body: { baseUrl: "https://provider.example/v1", apiKey: "test-key", provider: "custom" },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /model ID/);
  } finally {
    axios.post = originalPost;
  }
});
