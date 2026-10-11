# Antral Desktop App — build plan & status

Goal: a free, downloadable desktop app. A user installs it, enters **their own**
AI API key (any supported provider), and the agent runs entirely on their own PC.
No hosting, no cost to us, no shared keys.

## Model
- Everything runs locally per install (all 4 services + agent, started by Electron).
- Agent works on the user's own files (desktop mode: `ANTRAL_LOCAL_DESKTOP=1`).
- The user supplies their own LLM key — we ship nothing secret.
- Updates delivered free via GitHub Releases + electron-updater.

## Phases
- [x] **Phase 1 — Packaging foundation**
  - `desktop/services.cjs` launches the 4 services via Electron's bundled Node
    (`ELECTRON_RUN_AS_NODE=1`), sets ports, enables desktop mode, tells the
    gateway to serve the built frontend.
  - `desktop/main.cjs` runs in production mode when packaged (or `ANTRAL_PROD=1`):
    starts the services, loads the app from the gateway (`127.0.0.1:7000`).
    Dev mode (Vite) unchanged.
  - `electron-builder.yml` + `npm run dist` build a Windows installer. Secrets
    (.env, serviceAccountKey.json) are excluded from the package.
- [~] **Phase 2 — Local storage (the real blocker)** — one shared SQLite file
    (`backend/shared/localdb.js`, `better-sqlite3`, WAL for multi-process) replaces
    both Redis and MongoDB. Data dir = `ANTRAL_DATA_DIR` (Electron userData) or
    `backend/.data` in dev.
  - [x] **Step A — Redis → SQLite** (sessions + conversation memory). Done &
        unit-tested: `kv` table for sessions (auth `sessions.js`, agent
        `attachUser.js`); `conversations`/`messages` tables (agent `memory.js`
        fully rewritten). Redis removed from both services' startup. App still
        uses MongoDB for the 5 models — testable now (login + chat + history).
  - [~] **Step B — MongoDB → SQLite** (done service by service so each stays runnable):
    - [x] **B1 — auth** (user + emailCode → `data/users.js`, `data/emailCodes.js`;
          `users`/`email_codes` tables). Auth now needs NO MongoDB and NO Redis.
          Tested incl. expiry, max-attempts, one-time consume.
    - [x] **B2 — project**: the standalone project service is unused (gateway
          doesn't proxy it; the agent manages projects itself), so the desktop
          app simply doesn't run it. No conversion needed.
    - [~] **B3 — agent** (agentRun + consent). The last data piece.
      - [x] Data layer built + unit-tested: tables for account_consent,
            target_authorization, agent_runs, agent_run_steps; modules
            `agent/data/consent.js` and `agent/data/agentRuns.js` (returned
            objects keep `isCurrentlyValid()`/`versionOf()`). Nothing imports
            them yet, so the app is unchanged.
      - [x] Wiring: all ~40 call sites across 11 files swapped to the data
            modules; Mongo dropped from the agent startup. Every rewired module
            parses and imports cleanly; no Mongoose/Redis refs remain anywhere.
            **The whole app is now SQLite-only — no MongoDB, no Redis.**
            Needs full-flow dev re-test (authorize target, message, approve a
            change, toggle a permission, history).

## Central user tracking (separate, after storage)
Identity + activity only, admin-only. Firebase Auth already lists every user
(name/email/login). Add lightweight activity telemetry to Firestore (client
writes, no server, no shipped secret) with rules allowing admin-only reads.
- [ ] **Phase 3 — First-run key setup UI**
  - Screen to choose provider + paste the user's own key; stored in the OS
    keychain (or encrypted locally) and passed to the agent service.
- [ ] **Phase 4 — Auth decision**
  - Keep Firebase login, or switch to a simple local account (less friction,
    works offline). Needed because data is keyed by user id.
- [ ] **Phase 5 — Release pipeline**
  - electron-builder publish to GitHub Releases + electron-updater auto-update.
  - App icon (`desktop/build/icon.ico`), optional code signing (else SmartScreen
    shows an "unknown publisher" warning).

## Test the production path locally (before a full build)
Needs the backend `.env` files + reachable DB/Redis present (that changes in
Phase 2). Then:
```
npm install            # installs cross-env + electron-builder
npm run build:frontend
npm run prod           # runs Electron in production mode, spawning the services
```

## Build the installer (once Phase 2+ land)
```
npm run dist           # output in dist-desktop/Antral-Setup-<version>.exe
```

## Not done yet / known gaps
- The packaged app will not fully run until Phase 2 (it still expects Mongo/Redis).
- No icon or code signing yet (Phase 5).
