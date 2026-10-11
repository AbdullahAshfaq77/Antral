// User records in the shared local SQLite database (replaces the Mongoose User
// model). The authoritative identity still comes from Firebase; this is the
// local profile (name, date of birth, etc.).
import { db } from "../../../shared/localdb.js";

const stmtGet = db.prepare("SELECT * FROM users WHERE firebase_uid = ?");
const stmtUpsert = db.prepare(`
  INSERT INTO users (firebase_uid, name, first_name, last_name, date_of_birth, email, provider, created_at, updated_at)
  VALUES (@uid, @name, @firstName, @lastName, @dateOfBirth, @email, @provider, @now, @now)
  ON CONFLICT(firebase_uid) DO UPDATE SET
    name = excluded.name,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    date_of_birth = excluded.date_of_birth,
    email = excluded.email,
    provider = excluded.provider,
    updated_at = excluded.updated_at
`);

const toUser = (row) =>
  row
    ? {
        firebaseUid: row.firebase_uid,
        name: row.name || "",
        firstName: row.first_name || "",
        lastName: row.last_name || "",
        dateOfBirth: row.date_of_birth || "",
        email: row.email || "",
        provider: row.provider || "email",
        status: row.status || "active",
      }
    : null;

export const getUserByUid = (uid) => toUser(stmtGet.get(uid));

export const upsertUserProfile = (uid, { firstName, lastName, dateOfBirth, name, email, provider }) => {
  stmtUpsert.run({
    uid,
    name: name || "",
    firstName: firstName || "",
    lastName: lastName || "",
    dateOfBirth: dateOfBirth || "",
    email: email || "",
    provider: provider || "email",
    now: Date.now(),
  });
};
