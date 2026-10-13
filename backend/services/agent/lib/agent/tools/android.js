import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { registerTool } from "./registry.js";
import { runPowerShell } from "../shell.js";

const MAX_OUTPUT_CHARS = 20_000;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SERIAL = /^[A-Za-z0-9._-]{1,128}$/;
export const SETTINGS_SCREENS = {
  main: "android.settings.SETTINGS",
  wifi: "android.settings.WIFI_SETTINGS",
  bluetooth: "android.settings.BLUETOOTH_SETTINGS",
  accessibility: "android.settings.ACCESSIBILITY_SETTINGS",
  developer: "android.settings.APPLICATION_DEVELOPMENT_SETTINGS",
  apps: "android.settings.APPLICATION_SETTINGS",
  app_details: "android.settings.APPLICATION_DETAILS_SETTINGS",
  display: "android.settings.DISPLAY_SETTINGS",
  sound: "android.settings.SOUND_SETTINGS",
  battery: "android.intent.action.POWER_USAGE_SUMMARY",
  location: "android.settings.LOCATION_SOURCE_SETTINGS",
  security: "android.settings.SECURITY_SETTINGS",
  date: "android.settings.DATE_SETTINGS",
};
const KEY_CODES = new Set(["BACK", "HOME", "ENTER", "TAB", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"]);

export const isUsbDeviceSerial = (serial) =>
  typeof serial === "string" && SERIAL.test(serial) && !/^emulator-/i.test(serial) && !/_adb-tls-|\._tcp/i.test(serial);

export const parseDevicesOutput = (output) =>
  output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const match = /^\s*(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (!match) return null;
      return {
        serial: match[1],
        state: match[2],
        details: match[3] || "",
        // Recent ADB on Windows often omits `usb:` from `devices -l`, so the
        // serial decides: network (ip:port) and wireless-debugging (mDNS)
        // serials are refused by isUsbDeviceSerial; `usb:` is just a bonus.
        canControl: match[2] === "device" && isUsbDeviceSerial(match[1]),
      };
    })
    .filter(Boolean);

const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

// ANDROID_ADB_PATH wins; otherwise PATH, then the usual install locations
// (a service started before installing Platform-Tools has a stale PATH).
const ADB_LOCATIONS = [
  process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages", "Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe", "platform-tools", "adb.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe"),
  "C:\platform-tools\adb.exe",
].filter(Boolean);
const onPath = () =>
  (process.env.PATH || "").split(path.delimiter).some((d) => d && existsSync(path.join(d, process.platform === "win32" ? "adb.exe" : "adb")));
let resolvedAdb;
const adbPath = () => {
  if (process.env.ANDROID_ADB_PATH?.trim()) return process.env.ANDROID_ADB_PATH.trim();
  if (!resolvedAdb) resolvedAdb = onPath() ? "adb" : ADB_LOCATIONS.find((p) => existsSync(p)) || "adb";
  return resolvedAdb;
};

const runAdb = (args, { signal, timeoutMs = 15_000 } = {}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("The run was cancelled."));
      return;
    }
    const child = spawn(adbPath(), args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let truncated = false;
    const append = (chunk) => {
      const remaining = MAX_OUTPUT_CHARS - output.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      output += text.slice(0, remaining);
      if (text.length > remaining) truncated = true;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let timedOut = false;
    const kill = () => child.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "ADB was not found. Install Android SDK Platform-Tools and add adb to PATH, or set ANDROID_ADB_PATH to adb.exe.",
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const body = output.trimEnd();
      const notes = [
        truncated ? "Output truncated." : "",
        timedOut ? `ADB stopped after ${Math.round(timeoutMs / 1000)} seconds.` : "",
        signal?.aborted ? "The run was cancelled." : "",
      ].filter(Boolean);
      resolve({ code, output: [body, ...notes].filter(Boolean).join("\n") });
    });
  });

