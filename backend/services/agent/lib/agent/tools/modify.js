import fs from "node:fs/promises";
import path from "node:path";
import { registerTool } from "./registry.js";
import { isTargetRoot, relativeToTarget, resolveTargetPath } from "../pathGuard.js";
import { runPowerShell } from "../shell.js";

// Tools that change the user's system. All are `mutating`, so the executor
// pauses the run and asks the user to Allow once / Always allow / Decline
// before each call, unless an always-allow rule already covers it.
//
// Extra fields used by the approval flow:
//   describe(args)   one-line summary shown in the approval prompt
//   ruleFor(args)    the always-allow rule this call would match, or null if
//                    the call is too risky to ever be covered by a rule

const MAX_WRITE_BYTES = 1024 * 1024;
const lineCount = (s) => (s ? s.split(/\r?\n/).length : 0);

const exists = (p) =>
  fs.stat(p).then(
    (s) => s,
    () => null,
  );

registerTool({
  name: "write_file",
  category: "computer",
  description:
    "Create a file, or replace a file's entire contents, inside the target. Parent folders are created as needed. " +
    "For small changes to an existing file prefer edit_file.",
  scope: "modify_files",
  targetTypes: ["local", "computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to a local folder target. For This PC, use an absolute local path." },
      content: { type: "string", description: "The complete new file contents." },
    },
    required: ["path", "content"],
  },
  describe: ({ path: p, content = "" }) => `Write ${lineCount(content)} lines to ${p}`,
  ruleFor: () => "write_file",
  run: async ({ path: p, content }, ctx) => {
    if (typeof content !== "string") throw new Error("content must be a string.");
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error("content is larger than 1 MB.");
    const file = await resolveTargetPath(ctx.target, ctx.root, p);
    const before = await exists(file);
    if (before?.isDirectory()) throw new Error(`${p} is a folder.`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return `${before ? "Replaced" : "Created"} ${relativeToTarget(ctx.target, ctx.root, file)} (${lineCount(content)} lines).`;
  },
});

registerTool({
  name: "edit_file",
  category: "computer",
  description:
    "Replace exact text in an existing file inside the target. oldText must match the file exactly (including indentation) " +
    "and appear once, unless replaceAll is true. Read the file first.",
  scope: "modify_files",
  targetTypes: ["local", "computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to a local folder target. For This PC, use an absolute local path." },
      oldText: { type: "string", description: "Exact text to replace." },
      newText: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace every occurrence. Default false." },
    },
    required: ["path", "oldText", "newText"],
  },
  describe: ({ path: p, oldText = "", newText = "" }) =>
    `Edit ${p}: replace ${lineCount(oldText)} line(s) with ${lineCount(newText)} line(s)`,
  ruleFor: () => "edit_file",
  run: async ({ path: p, oldText, newText, replaceAll = false }, ctx) => {
    if (typeof oldText !== "string" || !oldText) throw new Error("oldText must be a non-empty string.");
    if (typeof newText !== "string") throw new Error("newText must be a string.");
    const file = await resolveTargetPath(ctx.target, ctx.root, p);
    const original = await fs.readFile(file, "utf8");
    // Accept LF text for CRLF files.
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const find = original.includes(oldText) ? oldText : oldText.replace(/\r?\n/g, eol);
    const replacement = find === oldText ? newText : newText.replace(/\r?\n/g, eol);
    const count = original.split(find).length - 1;
    if (count === 0) throw new Error("oldText was not found in the file. Read the file again and copy the text exactly.");
    if (count > 1 && !replaceAll) throw new Error(`oldText appears ${count} times. Add more context or set replaceAll.`);
    const updated = replaceAll ? original.split(find).join(replacement) : original.replace(find, () => replacement);
    await fs.writeFile(file, updated, "utf8");
    return `Edited ${relativeToTarget(ctx.target, ctx.root, file)}: ${replaceAll ? count : 1} replacement(s).`;
  },
});

registerTool({
  name: "make_directory",
  category: "computer",
  description: "Create a folder (and any missing parents) inside the target.",
  scope: "modify_files",
  targetTypes: ["local", "computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Folder path relative to a local folder target. For This PC, use an absolute local path." } },
    required: ["path"],
  },
  describe: ({ path: p }) => `Create folder ${p}`,
  ruleFor: () => "make_directory",
  run: async ({ path: p }, ctx) => {
    const dir = await resolveTargetPath(ctx.target, ctx.root, p);
    await fs.mkdir(dir, { recursive: true });
    return `Created ${relativeToTarget(ctx.target, ctx.root, dir)}/`;
  },
});

