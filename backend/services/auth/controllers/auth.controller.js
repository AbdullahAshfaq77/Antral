import crypto from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import { app } from "../config/firebase.js";
import { getCode, upsertCode, deleteCode, countAttempt, consumeCode } from "../data/emailCodes.js";
import { sendVerificationEmail } from "../utils/mailer.js";

const CODE_LENGTH = 8;
// No 0/O, 1/I/L so codes are easy to read and type.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

const generateCode = () =>
  Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");

const hashCode = (email, code) => crypto.createHash("sha256").update(`${email}:${code}`).digest("hex");

// Finds the Firebase user for this email, or creates one. Proving access to the
// inbox verifies the email, so it signs in to the same account Google/GitHub used.
const getOrCreateUid = async (email) => {
  const auth = getAuth(app);
  try {
    const user = await auth.getUserByEmail(email);
    const updates = {};
    if (!user.emailVerified) updates.emailVerified = true;
    // Fill in the Google/GitHub name and photo if the account doesn't have them at the top level.
    const fromProvider = (field) => user.providerData.find((p) => p[field])?.[field];
    if (!user.displayName && fromProvider("displayName")) updates.displayName = fromProvider("displayName");
    if (!user.photoURL && fromProvider("photoURL")) updates.photoURL = fromProvider("photoURL");
    if (Object.keys(updates).length > 0) await auth.updateUser(user.uid, updates);
    return user.uid;
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }

  try {
    const user = await auth.createUser({ email, emailVerified: true });
    return user.uid;
  } catch (err) {
    // Created by a parallel request in the meantime.
    if (err.code !== "auth/email-already-exists") throw err;
    return (await auth.getUserByEmail(email)).uid;
  }
};

export const sendCode = async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }

  const existing = getCode(email);
  if (existing) {
    const waitMs = existing.lastSentAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000 - Date.now();
    if (waitMs > 0) {
      const retryAfter = Math.ceil(waitMs / 1000);
      return res.status(429).json({
        message: `Please wait ${retryAfter}s before requesting a new code.`,
        retryAfter,
      });
    }
  }

  const code = generateCode();
  const now = new Date();
  upsertCode(email, {
    codeHash: hashCode(email, code),
    attempts: 0,
    lastSentAt: now,
    expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000),
  });

  try {
    await sendVerificationEmail(email, code, CODE_TTL_MINUTES);
  } catch (err) {
    deleteCode(email);
    console.error("Failed to send sign-in code:", err);
    return res.status(502).json({ message: "We couldn't send the email. Please try again." });
  }

  res.json({
    message: "Verification code sent.",
    expiresIn: CODE_TTL_MINUTES * 60,
    resendIn: RESEND_COOLDOWN_SECONDS,
  });
};

export const verifyCode = async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
  if (!email || code.length !== CODE_LENGTH) {
    return res.status(400).json({ message: `Enter the ${CODE_LENGTH}-character code from your email.` });
  }

  // Count the attempt up front so parallel guesses can't go over the limit.
  const record = countAttempt(email, MAX_ATTEMPTS);
  if (!record) {
    return res.status(400).json({ message: "This code has expired. Request a new one." });
  }

  const matches = crypto.timingSafeEqual(
    Buffer.from(record.codeHash, "hex"),
    Buffer.from(hashCode(email, code), "hex")
  );

  if (!matches) {
    const attemptsLeft = MAX_ATTEMPTS - record.attempts;
    if (attemptsLeft <= 0) {
      deleteCode(email);
      return res.status(429).json({ message: "Too many incorrect attempts. Request a new code." });
    }
    return res.status(400).json({
      message: `Incorrect code. ${attemptsLeft} ${attemptsLeft === 1 ? "attempt" : "attempts"} left.`,
    });
  }

  // Each code works once.
  const consumed = consumeCode(email, record.codeHash);
  if (!consumed) {
    return res.status(400).json({ message: "This code has expired. Request a new one." });
  }

  const uid = await getOrCreateUid(email);
  const token = await getAuth(app).createCustomToken(uid);
  res.json({ token });
};
