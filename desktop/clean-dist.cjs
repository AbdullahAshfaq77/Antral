// Deletes old installer outputs before a build. Overwriting an existing
// Antral-Setup-*.exe fails with "Can't open output file" when Windows Defender
// is still scanning it, so start from a clean slate instead.
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "dist-desktop");
if (fs.existsSync(dir)) {
  for (const name of fs.readdirSync(dir)) {
    if (/^Antral-Setup-|^latest\.yml$|^__uninstaller|\.nsis\.7z$/.test(name)) {
      fs.rmSync(path.join(dir, name), { force: true, maxRetries: 10, retryDelay: 500 });
    }
  }
}
