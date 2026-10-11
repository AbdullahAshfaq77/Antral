import { upsertUserProfile } from "../data/users.js";
import { updateSession } from "../utils/sessions.js";

const isDateOfBirth = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value <= new Date().toISOString().slice(0, 10)
  );
};

export const getProfile = async (req, res) => {
  if (!req.session.firstName || !isDateOfBirth(req.session.dateOfBirth)) {
    return res.json({ profile: null });
  }

  return res.json({
    profile: {
      firstName: req.session.firstName,
      lastName: req.session.lastName || "",
      dateOfBirth: req.session.dateOfBirth,
    },
  });
};

export const saveProfile = async (req, res) => {
  const firstName = typeof req.body?.firstName === "string" ? req.body.firstName.trim() : "";
  const lastName = typeof req.body?.lastName === "string" ? req.body.lastName.trim() : "";
  const dateOfBirth = req.body?.dateOfBirth;

  if (req.body?.lastName != null && typeof req.body.lastName !== "string") {
    return res.status(400).json({ message: "Enter a valid last name or leave it blank." });
  }
  if (!firstName || firstName.length > 80) {
    return res.status(400).json({ message: "Enter a first name of 1 to 80 characters." });
  }
  if (lastName.length > 80) {
    return res.status(400).json({ message: "Last name must be 80 characters or fewer." });
  }
  if (!isDateOfBirth(dateOfBirth)) {
    return res.status(400).json({ message: "Enter a valid date of birth that is not in the future." });
  }
  if (!req.session.email) {
    return res.status(400).json({ message: "Your account needs an email address to continue." });
  }

  const name = [firstName, lastName].filter(Boolean).join(" ");
  upsertUserProfile(req.session.uid, {
    firstName,
    lastName,
    dateOfBirth,
    name,
    email: req.session.email,
    provider: req.session.provider,
  });

  const updatedSession = { ...req.session, firstName, lastName, dateOfBirth };
  await updateSession(req.sessionId, updatedSession);
  req.session = updatedSession;

  return res.json({ profile: { firstName, lastName, dateOfBirth } });
};
