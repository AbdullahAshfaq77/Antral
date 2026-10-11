import crypto from "node:crypto";
import { db } from "../../../../shared/localdb.js";
import { estimateTokens } from "./limits.js";
import { summarize } from "./context.js";
import { redactSecrets } from "./redact.js";

// Conversation memory in the shared local SQLite database (previously Redis). A
// conversation is a series of runs on one target. Each finished run adds the
// user's request and the agent's answer, so the next request continues where
// the last left off. When the history grows past the agent's historyTokens
// budget, the oldest turns are folded into a rolling summary. Conversations
// expire after MEMORY_TTL_DAYS of inactivity.

const TTL_MS = (Number(process.env.MEMORY_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGE_CHARS = 8_000;

export const isConversationId = (id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);

const parseMeta = (row) =>
  row
    ? {
        id: row.id,
        title: row.title || "",
        target: { type: row.target_type, identifier: row.target_id, label: row.target_label || "" },
        summary: row.summary || "",
        turns: Number(row.turns || 0),
        createdAt: new Date(Number(row.created_at)),
        updatedAt: new Date(Number(row.updated_at)),
      }
    : null;

// --- statements ---
const stmtGetConv = db.prepare("SELECT * FROM conversations WHERE uid = ? AND id = ?");
const stmtInsertConv = db.prepare(
  `INSERT INTO conversations (uid, id, title, target_type, target_id, target_label, summary, turns, created_at, updated_at)
   VALUES (@uid, @id, @title, @target_type, @target_id, @target_label, '', 0, @now, @now)`,
);
const stmtListConv = db.prepare(
  "SELECT * FROM conversations WHERE uid = ? ORDER BY updated_at DESC LIMIT ?",
);
const stmtDeleteConv = db.prepare("DELETE FROM conversations WHERE uid = ? AND id = ?");
const stmtDeleteMsgs = db.prepare("DELETE FROM messages WHERE uid = ? AND conv_id = ?");
const stmtGetMsgs = db.prepare(
  "SELECT role, content, at, tools FROM messages WHERE uid = ? AND conv_id = ? ORDER BY seq ASC",
);
const stmtNextSeq = db.prepare(
  "SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM messages WHERE uid = ? AND conv_id = ?",
);
const stmtInsertMsg = db.prepare(
  "INSERT INTO messages (uid, conv_id, seq, role, content, at, tools) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const stmtBumpTurn = db.prepare(
  "UPDATE conversations SET updated_at = ?, turns = turns + 1 WHERE uid = ? AND id = ?",
);
const stmtSetSummary = db.prepare(
  "UPDATE conversations SET summary = ? WHERE uid = ? AND id = ?",
);
const stmtMoveTarget = db.prepare(
  "UPDATE conversations SET target_type = ?, target_id = ?, target_label = ? WHERE uid = ? AND id = ?",
);
const stmtCount = db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE uid = ?");

export const createConversation = async (uid, { target, title }) => {
  const id = crypto.randomUUID();
  const now = Date.now();
  stmtInsertConv.run({
    uid,
    id,
    title: redactSecrets(title).slice(0, 120),
    target_type: target.type,
    target_id: target.identifier,
    target_label: target.label || "",
    now,
  });

  // Keep only the most recent conversations.
  if (stmtCount.get(uid).n > MAX_CONVERSATIONS) {
    const stale = db
      .prepare(
        "SELECT id FROM conversations WHERE uid = ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?",
      )
      .all(uid, MAX_CONVERSATIONS);
    const drop = db.transaction((rows) => {
      for (const r of rows) {
        stmtDeleteConv.run(uid, r.id);
        stmtDeleteMsgs.run(uid, r.id);
      }
    });
    drop(stale);
  }
  return id;
};

export const getConversation = async (uid, id) => {
  if (!isConversationId(id)) return null;
  return parseMeta(stmtGetConv.get(uid, id));
};

export const getMessages = async (uid, id) =>
  stmtGetMsgs.all(uid, id).map((m) => ({
    role: m.role,
    content: m.content,
    at: Number(m.at),
    ...(m.tools ? { tools: JSON.parse(m.tools) } : {}),
  }));

// History to give the model: the rolling summary plus remembered turns.
export const loadHistory = async (uid, id) => {
  const meta = await getConversation(uid, id);
  const messages = await getMessages(uid, id);
  return {
    summary: meta?.summary || "",
    messages: messages.map(({ role, content }) => ({ role, content })),
  };
};

// Records one finished run: the user's request and the agent's answer.
export const appendTurn = async (uid, id, { user, assistant, tools = [] }) => {
  const now = Date.now();
  const clean = (content) => redactSecrets(content).slice(0, MAX_MESSAGE_CHARS);
  const write = db.transaction(() => {
    const base = stmtNextSeq.get(uid, id).n;
    stmtInsertMsg.run(uid, id, base, "user", clean(user), now, null);
    stmtInsertMsg.run(
      uid,
      id,
      base + 1,
      "assistant",
      clean(assistant),
      now,
      tools.length ? JSON.stringify([...new Set(tools)]) : null,
    );
    stmtBumpTurn.run(now, uid, id);
  });
  write();
};

// Folds the oldest turns into the summary once history exceeds the budget.
// Returns the number of messages folded (0 if none).
export const compactConversation = async (uid, id, limits, { signal } = {}) => {
  const messages = await getMessages(uid, id);
  if (estimateTokens(messages) <= limits.historyTokens) return 0;

  // Keep recent messages verbatim; fold whole user/assistant pairs.
  let keep = Math.min(limits.keepRecentMessages, messages.length);
  if ((messages.length - keep) % 2) keep += 1;
  const foldCount = messages.length - keep;
  if (foldCount <= 0) return 0;
  const fold = messages.slice(0, foldCount);

  const meta = await getConversation(uid, id);
  const summary = await summarize({
    text: fold.map((m) => `[${m.role}] ${m.content}`).join("\n"),
    previousSummary: meta?.summary || "",
    purpose: "Update the summary of this conversation between the user and the agent.",
    signal,
    maxChars: limits.contextTokens * 2,
  });

  // Delete the oldest foldCount messages (lowest seq) and save the new summary.
  const apply = db.transaction(() => {
    const seqs = db
      .prepare("SELECT seq FROM messages WHERE uid = ? AND conv_id = ? ORDER BY seq ASC LIMIT ?")
      .all(uid, id, foldCount)
      .map((r) => r.seq);
    const delOne = db.prepare("DELETE FROM messages WHERE uid = ? AND conv_id = ? AND seq = ?");
    for (const s of seqs) delOne.run(uid, id, s);
    stmtSetSummary.run(redactSecrets(summary), uid, id);
  });
  apply();
  return foldCount;
};

export const listConversations = async (uid, limit = 30) =>
  stmtListConv.all(uid, limit).map(parseMeta).filter(Boolean);

export const deleteConversation = async (uid, id) => {
  if (!isConversationId(id)) return false;
  const run = db.transaction(() => {
    const res = stmtDeleteConv.run(uid, id);
    stmtDeleteMsgs.run(uid, id);
    return res.changes > 0;
  });
  return run();
};

// Moves a conversation to another target (project); its history comes along.
export const moveConversation = async (uid, id, target) => {
  if (!(await getConversation(uid, id))) return false;
  stmtMoveTarget.run(target.type, target.identifier, target.label || "", uid, id);
  return true;
};

// Forgets every conversation that belongs to a target. Returns how many.
export const deleteConversationsForTarget = async (uid, target) => {
  const ids = db
    .prepare(
      "SELECT id FROM conversations WHERE uid = ? AND target_type = ? AND target_id = ?",
    )
    .all(uid, target.type, target.identifier)
    .map((r) => r.id);
  if (!ids.length) return 0;
  const drop = db.transaction(() => {
    for (const id of ids) {
      stmtDeleteConv.run(uid, id);
      stmtDeleteMsgs.run(uid, id);
    }
  });
  drop();
  return ids.length;
};

// Keyword search across the user's other conversations (titles, summaries,
// messages). Returns the best-matching snippets.
export const searchMemory = async (uid, query, { excludeId, limit = 5 } = {}) => {
  const terms = String(query || "")
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  if (!terms.length) return [];

  const convs = (await listConversations(uid, 50)).filter((c) => c.id !== excludeId);
  const hits = [];
  for (const c of convs) {
    const messages = await getMessages(uid, c.id);
    const docs = [
      { kind: "title", text: c.title },
      { kind: "summary", text: c.summary },
      ...messages.map((m) => ({ kind: m.role, text: m.content, at: m.at })),
    ];
    for (const d of docs) {
      const lower = (d.text || "").toLowerCase();
      const score = terms.reduce((s, t) => s + (lower.includes(t) ? 1 : 0), 0);
      if (!score) continue;
      const first = Math.max(0, Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0)) - 150);
      hits.push({
        score,
        conversation: c.title,
        conversationId: c.id,
        target: c.target.identifier,
        kind: d.kind,
        at: d.at ? new Date(d.at) : c.updatedAt,
        snippet: d.text.slice(first, first + 600),
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, limit);
};

// Drop conversations untouched for longer than the TTL (ran periodically).
const purgeStale = () => {
  const cutoff = Date.now() - TTL_MS;
  const ids = db
    .prepare("SELECT id, uid FROM conversations WHERE updated_at < ?")
    .all(cutoff);
  if (!ids.length) return;
  const drop = db.transaction(() => {
    for (const r of ids) {
      stmtDeleteConv.run(r.uid, r.id);
      stmtDeleteMsgs.run(r.uid, r.id);
    }
  });
  drop();
};
setInterval(() => {
  try {
    purgeStale();
  } catch {
    // ignore
  }
}, 6 * 60 * 60 * 1000).unref?.();
