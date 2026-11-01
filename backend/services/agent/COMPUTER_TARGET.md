# This PC target

The **This PC** target is available only in the Electron desktop launcher
(`npm run desktop`). That launcher enables the target for its local agent
service and binds the agent and gateway to loopback. Hosted and browser-only
services do not enable this target.

Authorize **This PC** from the chat target selector or Settings. It starts with
read-source access only. File tools can inspect accessible local drives; file
paths are absolute (for example, `C:\Users\name\Documents`). Files the agent
reads may be sent to the configured AI provider.

To enable changes or PowerShell, grant the corresponding target permission in
Settings. Every file change and every PowerShell command then requires a
separate approval. Saved "Always allow" rules do not bypass approvals for This
PC. Direct network-share and device paths are refused.

When a specific local folder is selected in the desktop app, you can separately
grant **Find & open applications** and **View & close running programs** for
that folder target. Those permissions allow only the named application/process
tools to act across this PC; file access and other tools remain limited to the
selected folder. App launches require approval, and every process close requires
a fresh approval. Force closing is only available after a graceful close fails.
