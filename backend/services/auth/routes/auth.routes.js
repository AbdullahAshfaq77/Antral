import { Router } from "express";
import { getProfile, saveProfile } from "../controllers/profile.controller.js";
import { endSession, requireSession, startSession } from "../controllers/session.controller.js";

// Email sign-in is now handled client-side by the Firebase SDK (email/password),
// like Google/GitHub — so there are no backend email-code routes. The backend
// only starts a session from a verified Firebase ID token.
const router = Router();

router.post("/session", startSession);
router.delete("/session", endSession);
router.get("/profile", requireSession, getProfile);
router.put("/profile", requireSession, saveProfile);

export default router;
