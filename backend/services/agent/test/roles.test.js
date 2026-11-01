import test from "node:test";
import assert from "node:assert/strict";
import { loadRole, filterRoleTools } from "../lib/agent/roles.js";
import { encryptSecret, decryptSecret } from "../data/secretStore.js";

test("role capability lists narrow access to the declared tools", async () => {
  const tools = ["read_file", "web_search", "edit_file", "write_file", "run_command"].map((name) => ({ name }));
  const researcher = await loadRole("researcher");
  const coder = await loadRole("coder");
  assert.deepEqual(filterRoleTools(researcher, tools).map((tool) => tool.name), ["web_search"]);
  assert.deepEqual(filterRoleTools(coder, tools).map((tool) => tool.name), ["read_file"]);
  assert.equal((await loadRole("verifier")).llm, false);
});

test("provider secrets round-trip through the Windows current-user keystore", { skip: process.platform !== "win32" }, () => {
  const encrypted = encryptSecret("provider-key-test-1234");
  assert.notEqual(encrypted, "provider-key-test-1234");
  assert.equal(decryptSecret(encrypted), "provider-key-test-1234");
});
