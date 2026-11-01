import fs from "node:fs/promises";
import axios from "axios";
import { resolveTargetPath } from "./pathGuard.js";
import { getToolApiSettings } from "../../data/settings.js";

// Reading files from whichever kind of target a run is on, so tools like the
// dependency scanner work the same for a local folder and a GitHub repo.

const MAX_FILE_BYTES = 512 * 1024;

// "https://github.com/owner/repo" -> { owner, repo }
export const parseGithubRepo = (identifier) => {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(identifier || "");
  if (!m) throw new Error(`"${identifier}" is not a GitHub repository URL.`);
  return { owner: m[1], repo: m[2].replace(/\.git$/i, "") };
};

// Read-only GitHub REST call. Uses GITHUB_TOKEN when set (higher rate limit,
// private repos the token can read); public repos work without it.
export const github = async (path, params = {}, { signal } = {}) => {
  const githubToken = getToolApiSettings().githubToken || process.env.GITHUB_TOKEN;
  try {
    const { data } = await axios.get(`https://api.github.com${path}`, {
      params,
      signal,
      timeout: 30_000,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "antral-agent",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      },
    });
    return data;
  } catch (error) {
    const status = error.response?.status;
    const msg = error.response?.data?.message || error.message;
    if (status === 404) throw new Error(`Not found on GitHub (${path}). Check the path, or the repo may be private.`);
    if (status === 403 || status === 429) throw new Error(`GitHub refused the request: ${msg}`);
    throw new Error(`GitHub request failed: ${msg}`);
  }
};

const cleanRepoPath = (p = "") => String(p).replace(/^[\\/]+/, "").replace(/\\/g, "/").replace(/^\.\/?$/, "");

export const readGithubFile = async (target, path, { signal } = {}) => {
  const { owner, repo } = parseGithubRepo(target.identifier);
  const clean = cleanRepoPath(path);
  if (clean.split("/").includes("..")) throw new Error("Paths can't contain '..'.");
  const data = await github(`/repos/${owner}/${repo}/contents/${encodeURI(clean)}`, {}, { signal });
  if (Array.isArray(data)) throw new Error(`${path} is a folder.`);
  if (data.size > MAX_FILE_BYTES) throw new Error(`${path} is too large to read (${data.size} bytes).`);
  if (data.encoding !== "base64") throw new Error(`${path} can't be read through the API.`);
  return Buffer.from(data.content, "base64");
};

// Returns the file's contents as a Buffer, or throws.
export const readTargetFile = async (ctx, path) => {
  if (ctx.target.type === "local" || ctx.target.type === "computer") {
    const file = await resolveTargetPath(ctx.target, ctx.root, path);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`${path} is not a file.`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${path} is too large to read (${stat.size} bytes).`);
    return fs.readFile(file);
  }
  if (ctx.target.type === "github") return readGithubFile(ctx.target, path, ctx);
  throw new Error(`Reading files isn't supported for ${ctx.target.type} targets.`);
};

export { cleanRepoPath };
