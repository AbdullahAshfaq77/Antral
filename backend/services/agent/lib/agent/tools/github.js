import { registerTool } from "./registry.js";
import { github, parseGithubRepo, readGithubFile, cleanRepoPath } from "../targetFiles.js";
import { getToolApiSettings } from "../../../data/settings.js";

// Read-only GitHub tools for "github" targets. They only ever read the
// authorized repository, through the REST API.

const SKIP = /(^|\/)(node_modules|\.git|dist|build|vendor|coverage)(\/|$)/;
const MAX_TREE_ENTRIES = 500;

const repoOf = (ctx) => parseGithubRepo(ctx.target.identifier);

registerTool({
  name: "github_repo_overview",
  category: "developer",
  description:
    "Get an overview of the authorized GitHub repository: description, default branch, visibility, languages, license, top-level files and recent commits. Start here.",
  scope: "github_read",
  targetTypes: ["github"],
  parameters: { type: "object", properties: {} },
  run: async (_args, ctx) => {
    const { owner, repo } = repoOf(ctx);
    const base = `/repos/${owner}/${repo}`;
    const [info, languages, root, commits] = await Promise.all([
      github(base, {}, ctx),
      github(`${base}/languages`, {}, ctx).catch(() => ({})),
      github(`${base}/contents/`, {}, ctx).catch(() => []),
      github(`${base}/commits`, { per_page: 5 }, ctx).catch(() => []),
    ]);
    return [
      `${info.full_name}${info.private ? " (private)" : ""}: ${info.description || "no description"}`,
      `Default branch: ${info.default_branch} · Stars: ${info.stargazers_count} · Open issues: ${info.open_issues_count} · License: ${info.license?.spdx_id || "none"}`,
      `Last push: ${info.pushed_at}`,
      `Languages: ${Object.keys(languages).join(", ") || "unknown"}`,
      "",
      "Top-level:",
      ...root.map((e) => `  ${e.name}${e.type === "dir" ? "/" : ""}`),
      "",
      "Recent commits:",
      ...commits.map((c) => `  ${c.sha.slice(0, 7)} ${c.commit.author?.date?.slice(0, 10)} ${c.commit.message.split("\n")[0].slice(0, 100)}`),
    ].join("\n");
  },
});

registerTool({
  name: "github_list_files",
  category: "developer",
  description:
    "List files in the authorized GitHub repository. recursive: true lists the whole tree (skipping node_modules, dist and similar folders).",
  scope: "github_read",
  targetTypes: ["github"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Folder in the repo. Default: root." },
      recursive: { type: "boolean", description: "List everything under the folder. Default false." },
    },
  },
  run: async ({ path = "", recursive = false }, ctx) => {
    const { owner, repo } = repoOf(ctx);
    const dir = cleanRepoPath(path);
    if (!recursive) {
      const entries = await github(`/repos/${owner}/${repo}/contents/${encodeURI(dir)}`, {}, ctx);
      if (!Array.isArray(entries)) return `${dir} is a file.`;
      return entries.map((e) => `${e.path}${e.type === "dir" ? "/" : `  (${e.size} B)`}`).join("\n") || "(empty)";
    }
    const info = await github(`/repos/${owner}/${repo}`, {}, ctx);
    const tree = await github(`/repos/${owner}/${repo}/git/trees/${info.default_branch}`, { recursive: 1 }, ctx);
    const files = tree.tree
      .filter((e) => e.type === "blob" && (!dir || e.path.startsWith(`${dir}/`)) && !SKIP.test(e.path))
      .map((e) => `${e.path}  (${e.size} B)`);
    const shown = files.slice(0, MAX_TREE_ENTRIES);
    const more = files.length > shown.length ? `\n… ${files.length - shown.length} more files` : "";
    return `${files.length} files${tree.truncated ? " (GitHub truncated the tree)" : ""}:\n${shown.join("\n")}${more}`;
  },
});

registerTool({
  name: "github_read_file",
  category: "developer",
  description:
    "Read a text file from the authorized GitHub repository, with line numbers. Use startLine/maxLines for large files. Credentials are masked.",
  scope: "github_read",
  targetTypes: ["github"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path in the repo." },
      startLine: { type: "integer", minimum: 1 },
      maxLines: { type: "integer", minimum: 1, maximum: 800 },
    },
    required: ["path"],
  },
  run: async ({ path, startLine = 1, maxLines = 400 }, ctx) => {
    const buf = await readGithubFile(ctx.target, path, ctx);
    if (buf.subarray(0, 8000).includes(0)) return `${path} is a binary file; not shown.`;
    const all = buf.toString("utf8").split(/\r?\n/);
    const from = Math.max(Number(startLine) || 1, 1);
    const count = Math.min(Math.max(Number(maxLines) || 400, 1), 800);
    const body = all
      .slice(from - 1, from - 1 + count)
      .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
      .join("\n");
    const more = from - 1 + count < all.length ? `\n… ${all.length - (from - 1 + count)} more lines` : "";
    return `${cleanRepoPath(path)} (${all.length} lines)\n${body}${more}`;
  },
});

registerTool({
  name: "github_search_code",
  category: "developer",
  description:
    "Search code in the authorized GitHub repository (GitHub code search, default branch only). Use plain keywords, e.g. 'password', 'eval(', 'jwt.sign'.",
  scope: "github_read",
  targetTypes: ["github"],
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Keywords to search for." } },
    required: ["query"],
  },
  run: async ({ query }, ctx) => {
    if (!(getToolApiSettings().githubToken || process.env.GITHUB_TOKEN)) throw new Error("Code search needs a GitHub token. Add one in Settings → AI provider → Tool integrations, or use github_list_files and github_read_file instead.");
    const { owner, repo } = repoOf(ctx);
    const q = `${String(query).slice(0, 200)} repo:${owner}/${repo}`;
    const data = await github("/search/code", { q, per_page: 30 }, ctx);
    if (!data.items?.length) return `No matches for "${query}".`;
    return `${data.total_count} matching files:\n${data.items.map((i) => `  ${i.path}`).join("\n")}\nRead the files to see the matching lines.`;
  },
});
