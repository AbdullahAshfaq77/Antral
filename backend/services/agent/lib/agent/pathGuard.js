import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// Resolves `requested` inside the authorized target root and refuses anything
// that escapes it — including via `..` or a symlink/junction pointing outside.
export const resolveInsideRoot = async (root, requested = ".") => {
  if (typeof requested !== "string") throw new Error("Path must be a string.");
  const realRoot = await fs.realpath(path.resolve(root));
  // Models often write "/" or "/src" meaning the target root, so a leading
  // slash is treated as root-relative. Drive letters and UNC paths still fail.
  const rel = /^[\\/](?![\\/])/.test(requested) ? requested.replace(/^[\\/]+/, "") || "." : requested;
  const candidate = path.resolve(realRoot, rel);

  // Follow symlinks for paths that exist; for paths that don't, check the
  // deepest existing parent instead.
  let real = candidate;
  try {
    real = await fs.realpath(candidate);
  } catch {
    let parent = path.dirname(candidate);
    while (parent !== path.dirname(parent)) {
      try {
        real = path.join(await fs.realpath(parent), path.relative(parent, candidate));
        break;
      } catch {
        parent = path.dirname(parent);
      }
    }
  }

  const fromRoot = path.relative(realRoot.toLowerCase(), real.toLowerCase());
  if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
    throw new Error(`Access denied: "${requested}" is outside the authorized target.`);
  }
  return real;
};

// Display a path relative to the target root, with forward slashes.
export const relativeToRoot = (root, p) => path.relative(root, p).split(path.sep).join("/") || ".";

const pathApi = process.platform === "win32" ? path.win32 : path.posix;

const isLocalAbsolutePath = (value) =>
  process.platform === "win32"
    ? /^[a-z]:[\\/]/i.test(value)
    : pathApi.isAbsolute(value);

export const resolveComputerPath = async (requested = ".") => {
  if (typeof requested !== "string") throw new Error("Path must be a string.");
  const value = requested.trim() || ".";
  if (/^(?:\\\\|\/\/|\\\\[.?]\\)/.test(value)) {
    throw new Error("Network and device paths are not allowed for This PC.");
  }
  const candidate = path.resolve(isLocalAbsolutePath(value) ? value : path.join(os.homedir(), value));
  if (!isLocalAbsolutePath(candidate)) throw new Error(`"${requested}" is not a local absolute path.`);

  let existing = candidate;
  while (true) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  if (!isLocalAbsolutePath(existing) || /^(?:\\\\|\/\/)/.test(existing)) {
    throw new Error("Network and device paths are not allowed for This PC.");
  }
  return candidate;
};

export const resolveTargetPath = (target, root, requested = ".") =>
  target?.type === "computer" ? resolveComputerPath(requested) : resolveInsideRoot(root, requested);

export const relativeToTarget = (target, root, p) =>
  target?.type === "computer" ? p : relativeToRoot(root, p);

export const isTargetRoot = (target, root, p) => {
  if (target?.type !== "computer") return path.resolve(root).toLowerCase() === path.resolve(p).toLowerCase();
  return pathApi.parse(p).root.toLowerCase() === path.resolve(p).toLowerCase();
};

// Resolves to `null` if the promise doesn't settle within `ms` — empty optical
// or disconnected removable drives can make fs.stat block for seconds.
const withTimeout = (promise, ms) =>
  Promise.race([promise.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

export const getComputerRoots = async () => {
  if (process.platform !== "win32") return [path.parse(process.cwd()).root];
  // Skip A:/B: (legacy floppy letters) — almost never real and slow to probe.
  const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const available = await Promise.all(
    letters.map(async (drive) => {
      const root = `${drive}:\\`;
      const st = await withTimeout(fs.stat(root), 700);
      if (!st || !st.isDirectory()) return null;
      const real = await withTimeout(fs.realpath(root), 700);
      return real && isLocalAbsolutePath(real) && !/^(?:\\\\|\/\/)/.test(real) ? root : null;
    }),
  );
  return available.filter(Boolean);
};