// Android refusals that look like generic failures, with the actual fix.
export const explainAdbError = (output) => {
  if (/INJECT_EVENTS|Injecting (input events )?to another application/i.test(output)) {
    return "Android blocked simulated input. On Xiaomi/Redmi/POCO phones enable Developer options → \"USB debugging (Security settings)\" (needs a Mi account and SIM); on OPPO/realme/OnePlus/vivo disable \"Permission monitoring\" / enable \"Disable permission monitoring\" in Developer options. Then reconnect USB.";
  }
  if (/unauthorized/i.test(output)) return "The phone has not authorized this computer. Unlock it and accept the \"Allow USB debugging\" prompt (tick \"Always allow\").";
  if (/no devices|device .* not found|device offline/i.test(output)) return "The phone disconnected or is offline. Reconnect the cable, unlock the phone, then check android_diagnose.";
  if (/SecurityException|Permission Denial/i.test(output)) return "Android denied this to the ADB shell user. Shell access cannot grant it; this action needs an app-level permission (e.g. an AccessibilityService in a companion app) or is not possible without root.";
  if (/No activities found to run/i.test(output)) return "That app is not installed or has no launcher screen. Check the package id with android_list_apps.";
  if (/Error: Activity not started|unable to resolve Intent/i.test(output)) return "That screen or app activity does not exist on this device/Android version.";
  return null;
};

const runAdbChecked = async (args, options) => {
  const result = await runAdb(args, options);
  // `am`/`input`/`monkey` sometimes exit 0 while printing the refusal.
  const hint = explainAdbError(result.output);
  if (result.code !== 0 || (hint && /Exception|Error:|denied/i.test(result.output))) {
    throw new Error(`ADB failed (exit ${result.code}): ${result.output || "(no output)"}${hint ? `
Cause: ${hint}` : ""}`);
  }
  return result.output;
};

const requireConnectedUsbDevice = async (serial, signal) => {
  if (!isUsbDeviceSerial(serial)) {
    throw new Error("Choose a connected USB device serial from android_list_devices; emulators and network ADB devices are not supported.");
  }
  const devices = parseDevicesOutput(await runAdbChecked(["devices", "-l"], { signal }));
  const device = devices.find((entry) => entry.serial === serial);
  if (!device) throw new Error(`Device "${serial}" is not listed by ADB. Reconnect it and check the USB debugging prompt.`);
  if (device.state !== "device") {
    throw new Error(`Device "${serial}" is ${device.state}; unlock it and accept the USB debugging authorization prompt.`);
  }
  if (!device.canControl) throw new Error("Only authorized physical devices connected over USB can be controlled.");
};

const validateDeviceSerial = (serial) => {
  if (!isUsbDeviceSerial(serial)) {
    throw new Error("serial must be a physical USB device serial from android_list_devices.");
  }
};

export const buildAndroidActionArgs = ({ serial, action, x, y, endX, endY, durationMs, text, packageName, key, settingsScreen }) => {
  validateDeviceSerial(serial);
  const prefix = ["-s", serial, "shell"];

  if (action === "launch_app") {
    if (typeof packageName !== "string" || !PACKAGE_NAME.test(packageName)) {
      throw new Error("packageName must be a valid Android application id.");
    }
    return [...prefix, "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"];
  }
  if (action === "open_settings") {
    const intent = SETTINGS_SCREENS[settingsScreen];
    if (!intent) throw new Error(`settingsScreen must be one of: ${Object.keys(SETTINGS_SCREENS).join(", ")}.`);
    if (settingsScreen === "app_details") {
      if (typeof packageName !== "string" || !PACKAGE_NAME.test(packageName)) throw new Error("app_details needs packageName.");
      return [...prefix, "am", "start", "-a", intent, "-d", `package:${packageName}`];
    }
    return [...prefix, "am", "start", "-a", intent];
  }
  if (action === "tap") {
    if (![x, y].every((n) => Number.isInteger(n) && n >= 0 && n <= 10_000)) {
      throw new Error("x and y must be integer screen coordinates between 0 and 10000.");
    }
    return [...prefix, "input", "tap", String(x), String(y)];
  }
  if (action === "swipe") {
    if (![x, y, endX, endY].every((n) => Number.isInteger(n) && n >= 0 && n <= 10_000)) {
      throw new Error("Swipe coordinates must be integers between 0 and 10000.");
    }
    if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 2_000) {
      throw new Error("durationMs must be an integer between 50 and 2000.");
    }
    return [...prefix, "input", "swipe", String(x), String(y), String(endX), String(endY), String(durationMs)];
  }
  if (action === "type_text") {
    if (typeof text !== "string" || !text.trim() || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new Error("text must contain 1–500 printable characters.");
    }
    const encoded = text.replace(/%/g, "%25").replace(/\s/g, "%s");
    return [...prefix, `input text ${shellQuote(encoded)}`];
  }
  if (action === "press_key") {
    if (typeof key !== "string" || !KEY_CODES.has(key)) {
      throw new Error(`key must be one of: ${[...KEY_CODES].join(", ")}.`);
    }
    return [...prefix, "input", "keyevent", `KEYCODE_${key}`];
  }
  throw new Error("action must be launch_app, open_settings, tap, swipe, type_text, or press_key.");
};

