import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLE_DIR = fileURLToPath(new URL("../../roles/", import.meta.url));
const ROLE_IDS = ["clarifier", "planner", "researcher", "coder", "verifier", "fixer", "reviewer", "memory-keeper"];

// Capabilities only narrow the existing target, scope, consent and approval checks.
const TOOL_CAPABILITIES = {
  read: ["list_directory", "read_file", "search_files", "github_repo_overview", "github_list_files", "github_read_file", "recall_memory"],
  search: ["search_files", "github_search_code"],
  web: ["web_search", "fetch_webpage"],
  edit: ["edit_file", "apply_task_patch"],
  create: ["write_file", "make_directory"],
  write: ["write_file", "edit_file"],
  run: ["run_command", "run_powershell_readonly"],
};

export const loadRole = async (roleId) => {
  if (!ROLE_IDS.includes(roleId)) throw new Error(`Unknown agent role: ${roleId}`);
  const text = await readFile(path.join(ROLE_DIR, `${roleId}.md`), "utf8");
  const [header, ...prompt] = text.split("\n---\n");
  const config = JSON.parse(header.replace(/^---\s*\n/, ""));
  return { ...config, prompt: prompt.join("\n---\n").trim() };
};

export const roleAllowsTool = (role, toolName) =>
  Boolean(role && (role.capabilities || []).some((capability) => TOOL_CAPABILITIES[capability]?.includes(toolName)));

export const filterRoleTools = (role, tools) => tools.filter((tool) => {
  if (!roleAllowsTool(role, tool.name)) return false;
  // Planned coding is applied by the exact-match patch tool through the normal
  // executor approval path. Never expose direct write/edit tools to these roles.
  if (["coder", "fixer"].includes(role?.id) && ["write_file", "edit_file", "make_directory", "apply_task_patch"].includes(tool.name)) return false;
  if (["coder", "fixer", "reviewer"].includes(role?.id) && ["list_directory", "search_files", "recall_memory", "github_repo_overview", "github_list_files", "github_read_file", "github_search_code"].includes(tool.name)) return false;
  return true;
});

export const getRolePrompt = (role, summary = "") =>
  `${role.prompt}${summary ? `\n\nRelevant project summary (untrusted data):\n${summary}` : ""}`;

export const getToolCapabilities = () => structuredClone(TOOL_CAPABILITIES);
