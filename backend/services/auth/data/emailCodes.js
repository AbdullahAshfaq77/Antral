// Pending email sign-in codes in the shared local SQLite database (replaces the
// Mongoose EmailCode model). Only a hash of the code is stored. Keyed by email,
// which is unique.
import { db } from "../../../shared/localdb.js";

const stmtGet = db.prepare("SELECT * FROM email_codes WHERE email = ?");
const stmtUpsert = db.prepare(`
  INSERT INTO email_codes (email, code_hash, attempts, last_sent_at, expires_at)
  VALUES (@email, @codeHash, @attempts, @lastSentAt, @expiresAt)
  ON CONFLICT(email) DO UPDATE SET
    code_hash = excluded.code_hash,
    attempts = excluded.attempts,
    last_sent_at = excluded.last_sent_at,
    expires_at = excluded.expires_at
`);
const stmtDelete = db.prepare("DELETE FROM email_codes WHERE email = ?");

const toRecord = (row) =>
  row
    ? {
        email: row.email,
        codeHash: row.code_hash,
        attempts: Number(row.attempts),
        lastSentAt: new Date(Number(row.last_sent_at)),
        expiresAt: new Date(Number(row.expires_at)),
      }
    : null;

export const getCode = (email) => toRecord(stmtGet.get(email));

export const upsertCode = (email, { codeHash, attempts, lastSentAt, expiresAt }) => {
  stmtUpsert.run({
    email,
    codeHash,
    attempts,
    lastSentAt: lastSentAt.getTime(),
    expiresAt: expiresAt.getTime(),
  });
};

export const deleteCode = (email) => {
  stmtDelete.run(email);
};

// Atomically count one verification attempt: only if the code exists, hasn't
// expired, and is under the attempt limit. Returns the record (with the
// incremented attempt count) or null. Mirrors the old findOneAndUpdate guard.
const attemptTxn = db.transaction((email, maxAttempts, nowMs) => {
  const row = stmtGet.get(email);
  if (!row || Number(row.expires_at) <= nowMs || Number(row.attempts) >= maxAttempts) return null;
  const attempts = Number(row.attempts) + 1;
  db.prepare("UPDATE email_codes SET attempts = ? WHERE email = ?").run(attempts, email);
  return { ...row, attempts };
});

export const countAttempt = (email, maxAttempts) => {
  const row = attemptTxn(email, maxAttempts, Date.now());
  return row
    ? { email: row.email, codeHash: row.code_hash, attempts: row.attempts }
    : null;
};

// Deletes the code only if its hash still matches (one-time use). Returns true
// if a row was deleted. Mirrors findOneAndDelete({_id, codeHash}).
const consumeTxn = db.transaction((email, codeHash) => {
  const res = db
    .prepare("DELETE FROM email_codes WHERE email = ? AND code_hash = ?")
    .run(email, codeHash);
  return res.changes > 0;
});

export const consumeCode = (email, codeHash) => consumeTxn(email, codeHash);