const xmlDecode = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

export const inspectHierarchy = (xml) => {
  const start = xml.indexOf("<hierarchy");
  const end = xml.lastIndexOf("</hierarchy>");
  if (start < 0 || end < 0) throw new Error("ADB did not return a readable UI hierarchy.");

  const nodes = [...xml.slice(start, end + "</hierarchy>".length).matchAll(/<node\b([^>]*)\/?>/g)]
    .slice(0, 100)
    .map(([, raw]) => {
      const attrs = Object.fromEntries(
        [...raw.matchAll(/([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/g)].map(([, name, value]) => [
          name,
          xmlDecode(value),
        ]),
      );
      const password = attrs.password === "true";
      const text = password ? "[hidden password]" : attrs.text;
      const description = password ? "" : attrs["content-desc"];
      return [
        attrs.clickable === "true" ? "clickable" : "",
        attrs.enabled === "false" ? "disabled" : "",
        text ? `text="${text}"` : "",
        description ? `description="${description}"` : "",
        attrs["resource-id"] ? `id="${attrs["resource-id"]}"` : "",
        attrs.bounds ? `bounds=${attrs.bounds}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean);

  return nodes.length ? nodes.join("\n") : "(no visible UI elements)";
};

registerTool({
  name: "android_list_devices",
  category: "computer",
  description:
    "List devices visible to ADB on this computer. Shows whether USB debugging is authorized; this does not read phone content.",
  scope: "android_device",
  targetTypes: ["local", "computer"],
  parameters: { type: "object", properties: {} },
  run: async (_args, { signal }) => {
    const output = await runAdbChecked(["devices", "-l"], { signal });
    const devices = parseDevicesOutput(output);
    if (!devices.length) return "No Android devices found. Connect the phone over USB, enable USB debugging, and accept its authorization prompt.";
    return devices
      .map(({ serial, state, details, canControl }) =>
        `${serial}: ${state}${details ? ` (${details})` : ""}${canControl ? " — ready for USB control" : ""}`,
      )
      .join("\n");
  },
});

registerTool({
  name: "android_read_screen",
  category: "computer",
  description:
    "Read text and accessibility labels from the connected phone's current screen to guide UI actions. Password-field contents are hidden; other visible screen text may be included in run history and sent to the configured AI model provider.",
  scope: "android_device",
  targetTypes: ["local", "computer"],
  parameters: {
    type: "object",
    properties: { serial: { type: "string", description: "Authorized USB serial from android_list_devices." } },
    required: ["serial"],
  },
  run: async ({ serial }, { signal }) => {
    validateDeviceSerial(serial);
    await requireConnectedUsbDevice(serial, signal);
    const remotePath = `/sdcard/antral-ui-${randomUUID()}.xml`;
    try {
      await runAdbChecked(["-s", serial, "shell", "uiautomator", "dump", remotePath], {
        signal,
        timeoutMs: 30_000,
      });
      const xml = await runAdbChecked(["-s", serial, "shell", "cat", remotePath], { signal });
      const locked = /element:lockscreen|com\.android\.systemui:id\/keyguard/i.test(xml);
      const note = locked
        ? "NOTE: the phone is LOCKED — apps open behind the lock screen. Ask the user to unlock it; ADB cannot enter the PIN or biometric for them.\n"
        : "";
      return `${note}Visible screen elements (up to 100):\n${inspectHierarchy(xml)}`;
    } finally {
      await runAdbChecked(["-s", serial, "shell", "rm", "-f", remotePath], { timeoutMs: 5_000 });
    }
  },
});

registerTool({
  name: "android_interact",
  category: "computer",
  description:
    "Perform one specific action on an authorized USB-connected Android phone: launch an installed app (use android_list_apps for the package id), open a settings screen, tap or swipe screen coordinates, enter text, or press a basic navigation key. Every call asks the user for approval. No arbitrary shell commands, file access, or app installation.",
  scope: "android_device",
  targetTypes: ["local", "computer"],
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      serial: { type: "string", description: "Authorized USB serial from android_list_devices." },
      action: {
        type: "string",
        enum: ["launch_app", "open_settings", "tap", "swipe", "type_text", "press_key"],
      },
      settingsScreen: { type: "string", enum: Object.keys(SETTINGS_SCREENS), description: "Settings screen for open_settings." },
      packageName: { type: "string", description: "Installed app id, required for launch_app." },
      x: { type: "integer", description: "Starting or tap screen x coordinate." },
      y: { type: "integer", description: "Starting or tap screen y coordinate." },
      endX: { type: "integer", description: "Swipe destination x coordinate." },
      endY: { type: "integer", description: "Swipe destination y coordinate." },
      durationMs: { type: "integer", description: "Swipe duration from 50 to 2000 milliseconds." },
      text: { type: "string", description: "Text to enter, from 1 to 500 printable characters." },
      key: {
        type: "string",
        enum: ["BACK", "HOME", "ENTER", "TAB", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"],
      },
    },
    required: ["serial", "action"],
  },
  describe: ({ serial, action, packageName, x, y, endX, endY, text, key, settingsScreen }) => {
    if (action === "launch_app") return `Launch app ${packageName} on Android device ${serial}`;
    if (action === "open_settings") return `Open ${settingsScreen} settings on Android device ${serial}`;
    if (action === "tap") return `Tap Android device ${serial} at (${x}, ${y})`;
    if (action === "swipe") return `Swipe Android device ${serial} from (${x}, ${y}) to (${endX}, ${endY})`;
    if (action === "type_text") return `Type "${text}" on Android device ${serial}`;
    if (action === "press_key") return `Press ${key} on Android device ${serial}`;
    return `Interact with Android device ${serial}`;
  },
  ruleFor: ({ serial, action }) => (serial && action ? `android:${serial}:${action}` : null),
  run: async (args, { signal }) => {
    await requireConnectedUsbDevice(args.serial, signal);
    const commandArgs = buildAndroidActionArgs(args);
    const output = await runAdbChecked(commandArgs, { signal });
    return `Action "${args.action}" completed on ${args.serial}.${output ? `\n${output}` : ""}`;
  },
});

const STATE_HELP = {
  device: "connected and authorized",
  unauthorized: "connected, but this computer's RSA key was not accepted — unlock the phone and tap Allow on the USB debugging prompt (if no prompt shows: Developer options → Revoke USB debugging authorizations, then reconnect)",
  offline: "seen by ADB but not responding — unlock the phone, reconnect the cable, or toggle USB debugging off/on",
  "no permissions": "the USB device cannot be opened by ADB (driver/udev problem)",
  recovery: "in recovery mode", sideload: "in sideload mode", bootloader: "in bootloader mode",
};

// Fixed script: Android-looking USB devices Windows knows about, and their status.
const WINDOWS_USB_SCRIPT =
  "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Class -in 'AndroidUsbDeviceClass','WPD','USB','Image' -or $_.FriendlyName -match 'Android|ADB|Composite ADB|MTP|Phone' } | Where-Object { $_.FriendlyName -match 'Android|ADB|MTP|Phone|Galaxy|Pixel|Redmi|Xiaomi|POCO|OnePlus|OPPO|vivo|realme|Motorola|Nokia|Huawei|Honor|Infinix|Tecno' -or $_.Class -eq 'AndroidUsbDeviceClass' } | Select-Object Status,Class,FriendlyName | ConvertTo-Json -Compress";

registerTool({
  name: "android_diagnose",
  category: "computer",
  description:
    "Diagnose the Android connection: is ADB installed, does Windows see the phone, the ADB state (device/unauthorized/offline) with what it means, " +
    "Android version, manufacturer, and whether simulated taps/typing are allowed. Run this first when any Android action fails. Read-only.",
  scope: "android_device",
  targetTypes: ["local", "computer"],
  parameters: { type: "object", properties: {} },
  run: async (_args, { signal }) => {
    const report = { adb: adbPath() };
    try {
      report.adbVersion = (await runAdbChecked(["version"], { signal })).split(/\r?\n/).slice(0, 2).join(" ");
    } catch (e) {
      report.adbVersion = null;
      report.problem = e.message;
      report.fix = "Install Android SDK Platform-Tools (winget install Google.PlatformTools) or set ANDROID_ADB_PATH, then restart Antral.";
      return report;
    }
    const devices = parseDevicesOutput(await runAdbChecked(["devices", "-l"], { signal }));
    report.devices = [];
    for (const d of devices) {
      const entry = { serial: d.serial, state: d.state, meaning: STATE_HELP[d.state] || d.state, transport: d.canControl ? "usb" : "network/emulator", canControl: d.canControl };
      if (d.state === "device") {
        const prop = async (name) => (await runAdb(["-s", d.serial, "shell", "getprop", name], { signal })).output.trim();
        entry.android = await prop("ro.build.version.release");
        entry.sdk = Number(await prop("ro.build.version.sdk")) || null;
        entry.manufacturer = await prop("ro.product.manufacturer");
        entry.model = await prop("ro.product.model");
        // KEYCODE_UNKNOWN (0) does nothing, but is refused exactly like a real tap
        // when the vendor blocks input injection.
        const probe = await runAdb(["-s", d.serial, "shell", "input", "keyevent", "0"], { signal });
        const hint = explainAdbError(probe.output);
        entry.inputAllowed = probe.code === 0 && !hint;
        if (!entry.inputAllowed) entry.inputProblem = hint || probe.output;
        const a11y = (await runAdb(["-s", d.serial, "shell", "settings", "get", "secure", "enabled_accessibility_services"], { signal })).output.trim();
        entry.accessibilityServices = a11y && a11y !== "null" ? a11y.split(":") : [];
        const screen = (await runAdb(["-s", d.serial, "shell", "dumpsys", "power"], { signal })).output;
        entry.screenOn = /mWakefulness=Awake|Display Power: state=ON/.test(screen);
      }
      report.devices.push(entry);
    }
    if (!devices.length) {
      report.problem = "ADB sees no devices.";
      try {
        const out = await runPowerShell(WINDOWS_USB_SCRIPT, { signal, timeoutMs: 20_000 });
        const body = out.replace(/^exit code -?\d+\r?\n/, "").trim();
        report.windowsUsbDevices = body && body !== "(no output)" ? JSON.parse(body) : [];
      } catch {
        report.windowsUsbDevices = "could not query";
      }
      report.fix = Array.isArray(report.windowsUsbDevices) && report.windowsUsbDevices.length
        ? "Windows sees a phone but ADB does not: enable Developer options → USB debugging, set USB mode to File transfer, and if a device shows an error status install the OEM/Google USB driver."
        : "Windows does not see a phone at all: use a data-capable cable (many are charge-only), try another port, unlock the phone and choose File transfer.";
    }
    return report;
  },
});

registerTool({
  name: "android_list_apps",
  category: "computer",
  description: "List installed app package ids on the connected phone (user-installed by default), optionally filtered by text. Use before launch_app.",
  scope: "android_device",
  targetTypes: ["local", "computer"],
  parameters: {
    type: "object",
    properties: {
      serial: { type: "string", description: "Authorized USB serial from android_list_devices." },
      filter: { type: "string", description: "Text to match in the package id, e.g. 'whatsapp'." },
      includeSystem: { type: "boolean", description: "Include system apps. Default false." },
    },
    required: ["serial"],
  },
  run: async ({ serial, filter, includeSystem }, { signal }) => {
    validateDeviceSerial(serial);
    await requireConnectedUsbDevice(serial, signal);
    const out = await runAdbChecked(["-s", serial, "shell", "pm", "list", "packages", ...(includeSystem ? [] : ["-3"])], { signal });
    const f = typeof filter === "string" ? filter.toLowerCase() : "";
    const pkgs = out.split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter((p) => PACKAGE_NAME.test(p) && (!f || p.toLowerCase().includes(f))).sort();
    return pkgs.length ? `${pkgs.length} apps:\n${pkgs.slice(0, 300).join("\n")}` : "No matching apps.";
  },
});
