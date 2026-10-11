// App-level settings in the shared local SQLite database. In the desktop app
// each install holds its own AI provider + API key here (the user's own key,
// entered on first run). Single-user per install, so these are global app
// settings, not per-user.
import { kvGet, kvSet, kvDel } from "../../../shared/localdb.js";

const K = {
  provider: "setting:llm_provider",
  apiKey: "setting:llm_api_key",
  accountId: "setting:llm_account_id",
  model: "setting:llm_model",
  visionModel: "setting:llm_vision_model",
};

export const getLlmConfig = () => ({
  provider: kvGet(K.provider) || null,
  apiKey: kvGet(K.apiKey) || null,
  accountId: kvGet(K.accountId) || null,
  model: kvGet(K.model) || null,
  visionModel: kvGet(K.visionModel) || null,
});

// Sets only the fields provided. An empty string clears an optional field.
export const setLlmConfig = ({ provider, apiKey, accountId, model, visionModel }) => {
  if (provider != null) kvSet(K.provider, provider);
  if (apiKey) kvSet(K.apiKey, apiKey); // never clear the key with an empty value
  const optional = (key, value) => {
    if (value === undefined) return;
    if (value) kvSet(key, value);
    else kvDel(key);
  };
  optional(K.accountId, accountId);
  optional(K.model, model);
  optional(K.visionModel, visionModel);
};
