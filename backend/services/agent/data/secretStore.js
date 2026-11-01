import { execFileSync } from "node:child_process";

// Windows DPAPI binds ciphertext to the current OS user, so separate Antral
// service processes can read the same encrypted value without sharing a key.
// No credential is placed in a command line, environment variable, or log.
const runDpapi = (value, encrypt) => {
  if (process.platform !== "win32") throw new Error("The encrypted local provider keystore requires Windows DPAPI; use .env credentials in this development environment.");
  const script = encrypt
    ? "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop;$b=[Console]::In.ReadToEnd();$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));$s=ConvertTo-SecureString -String $v -AsPlainText -Force;ConvertFrom-SecureString -SecureString $s"
    : "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop;$b=[Console]::In.ReadToEnd();$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));$s=ConvertTo-SecureString -String $v;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{$x=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p);[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($x))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}";
  try {
    return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      input: Buffer.from(String(value), "utf8").toString("base64"),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 16 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PSModulePath: (process.env.PSModulePath || "").split(";").filter((entry) => !/codex-runtimes/i.test(entry)).join(";") },
    }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.message || error.code || error.name || "PowerShell failed").slice(0, 120);
    throw new Error(`Could not access the current Windows user's encrypted provider keystore (${detail}).`);
  }
};

export const encryptSecret = (value) => value ? `dpapi:${runDpapi(String(value), true)}` : "";
export const decryptSecret = (value) => {
  if (!value) return "";
  if (!String(value).startsWith("dpapi:")) return String(value); // migration input only
  return Buffer.from(runDpapi(String(value).slice(6), false), "base64").toString("utf8");
};
