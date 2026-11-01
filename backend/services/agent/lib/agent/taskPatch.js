import fs from "node:fs/promises";
import path from "node:path";
import { registerTool } from "./tools/registry.js";
import { resolveTargetPath, relativeToTarget } from "./pathGuard.js";

export const applyExactPatch = ({ original, oldText, newText, newFileContent }) => {
  if (typeof newFileContent === "string") {
    if (original !== null) throw new Error("The new-file patch was rejected because the file already exists.");
    return newFileContent;
  }
  if (typeof original !== "string") throw new Error("The target file does not exist; use new_file_content for a new file.");
  if (typeof oldText !== "string" || !oldText) throw new Error("old_text must be non-empty for an existing file.");
  if (typeof newText !== "string") throw new Error("new_text must be a string.");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const find = original.includes(oldText) ? oldText : oldText.replace(/\r?\n/g, eol);
  const replacement = find === oldText ? newText : newText.replace(/\r?\n/g, eol);
  const count = original.split(find).length - 1;
  if (count === 0) {
    const alreadyApplied = original.split(replacement).length - 1;
    if (alreadyApplied === 1) return original;
    throw new Error("old_text did not match the current file. Read the file again and copy exact text.");
  }
  if (count > 1) throw new Error(`old_text matched ${count} locations. Add surrounding text so it matches exactly once.`);
  return original.replace(find, () => replacement);
};

const normalizeRelative = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");

registerTool({
  name: "apply_task_patch",
  category: "computer",
  description: "Apply one exact search/replace patch to an existing planned file, or create a planned new file with full content. The old text must match exactly once.",
  scope: "modify_files",
  targetTypes: ["local", "computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Planned target-relative file path." },
      old_text: { type: "string", description: "Exact current text; omit only when creating a new file." },
      new_text: { type: "string", description: "Exact replacement text for an existing file." },
      new_file_content: { type: "string", description: "Complete contents for a new file. The file must not already exist." },
    },
    required: ["path"],
  },
  describe: ({ path: file }) => `Apply the planned task patch to ${file}`,
  ruleFor: () => "edit_file",
  run: async (args, ctx) => {
    const filePath = normalizeRelative(args.path);
    if (!filePath || filePath.startsWith("/") || /^[a-z]:/i.test(filePath) || filePath.split("/").some((part) => part === "..")) {
      throw new Error("Patch paths must be relative to the authorized target and cannot traverse outside it.");
    }
    if (!ctx.allowedTaskFiles?.includes(filePath)) throw new Error("This path is not in the approved task files_to_edit list.");
    if (typeof args.new_file_content === "string" && (args.old_text != null || args.new_text != null)) {
      throw new Error("Use either old_text/new_text or new_file_content, not both.");
    }
    if (typeof args.new_file_content !== "string" && (typeof args.old_text !== "string" || typeof args.new_text !== "string")) {
      throw new Error("Existing files need old_text and new_text; new files need new_file_content.");
    }
    if (Buffer.byteLength(args.new_file_content ?? args.old_text + args.new_text) > 1_000_000) throw new Error("A task patch cannot exceed 1 MB.");
    const fullPath = await resolveTargetPath(ctx.target, ctx.root, filePath);
    const original = await fs.readFile(fullPath, "utf8").catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (original !== null && typeof args.new_file_content === "string" && original === args.new_file_content) return `Created ${filePath} (already applied).`;
    const updated = applyExactPatch({ original, oldText: args.old_text, newText: args.new_text, newFileContent: args.new_file_content });
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, updated, "utf8");
    return `${original === null ? "Created" : "Patched"} ${relativeToTarget(ctx.target, ctx.root, fullPath)}.`;
  },
});
