# Role runner and supervisor hook

`runRole(roleId, input, ctx)` in `lib/agent/orchestrator.js` starts the normal audited run lifecycle with a role prompt, tier selection, optional pinned model, and registry-tool filtering. The executor checks role capabilities again before permission, consent, and approval checks; role limits only narrow access. Verifier bypasses the model and runs the explicit `verifyCommand` once through the existing approved command tool, then returns exit code, first error, and a short stack as JSON.

The future supervisor can call `runRole` for Clarifier → Planner → Researcher/Coder → Verifier → Fixer → Reviewer and call Memory keeper after milestones. It should pass each planned task's file allowlist and acceptance check explicitly, persist attempt counts, and stop for user input when providers are all down. The supervisor loop is intentionally not implemented here.

The role configuration is a hook, not a complete autonomous workflow.