registerTool({
  name: "move_path",
  category: "computer",
  description: "Move or rename a file or folder inside the target. Fails if the destination already exists.",
  scope: "modify_files",
  targetTypes: ["local", "computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Existing path relative to a local folder target. For This PC, use an absolute local path." },
      to: { type: "string", description: "New path relative to a local folder target. For This PC, use an absolute local path." },
    },
    required: ["from", "to"],
  },
  describe: ({ from, to }) => `Move ${from} → ${to}`,
  ruleFor: () => "move_path",
  run: async ({ from, to }, ctx) => {
    const src = await resolveTargetPath(ctx.target, ctx.root, from);
    const dest = await resolveTargetPath(ctx.target, ctx.root, to);
    if (isTargetRoot(ctx.target, ctx.root, src)) throw new Error("The target root itself can't be moved.");
    if (!(await exists(src))) throw new Error(`${from} does not exist.`);
    if (await exists(dest)) throw new Error(`${to} already exists.`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    return `Moved ${relativeToTarget(ctx.target, ctx.root, src)} → ${relativeToTarget(ctx.target, ctx.root, dest)}.`;
  },
});

registerTool({
  name: "delete_path",
  category: "computer",
  description:
    "Delete a file or folder inside the target. Folders need recursive: true. Only delete when the user's task calls for it.",
  scope: "modify_files",
  targetTypes: ["local", "computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to a local folder target. For This PC, use an absolute local path." },
      recursive: { type: "boolean", description: "Required to delete a folder and its contents." },
    },
    required: ["path"],
  },
  describe: ({ path: p, recursive }) => `Delete ${p}${recursive ? " (folder and everything in it)" : ""}`,
  ruleFor: () => "delete_path",
  run: async ({ path: p, recursive = false }, ctx) => {
    const target = await resolveTargetPath(ctx.target, ctx.root, p);
    if (isTargetRoot(ctx.target, ctx.root, target)) throw new Error("The target root itself can't be deleted.");
    const stat = await exists(target);
    if (!stat) throw new Error(`${p} does not exist.`);
    if (stat.isDirectory() && !recursive) throw new Error(`${p} is a folder; set recursive to delete it.`);
    await fs.rm(target, { recursive: stat.isDirectory(), force: false });
    return `Deleted ${relativeToTarget(ctx.target, ctx.root, target)}${stat.isDirectory() ? "/" : ""}.`;
  },
});

// Commands chained or wrapped like this could hide a second command behind an
// approved prefix, so they always need a fresh decision.
const COMPOUND = /[;&|`<>\r\n]|\$\(|@\(/;

// What an "always allow" for this command covers:
//   "npm install express" -> "npm install"  (any `npm install …`)
//   "npm test"            -> "npm test"
//   "npm --force publish" -> the exact command only (a flag first could hide
//                            anything behind a bare "npm" rule)
export const commandPrefix = (command) => {
  const tokens = command.trim().toLowerCase().split(/\s+/);
  const first = tokens[0].replace(/\.(cmd|exe|ps1)$/, "");
  if (tokens.length === 1) return first;
  if (/^[a-z][a-z0-9:-]*$/.test(tokens[1])) return `${first} ${tokens[1]}`;
  return [first, ...tokens.slice(1)].join(" ");
};

registerTool({
  name: "run_command",
  category: "computer",
  description:
    "Run a PowerShell command in the target folder: install dependencies, run builds/tests/dev servers, git add/commit, " +
    "apply fixes, etc. The user approves each command. Prefer run_powershell_readonly for inspection. " +
    "Long-running servers are stopped at the timeout.",
  scope: "execute_powershell",
  targetTypes: ["local", "computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The PowerShell command to run." },
      timeoutSeconds: { type: "integer", minimum: 5, maximum: 600, description: "Default 120." },
    },
    required: ["command"],
  },
  describe: ({ command }) => `Run: ${command}`,
  // Compound commands (pipes, ;, &&) can only be always-allowed verbatim.
  ruleFor: ({ command }) =>
    typeof command !== "string" || !command.trim()
      ? null
      : COMPOUND.test(command)
        ? `run_command_exact:${command.trim()}`
        : `run_command:${commandPrefix(command)}`,
  run: async ({ command, timeoutSeconds = 120 }, { root, signal }) => {
    if (typeof command !== "string" || !command.trim()) throw new Error("command is required.");
    if (command.length > 2000) throw new Error("command is too long.");
    const timeoutMs = Math.min(Math.max(Number(timeoutSeconds) || 120, 5), 600) * 1000;
    // The user approved this exact command, so local scripts (npm.ps1 etc.) may run.
    return runPowerShell(command, { cwd: root, signal, timeoutMs, executionPolicy: "Bypass" });
  },
});
