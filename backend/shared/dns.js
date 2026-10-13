import dns from "node:dns";

// Some networks' default resolver can't reliably reach external API hosts
// (googleapis.com for Firebase cert verification, api.groq.com and
// generativelanguage.googleapis.com for the LLM providers). The DB layer used
// to pin DNS to public resolvers as a side effect; now that auth and agent no
// longer use MongoDB, we do it here. Importing this module applies it.
try {
  dns.setServers(["1.1.1.1", "8.8.8.8", ...dns.getServers()]);
} catch {
  // ignore — fall back to the system resolver
}
