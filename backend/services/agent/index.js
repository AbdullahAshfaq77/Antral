import "dotenv/config";
import "../../shared/dns.js"; // pin DNS so LLM provider hosts resolve reliably
import express from "express";
import cors from "cors";
import consentRoutes from "./routes/consent.routes.js";
import agentRoutes from "./routes/agent.routes.js";
import { markInterruptedRuns } from "./lib/agent/orchestrator.js";
import { LOCAL_COMPUTER_TARGET_ENABLED } from "./lib/policies.js";
import { applyProviderConfig } from "./lib/agent/llm.js";
import { getLlmConfig } from "./data/settings.js";

const port = process.env.PORT;

const app = express();

// Behind the gateway proxy; trust it so req IP reflects the real client.
app.set("trust proxy", true);
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || true,
    credentials: true,
  }),
);
app.use((req, res, next) => {
  const isRunRequest = req.method === "POST" && /(?:^|\/)runs$/.test(req.path);
  express.json({ limit: isRunRequest ? "21mb" : "64kb" })(req, res, next);
});

app.get("/", (_req, res) => {
  res.json({ message: "Hello from agent" });
});

app.use(consentRoutes);
app.use(agentRoutes);

app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "The request is too large. Attach images totaling no more than 15 MB." });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "The request body is invalid. Please try again." });
  }
  console.error(err);
  res.status(500).json({ message: "Something went wrong. Please try again." });
});

const start = async () => {
  // Sessions and conversation memory now live in the shared local SQLite
  // database (opened on first use), so no Redis connection is needed.
  // Apply the user's stored AI provider + key (desktop app) onto the env so the
  // provider logic picks it up.
  applyProviderConfig(getLlmConfig());
  await markInterruptedRuns().catch((e) => console.error("Could not mark interrupted runs:", e.message));
  const listening = () => {
    console.log(`agent service is running on port ${port}`);
    if (LOCAL_COMPUTER_TARGET_ENABLED) {
      console.log("  mode: DESKTOP (ANTRAL_LOCAL_DESKTOP=1) — Global (This PC) is available.");
    } else {
      console.warn(
        "\n  ⚠  mode: NON-DESKTOP (ANTRAL_LOCAL_DESKTOP is not set).\n" +
          "     Global (This PC) is DISABLED and will be hidden in the target selector;\n" +
          '     switching to Global will fail with "available only in the local desktop app".\n' +
          "     If you want Global, stop this and start the whole stack with:  npm run desktop\n" +
          "     (Do not start the dev services alongside it — the flagless agent here would answer instead.)\n",
      );
    }
  };
  if (LOCAL_COMPUTER_TARGET_ENABLED) app.listen(port, "127.0.0.1", listening);
  else app.listen(port, listening);
};

start().catch((error) => {
  console.error("Failed to start agent service:", error.message);
  process.exitCode = 1;
});
