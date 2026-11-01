# Provider and role implementation plan

- Add a JSON provider catalog and role prompt files under `backend/services/agent`.
- Keep the existing OpenAI-compatible chat adapter and use provider profiles from the shared SQLite settings; keep environment variables as developer fallbacks.
- Store provider secrets with current-user Windows DPAPI. The agent, auth, and gateway processes run as the same OS user and can unprotect the shared ciphertext without a shared plaintext key. Settings responses expose only presence and the last four characters.
- Extend the existing settings route/UI and tool executor; preserve per-tool target consent and approval checks.

Implementation is ongoing; this plan does not imply every requested behavior is complete. See `backend/services/agent/ROLES.md` for the supervisor hook and remaining integration notes.
