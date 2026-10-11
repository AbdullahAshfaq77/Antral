// Shared local database for the desktop app.
//
// All four services are separate processes but share one SQLite file, so the
// auth service can write a session the agent service then reads — the same role
// Redis played before. SQLite in WAL mode supports this safe multi-process
// access. The file lives in ANTRAL_DATA_DIR (set by Electron to the app's user
// data folder); in development it defaults to <repo>/backend/.data.
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const defaultDir = path.resolve(fileURLToPath(new URL("../.data", import.meta.url)));
const dataDir = process.env.ANTRAL_DATA_DIR || defaultDir;
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "antral.db"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// Schema. Every service runs this; CREATE IF NOT EXISTS makes it idempotent.
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    expires_at INTEGER            -- epoch ms, or NULL for no expiry
  );

  CREATE TABLE IF NOT EXISTS conversations (
    uid TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT DEFAULT '',
    target_type TEXT,
    target_id TEXT,
    target_label TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    turns INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (uid, id)
  );
  CREATE INDEX IF NOT EXISTS idx_conv_uid_updated ON conversations (uid, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    uid TEXT NOT NULL,
    conv_id TEXT NOT NULL,
    seq INTEGER NOT NULL,         -- order within the conversation
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    at INTEGER NOT NULL,
    tools TEXT,                   -- JSON array, or NULL
    PRIMARY KEY (uid, conv_id, seq)
  );
`);

// ---------------------------------------------------------------------------
// Key/value store (replaces the Redis commands used for sessions).
// ---------------------------------------------------------------------------
const now = () => Date.now();

const _get = db.prepare("SELECT v, expires_at FROM kv WHERE k = ?");
const _set = db.prepare(
  "INSERT INTO kv (k, v, expires_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at",
);
const _del = db.prepare("DELETE FROM kv WHERE k = ?");
const _purge = db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < ?");

export const kvGet = (key) => {
  const row = _get.get(key);
  if (!row) return null;
  if (row.expires_at != null && row.expires_at < now()) {
    _del.run(key);
    return null;
  }
  return row.v;
};

export const kvSet = (key, value, ttlSeconds) => {
  const expires = ttlSeconds ? now() + ttlSeconds * 1000 : null;
  _set.run(key, value, expires);
};

export const kvDel = (key) => {
  _del.run(key);
};

// Occasionally drop expired keys so the table doesn't grow forever.
export const purgeExpired = () => _purge.run(now());
setInterval(() => {
  try {
    purgeExpired();
  } catch {
    // ignore
  }
}, 60 * 60 * 1000).unref?.();
