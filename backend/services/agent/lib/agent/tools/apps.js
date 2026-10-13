import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerTool } from "./registry.js";
import { runPowerShell } from "../shell.js";
import { resolveTargetPath } from "../pathGuard.js";

// Windows applications and processes. Nothing here hardcodes an application:
// find_application builds a catalog from the places Windows itself records
// installed programs, and launch_application only starts an executable that
// exists on disk (or a registered Start-menu app id), without a shell, after
// the user approves the exact launch. Processes are closed by exact PID only.

const isWindows = process.platform === "win32";
const CATALOG_TTL_MS = 5 * 60_000;
const MAX_MATCHES = 15;

// Fixed script — no user input is ever interpolated into it.
const CATALOG_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$out = New-Object System.Collections.Generic.List[object]
$sh = New-Object -ComObject WScript.Shell
foreach ($d in @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")) {
  Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk | ForEach-Object {
    $l = $sh.CreateShortcut($_.FullName)
    $out.Add([pscustomobject]@{ n = $_.BaseName; s = 'start_menu'; p = $l.TargetPath; a = $l.Arguments })
  }
}
foreach ($k in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
  Get-ChildItem $k | ForEach-Object {
    $v = (Get-ItemProperty -LiteralPath $_.PSPath).'(default)'
    if ($v) { $out.Add([pscustomobject]@{ n = ($_.PSChildName -replace '\\.exe$', ''); s = 'app_paths'; p = $v.Trim('"') }) }
  }
}
foreach ($k in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
  Get-ChildItem $k | ForEach-Object {
    $p = Get-ItemProperty -LiteralPath $_.PSPath
    if ($p.DisplayName -and -not $p.SystemComponent) {
      $icon = if ($p.DisplayIcon) { ($p.DisplayIcon -split ',')[0].Trim('"') } else { '' }
      $out.Add([pscustomobject]@{ n = $p.DisplayName; s = 'installed'; p = $icon; v = $p.DisplayVersion; d = $p.InstallLocation })
    }
  }
}
Get-StartApps | ForEach-Object { $out.Add([pscustomobject]@{ n = $_.Name; s = 'start_app'; id = $_.AppID }) }
$out | ConvertTo-Json -Compress -Depth 2
`;

// Programs people keep as portable folders (Godot, many dev tools) never
// register anywhere, so a bounded scan of these folders is the fallback.
const portableRoots = () =>
  [
    "Desktop", "Downloads", "Documents", "Applications", "Apps", "Tools", "Programs",
    path.join("AppData", "Local", "Programs"), path.join("scoop", "apps"),
  ]
    .map((d) => path.join(os.homedir(), d))
    .concat(
      [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Tools", "C:\\Apps", "C:\\Godot",
        "C:\\Program Files (x86)\\Steam\\steamapps\\common"].filter(Boolean),
    );

const SKIP_DIRS = new Set(["node_modules", ".git", "$recycle.bin", "system volume information", "windows", "winsxs", "__pycache__", ".venv", "venv"]);

let catalog = { at: 0, entries: null, pending: null };

const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const parseJsonOutput = (text) => {
  const body = text.replace(/^exit code -?\d+\r?\n/, "").trim();
  if (!body || body === "(no output)") return [];
  const start = body.search(/[[{]/);
  const parsed = JSON.parse(body.slice(start));
  return Array.isArray(parsed) ? parsed : [parsed];
};

const fileExists = async (p) => {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
};

const loadCatalog = async (signal) => {
  if (catalog.entries && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.entries;
  if (!catalog.pending) {
    catalog.pending = runPowerShell(CATALOG_SCRIPT, { signal, timeoutMs: 60_000, maxOutputChars: 4_000_000 })
      .then((out) => {
        const entries = parseJsonOutput(out);
        catalog = { at: Date.now(), entries, pending: null };
        return entries;
      })
      .catch((e) => {
        catalog.pending = null;
        throw e;
      });
  }
  return catalog.pending;
};

// Executables on PATH whose file name matches the query.
const pathExecutables = async (tokens) => {
  const dirs = [...new Set((process.env.PATH || "").split(path.delimiter).filter(Boolean))];
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/\.exe$/i.test(name) && tokens.every((t) => normalize(name).includes(t))) {
        found.push({ n: name.replace(/\.exe$/i, ""), s: "path", p: path.join(dir, name) });
      }
    }
  }
  return found;
};

// Bounded scan for portable executables: common app folders first, then every
// fixed drive. Never follows links or junctions; stops at a folder/time budget.
const DRIVE_SKIP = new Set(["programdata", "appdata", "users", "program files", "program files (x86)", "$windows.~bt", "msocache", "recovery"]);

const scanPortable = async (tokens, signal, { maxDepth = 4, maxDirs = 30_000, maxMs = 20_000 } = {}) => {
  const found = [];
  const seen = new Set();
  const started = Date.now();
  const budgetLeft = () => !signal?.aborted && seen.size < maxDirs && found.length < 30 && Date.now() - started < maxMs;
  const walk = async (dir, depth, skip) => {
    const key = dir.toLowerCase();
    if (!budgetLeft() || seen.has(key)) return;
    seen.add(key);
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && /\.exe$/i.test(e.name)) {
        const hay = normalize(`${path.basename(dir)} ${e.name}`);
        if (tokens.every((t) => hay.includes(t)) && !/unins|setup|install|update|crash|helper/i.test(e.name)) {
          found.push({ n: e.name.replace(/\.exe$/i, ""), s: "portable", p: full });
        }
      } else if (e.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(e.name.toLowerCase()) && !skip?.has(e.name.toLowerCase())) {
        await walk(full, depth + 1);
      }
    }
  };
  for (const root of portableRoots()) await walk(root, 0);
  for (const drive of "CDEFGHIJ".split("").map((d) => `${d}:\\`)) await walk(drive, 0, DRIVE_SKIP);
  return found;
};

const score = (entry, q) => {
  const name = normalize(entry.n);
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  return 50 - Math.min(name.length, 40) / 4;
};

export const findApplications = async (query, { signal, deep = false } = {}) => {
  const q = normalize(query);
  if (!q) throw new Error("query is required.");
  const tokens = q.split(" ");
  const matchesQuery = (e) => {
    const hay = normalize(`${e.n} ${path.basename(e.p || "")}`);
    return tokens.every((t) => hay.includes(t));
  };

  const [entries, onPath] = await Promise.all([loadCatalog(signal), pathExecutables(tokens)]);
  let raw = [...entries.filter(matchesQuery), ...onPath];
  if (deep || !raw.length) raw = raw.concat(await scanPortable(tokens, signal));

  // Validate and de-duplicate by executable (or app id).
  const byKey = new Map();
  for (const e of raw) {
    let exe = e.p && /\.exe$/i.test(e.p) ? path.resolve(e.p) : null;
    if (exe && !(await fileExists(exe))) exe = null;
    // Uninstall entries often point at the (un)installer, which is not the app.
    if (exe && /unins|installer|setup|update\.exe$/i.test(path.basename(exe))) exe = null;
    if (!exe && !e.id) continue;
    const key = exe ? exe.toLowerCase() : `id:${e.id.toLowerCase()}`;
    const prev = byKey.get(key);
    const candidate = {
      name: e.n,
      source: e.s,
      executable: exe,
      appId: exe ? undefined : e.id,
      arguments: e.a || undefined,
      version: e.v || undefined,
      score: score(e, q),
    };
    if (!prev || candidate.score > prev.score) byKey.set(key, { ...prev, ...candidate, version: candidate.version || prev?.version });
  }
  // A Start-menu app id that points at an exe we already have is a duplicate.
  const names = new Set([...byKey.values()].filter((c) => c.executable).map((c) => normalize(c.name)));
  return [...byKey.values()]
    .filter((c) => c.executable || !names.has(normalize(c.name)))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES)
    .map(({ score: _s, ...c }) => c);
};

const PROCESS_SCRIPT =
  "Get-Process | Select-Object Id,ProcessName,Path,MainWindowTitle,@{n='Start';e={if($_.StartTime){$_.StartTime.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress";

export const listProcesses = async (signal) => {
  const out = await runPowerShell(`$ErrorActionPreference='SilentlyContinue'; ${PROCESS_SCRIPT}`, {
    signal,
    timeoutMs: 30_000,
    maxOutputChars: 4_000_000,
  });
  return parseJsonOutput(out).map((p) => ({
    pid: p.Id,
    name: p.ProcessName,
    path: p.Path || null,
    title: p.MainWindowTitle || "",
    started: p.Start || null,
  }));
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

// Files whose "default program" is to run them. Opening one is a launch, so
// it has to go through `executable` where the user sees exactly what runs.
const EXECUTABLE_EXT = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|lnk|scr|hta|cpl|reg|pif|appref-ms|url|jar)$/i;
const APP_ID = /^[\w.!{}\-\\ ~]{1,300}$/;

const validateArgs = (args) => {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > 20 || !args.every((a) => typeof a === "string" && a.length <= 1000 && !/[\0\r\n]/.test(a))) {
    throw new Error("arguments must be an array of up to 20 single-line strings.");
  }
  return args;
};

registerTool({
  name: "find_application",
  category: "computer",
  description:
    "Find installed applications on this Windows PC by name (e.g. 'godot', 'vs code', 'chrome'). Searches Start-menu shortcuts, " +
    "registered app paths, installed-program entries, Store apps, PATH and common portable-app folders. Returns only candidates " +
    "whose executable was verified to exist. If several match (e.g. two Godot versions), ask the user which one to use.",
  scope: "launch_applications",
  targetTypes: ["computer"],
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Application name or part of it." },
      deep: { type: "boolean", description: "Also scan common folders for portable executables. Default: only if nothing else matched." },
    },
    required: ["query"],
  },
  run: async ({ query, deep }, { signal }) => {
    if (!isWindows) throw new Error("Application discovery is only available on Windows.");
    const found = await findApplications(query, { signal, deep: Boolean(deep) });
    if (!found.length) return `No installed application matching "${query}" was found. Try a different name, or deep: true.`;
    return { matches: found.length, candidates: found };
  },
});

registerTool({
  name: "launch_application",
  category: "computer",
  description:
    "Open an application, or open a file/folder/project. Give `executable` (a verified path from find_application) with optional " +
    "`arguments` (e.g. Godot editor on a project: ['--editor', '--path', 'D:\\\\Games\\\\Racer']), or `appId` for a Store/Start-menu app, " +
    "or only `openPath` to open a document or folder in its default program. Starts the program directly without a shell; " +
    "the user approves each launch. Reports whether a process actually started.",
  scope: "launch_applications",
  targetTypes: ["computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      executable: { type: "string", description: "Full path to an .exe from find_application." },
      arguments: { type: "array", items: { type: "string" }, description: "Command-line arguments, one per item." },
      appId: { type: "string", description: "Start-menu app id from find_application (when there is no executable)." },
      openPath: { type: "string", description: "A document or folder to open with its default program." },
      workingDirectory: { type: "string", description: "Optional working directory for `executable`." },
    },
  },
  describe: ({ executable, arguments: a, appId, openPath }) =>
    executable
      ? `Launch ${executable}${a?.length ? ` ${a.join(" ")}` : ""}`
      : appId
        ? `Launch app ${appId}`
        : `Open ${openPath} in its default program`,
  ruleFor: ({ executable, appId, openPath }) => {
    const what = executable || appId || openPath;
    return what ? `launch:${String(what).toLowerCase()}` : null;
  },
  run: async ({ executable, arguments: rawArgs, appId, openPath, workingDirectory }, { target, root, signal }) => {
    if (!isWindows) throw new Error("Launching applications is only available on Windows.");
    if ([executable, appId, openPath].filter(Boolean).length !== 1) {
      throw new Error("Give exactly one of executable, appId or openPath.");
    }
    const args = validateArgs(rawArgs);
    let file;
    let spawnArgs;
    let cwd;
    let watchPath = null;

    if (executable) {
      const exe = await resolveTargetPath(target, root, executable);
      if (!/\.exe$/i.test(exe)) throw new Error("executable must be an .exe file. Use run_command for scripts.");
      if (!(await fileExists(exe))) throw new Error(`Executable not found: ${exe}`);
      file = exe;
      spawnArgs = args;
      watchPath = exe.toLowerCase();
      cwd = workingDirectory ? await resolveTargetPath(target, root, workingDirectory) : path.dirname(exe);
    } else if (appId) {
      if (!APP_ID.test(appId) || appId.includes("..")) throw new Error("appId is not a valid Start-menu app id.");
      file = "explorer.exe";
      spawnArgs = [`shell:AppsFolder\\${appId}`];
    } else {
      const p = await resolveTargetPath(target, root, openPath);
      await fs.stat(p).catch(() => {
        throw new Error(`Path not found: ${p}`);
      });
      if (EXECUTABLE_EXT.test(p)) throw new Error("That file is a program or script. Launch it via `executable` or run_command so the user sees what runs.");
      file = "explorer.exe";
      spawnArgs = [p];
    }

    const before = new Set((await listProcesses(signal)).map((p) => p.pid));
    const launchedAt = Date.now();
    const child = await new Promise((resolve, reject) => {
      const c = spawn(file, spawnArgs, { cwd, detached: true, stdio: "ignore", windowsHide: false, shell: false });
      c.once("error", (e) => reject(new Error(`Could not start ${file}: ${e.message}`)));
      c.once("spawn", () => resolve(c));
    });
    child.unref();
    await sleep(3000, signal);

    const fresh = (await listProcesses(signal)).filter((p) => !before.has(p.pid) && p.name.toLowerCase() !== "explorer");
    const ours = watchPath ? fresh.filter((p) => p.path?.toLowerCase() === watchPath) : [];
    const windowed = fresh.filter((p) => p.title).slice(0, 5);
    const lines = [];
    if (ours.length) lines.push(`Started: ${ours.map((p) => `${p.name} (PID ${p.pid}${p.title ? `, window "${p.title}"` : ""})`).join(", ")}.`);
    else if (watchPath && child.exitCode === null) lines.push(`Started: PID ${child.pid}, still running after 3s.`);
    else if (watchPath) lines.push(`The program exited within 3s (exit code ${child.exitCode}). It may have handed off to another process, or failed to start.`);
    else lines.push("Windows accepted the open request.");
    if (windowed.length) lines.push(`New windows: ${windowed.map((p) => `${p.name} (PID ${p.pid}) "${p.title}"`).join("; ")}.`);
    else if (!ours.length) lines.push("No new window has appeared yet; do not tell the user it opened unless confirmed.");
    lines.push(`(checked ${Math.round((Date.now() - launchedAt) / 1000)}s after launch)`);
    return lines.join("\n");
  },
});

registerTool({
  name: "list_processes",
  category: "computer",
  description:
    "List running programs (PID, name, executable path, window title). Filter by name or window title. Use this to find the exact PID before close_application.",
  scope: "manage_processes",
  targetTypes: ["computer"],
  parameters: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Case-insensitive text to match in name, path or window title." },
      windowsOnly: { type: "boolean", description: "Only programs with a visible window. Default true." },
    },
  },
  run: async ({ filter, windowsOnly = true }, { signal }) => {
    if (!isWindows) throw new Error("Process listing is only available on Windows.");
    const f = typeof filter === "string" ? filter.toLowerCase() : "";
    const rows = (await listProcesses(signal))
      .filter((p) => (!windowsOnly || p.title) && (!f || `${p.name} ${p.path || ""} ${p.title}`.toLowerCase().includes(f)))
      .slice(0, 100);
    return rows.length ? rows : "No matching processes.";
  },
});

// Processes Windows needs to keep running, plus the agent itself.
const PROTECTED_PROCESSES = new Set([
  "system", "idle", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso",
  "svchost", "fontdrvhost", "dwm", "memory compression", "securityhealthservice", "msmpeng", "sgrmbroker",
]);

registerTool({
  name: "close_application",
  category: "computer",
  description:
    "Close one running program by exact PID (from list_processes). Tries a graceful close (like clicking X) first. " +
    "Only set force: true if a graceful close failed and the user wants it ended — unsaved work is lost. Never guess a PID.",
  scope: "manage_processes",
  targetTypes: ["computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      pid: { type: "integer", description: "Exact process id." },
      expectedName: { type: "string", description: "The process name you expect at that PID (guards against reused PIDs)." },
      force: { type: "boolean", description: "Force-end the process. Default false." },
    },
    required: ["pid", "expectedName"],
  },
  describe: ({ pid, expectedName, force }) => `${force ? "Force-end" : "Close"} ${expectedName} (PID ${pid})`,
  ruleFor: ({ expectedName, force }) =>
    expectedName ? `${force ? "force_close" : "close"}:${String(expectedName).toLowerCase()}` : null,
  run: async ({ pid, expectedName, force = false }, { signal }) => {
    if (!isWindows) throw new Error("Process control is only available on Windows.");
    if (!Number.isInteger(pid) || pid <= 4) throw new Error("pid must be a real process id.");
    if ([process.pid, process.ppid].includes(pid)) throw new Error("That is the Antral agent itself.");
    const proc = (await listProcesses(signal)).find((p) => p.pid === pid);
    if (!proc) return `No process with PID ${pid} is running (it may already be closed).`;
    if (typeof expectedName !== "string" || proc.name.toLowerCase() !== expectedName.replace(/\.exe$/i, "").toLowerCase()) {
      throw new Error(`PID ${pid} is "${proc.name}", not "${expectedName}". Re-check with list_processes.`);
    }
    if (PROTECTED_PROCESSES.has(proc.name.toLowerCase())) throw new Error(`"${proc.name}" is a Windows system process and will not be closed.`);

    // pid is a validated integer, so interpolation is safe.
    const cmd = force
      ? `Stop-Process -Id ${pid} -Force -ErrorAction Stop; 'ok'`
      : `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p.MainWindowHandle -eq 0) { 'nowindow' } else { [void]$p.CloseMainWindow(); 'sent' }`;
    const out = await runPowerShell(cmd, { signal, timeoutMs: 15_000, executionPolicy: "Bypass" });
    if (/nowindow/.test(out)) return `${proc.name} (PID ${pid}) has no window to close gracefully. Ask the user before retrying with force: true.`;
    if (!/exit code 0/.test(out)) throw new Error(out);

    for (let i = 0; i < 10; i += 1) {
      await sleep(500, signal);
      if (!(await listProcesses(signal)).some((p) => p.pid === pid)) return `${proc.name} (PID ${pid}) has closed.`;
    }
    return force
      ? `${proc.name} (PID ${pid}) is still running after a force stop — it may need administrator rights.`
      : `${proc.name} (PID ${pid}) is still open after 5s — it may be showing a "save changes?" prompt. Tell the user; force-closing would lose unsaved work.`;
  },
});

// ---- Project discovery ------------------------------------------------------

const PROJECT_MARKERS = [
  ["project.godot", "Godot"], ["package.json", "Node.js"], ["pyproject.toml", "Python"], ["requirements.txt", "Python"],
  ["Cargo.toml", "Rust"], ["go.mod", "Go"], ["pom.xml", "Java/Maven"], ["build.gradle", "Java/Gradle"],
  ["build.gradle.kts", "Kotlin/Gradle"], ["CMakeLists.txt", "C/C++"], ["composer.json", "PHP"], ["Gemfile", "Ruby"],
];
const PROJECT_EXT = [[/\.sln$/i, ".NET"], [/\.csproj$/i, ".NET"], [/\.uproject$/i, "Unreal"]];
const PROJECT_SKIP = new Set([...SKIP_DIRS, "appdata", "program files", "program files (x86)", "programdata", "dist", "build", "target", ".cache", "library"]);

const detectProject = async (dir, names) => {
  const kinds = new Set();
  for (const [file, kind] of PROJECT_MARKERS) if (names.has(file.toLowerCase())) kinds.add(kind);
  for (const n of names) for (const [re, kind] of PROJECT_EXT) if (re.test(n)) kinds.add(kind);
  if (names.has("assets") && names.has("projectsettings")) kinds.add("Unity");
  if (!kinds.size && !names.has(".git")) return null;
  let title;
  if (kinds.has("Godot")) {
    try {
      const cfg = await fs.readFile(path.join(dir, "project.godot"), "utf8");
      title = /config\/name\s*=\s*"([^"]*)"/.exec(cfg)?.[1];
    } catch { /* unreadable */ }
  }
  return { path: dir, name: title || path.basename(dir), kinds: kinds.size ? [...kinds] : ["Git repository"], git: names.has(".git") };
};

registerTool({
  name: "find_projects",
  category: "computer",
  description:
    "Find development projects (Godot, Node, Python, .NET, Unity, Unreal, Rust, Go, Java, git repos…) by name or kind. " +
    "Searches the user's folders and drive roots by default (bounded depth; skips system and dependency folders). " +
    "Present the matches and let the user pick when several fit.",
  scope: "read_source",
  targetTypes: ["computer", "local"],
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to match in the project's folder or game name, e.g. 'racing'." },
      kind: { type: "string", description: "Optional kind filter, e.g. 'Godot'." },
      roots: { type: "array", items: { type: "string" }, description: "Folders to search instead of the defaults." },
      maxDepth: { type: "integer", minimum: 1, maximum: 8, description: "Default 5." },
    },
  },
  run: async ({ query, kind, roots, maxDepth = 5 }, { target, root, signal }) => {
    const tokens = normalize(query).split(" ").filter(Boolean);
    const kindFilter = normalize(kind);
    let searchRoots;
    if (Array.isArray(roots) && roots.length) {
      searchRoots = await Promise.all(roots.slice(0, 10).map((r) => resolveTargetPath(target, root, r)));
    } else if (target?.type === "computer") {
      const home = os.homedir();
      const drives = "CDEFGHIJ".split("").map((d) => `${d}:\\`);
      searchRoots = [home, ...drives];
    } else {
      searchRoots = [root];
    }

    const depthLimit = Math.min(Math.max(Number(maxDepth) || 5, 1), 8);
    const results = [];
    const seen = new Set();
    let visited = 0;
    const started = Date.now();
    const walk = async (dir, depth) => {
      if (signal?.aborted || visited >= 40_000 || results.length >= 50 || Date.now() - started > 25_000) return;
      const key = dir.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      visited += 1;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const names = new Set(entries.map((e) => e.name.toLowerCase()));
      const project = await detectProject(dir, names);
      if (project) {
        const hay = normalize(`${project.name} ${path.basename(dir)}`);
        const kindOk = !kindFilter || project.kinds.some((k) => normalize(k).includes(kindFilter));
        if (kindOk && tokens.every((t) => hay.includes(t))) results.push(project);
        // Nested projects (monorepos) still count, but don't descend into deps.
      }
      if (depth >= depthLimit) return;
      for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        const lower = e.name.toLowerCase();
        if (PROJECT_SKIP.has(lower) || (lower.startsWith(".") && lower !== ".config")) continue;
        await walk(path.join(dir, e.name), depth + 1);
      }
    };
    for (const r of searchRoots) {
      const isDrive = /^[a-z]:\\$/i.test(r);
      try {
        await fs.access(r);
      } catch {
        continue;
      }
      // Drive roots are searched shallower; the home folder is covered separately.
      await walk(r, isDrive ? Math.max(depthLimit - 2, 0) : 0);
    }
    const stoppedEarly = visited >= 40_000 || Date.now() - started > 25_000;
    if (!results.length) {
      return `No matching projects found in ${searchRoots.join(", ")}${stoppedEarly ? " (search limit reached — give roots to narrow it)" : ""}.`;
    }
    return { projects: results, searched: searchRoots, foldersScanned: visited, stoppedEarly };
  },
});

// ---- Tool versions ------------------------------------------------------------

// Known developer tools and their version flags. Only these are executed.
const VERSION_FLAGS = {
  node: ["--version"], npm: ["--version"], git: ["--version"], python: ["--version"], py: ["--version"],
  java: ["-version"], dotnet: ["--version"], go: ["version"], cargo: ["--version"], rustc: ["--version"],
  adb: ["version"], docker: ["--version"], code: ["--version"], gh: ["--version"], pwsh: ["--version"],
  godot: ["--version"], cmake: ["--version"], gcc: ["--version"], pip: ["--version"], deno: ["--version"], bun: ["--version"],
};

const runFile = (file, args, signal) =>
  new Promise((resolve) => {
    const isCmd = /\.(cmd|bat)$/i.test(file);
    const c = spawn(isCmd ? "cmd.exe" : file, isCmd ? ["/d", "/c", file, ...args] : args, { windowsHide: true, signal, shell: false });
    let out = "";
    const add = (d) => {
      if (out.length < 2000) out += d.toString("utf8");
    };
    c.stdout?.on("data", add);
    c.stderr?.on("data", add);
    const t = setTimeout(() => c.kill(), 10_000);
    c.on("error", (e) => (clearTimeout(t), resolve(`error: ${e.message}`)));
    c.on("close", () => (clearTimeout(t), resolve(out.trim().split(/\r?\n/).filter((l) => !/^\s*$/.test(l)).slice(0, 3).join(" | "))));
  });

const whichAll = async (name) => {
  const exts = isWindows ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if ([".exe", ".cmd", ".bat", ""].includes(ext) && (await fileExists(p))) return p;
    }
  }
  return null;
};

registerTool({
  name: "check_tool_versions",
  category: "computer",
  description:
    `Report whether developer tools are installed on PATH and their versions. Supported: ${Object.keys(VERSION_FLAGS).join(", ")}. ` +
    "For other applications use find_application.",
  scope: "execute_powershell",
  targetTypes: ["computer", "local"],
  parameters: {
    type: "object",
    properties: { tools: { type: "array", items: { type: "string", enum: Object.keys(VERSION_FLAGS) } } },
    required: ["tools"],
  },
  run: async ({ tools }, { signal }) => {
    if (!Array.isArray(tools) || !tools.length) throw new Error("tools is required.");
    const rows = [];
    for (const name of [...new Set(tools)].slice(0, 20)) {
      if (!VERSION_FLAGS[name]) {
        rows.push({ tool: name, status: "unsupported — use find_application" });
        continue;
      }
      const file = await whichAll(name);
      rows.push(file ? { tool: name, path: file, version: await runFile(file, VERSION_FLAGS[name], signal) } : { tool: name, status: "not found on PATH" });
    }
    return rows;
  },
});
