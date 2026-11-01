import test from "node:test";
import assert from "node:assert/strict";
import { migrateRetiredOpenRouterFreeModel } from "../data/settings.js";

test("migrates the retired OpenRouter free slug to the free-model router", () => {
  const profile = {
    id: "openrouter",
    name: "OpenRouter",
    models: [{ id: "openai/gpt-oss-120b:free", tier: "best", enabled: true, priority: 0 }],
  };

  const migrated = migrateRetiredOpenRouterFreeModel(profile);

  assert.deepEqual(migrated.models, [{ id: "openrouter/free", tier: "best", enabled: true, priority: 0 }]);
  assert.equal(migrated.name, "OpenRouter");
  assert.notEqual(migrated, profile);
});

test("does not change other OpenRouter models or profiles", () => {
  const model = { id: "openrouter/free", tier: "best", enabled: true, priority: 0 };
  const openRouter = { id: "openrouter", models: [model] };
  const otherProvider = { id: "groq", models: [{ id: "openai/gpt-oss-120b:free" }] };

  assert.equal(migrateRetiredOpenRouterFreeModel(openRouter), openRouter);
  assert.equal(migrateRetiredOpenRouterFreeModel(otherProvider), otherProvider);
});
