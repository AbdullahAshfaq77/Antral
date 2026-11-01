# AI providers

## Enter your own provider key

In Antral, open **Settings → AI providers**. The first panel only lists provider
names detected in the agent environment; API key values from `.env` and
`.env.custom` are ignored for agent requests.

Choose a provider in the provider grid. Its configuration panel appears below
the grid. Paste your personal key into **Your API key**, test the connection,
then select **Save providers**. The provider panel includes the provider's key
signup page. Free usage and billing rules vary by provider, so check its current
terms before use.

Keys entered in Settings are stored in the local settings database encrypted
with the current Windows user's DPAPI protection. The API returns only whether
a key is saved and its final four characters. Provider credentials are local to
that Antral installation and are never shared with another Antral user.

## Choose models for agent roles

After saving a provider and its models, use **Agent role models** to select a
specific model for each role. **Apply recommended settings** selects available
models according to each role's cost and capability tier. Select **Save role
assignments** to persist those choices.

## Custom and local endpoints

Select **Custom OpenAI-compatible endpoint** to enter a provider name and API
base URL, then add a model ID. HTTPS is required except for local loopback HTTP
endpoints such as Ollama or LM Studio. The endpoint must support OpenAI-compatible
chat completions and tool/function calling for agent tools.
