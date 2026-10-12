// Starts the backend services inside the packaged desktop app.
//
// In the desktop app there is no separate dev stack and no external `node` is
// required: we launch each service using Electron's own bundled Node runtime
// (process.execPath + ELECTRON_RUN_AS_NODE=1). Each service keeps reading its
// own backend/**/.env for config; we only override the ports, point the gateway
// at the sibling services, tell the gateway to serve the built frontend, and
// enable desktop mode so the agent can work on This PC.
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// The standalone project service is intentionally omitted: it is unused in the
// app (the gateway doesn't proxy to it and the agent manages projects itself),
// so the desktop app doesn't ship or run it.
const PORTS = { gateway: 7000, auth: 7001, agent: 7003 }

// Where the backend + built frontend live: in a packaged app they are copied in
// as extraResources (resources/backend, resources/frontend); in development
// (running the prod path unpackaged) they are in the repo.
const baseDir = (isPackaged) =>
  isPackaged ? process.resourcesPath : path.resolve(__dirname, '..')

const serviceEntry = (base, name) =>
  name === 'gateway'
    ? path.join(base, 'backend', 'gateway', 'index.js')
    : path.join(base, 'backend', 'services', name, 'index.js')

// Log files so issues on any machine can be diagnosed (no console in a packaged
// app). They live next to the local database, in ANTRAL_DATA_DIR/logs.
const logDir = () => {
  const dir = path.join(process.env.ANTRAL_DATA_DIR || path.join(os.homedir(), '.antral'), 'logs')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }
  return dir
}

// Env shared by every service.
const sharedEnv = () => ({
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1', // run the file as plain Node, not an Electron window
  ANTRAL_LOCAL_DESKTOP: '1', // desktop app: bind localhost + enable This PC agent
  AUTH_SERVICE_URL: `http://127.0.0.1:${PORTS.auth}`,
  AGENT_SERVICE_URL: `http://127.0.0.1:${PORTS.agent}`,
})

const children = []

const startOne = (base, name, extraEnv = {}) => {
  const entry = serviceEntry(base, name)
  if (!fs.existsSync(entry)) throw new Error(`Service file not found: ${entry}`)
  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    env: { ...sharedEnv(), PORT: String(PORTS[name]), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tag = `[${name}]`
  let logStream = null
  try {
    logStream = fs.createWriteStream(path.join(logDir(), `${name}.log`), { flags: 'a' })
    logStream.write(`\n--- ${new Date().toISOString()} starting ${name} ---\n`)
  } catch {
    // ignore log file errors
  }
  const pipe = (data) => {
    process.stdout.write(`${tag} ${data}`)
    try {
      logStream?.write(data)
    } catch {
      // ignore
    }
  }
  child.stdout.on('data', pipe)
  child.stderr.on('data', pipe)
  child.on('exit', (code) => pipe(`(exited with code ${code})\n`))
  children.push(child)
  return child
}

// Resolves once the service answers HTTP on its port (any status = listening).
const waitForService = async (name, { tries = 150 } = {}) => {
  const url = `http://127.0.0.1:${PORTS[name]}/`
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) })
      return // any response means it's listening
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`The Antral ${name} service did not start (on 127.0.0.1:${PORTS[name]}).`)
}

const startServices = async (isPackaged) => {
  const base = baseDir(isPackaged)
  startOne(base, 'auth')
  startOne(base, 'agent')
  startOne(base, 'gateway', { SERVE_FRONTEND: '1' })
  // Wait for ALL of them before the window loads, so the UI never calls an
  // endpoint (e.g. /consent/policies on the agent) before its service is ready.
  await Promise.all([waitForService('auth'), waitForService('agent'), waitForService('gateway')])
}

const stopServices = () => {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      // already gone
    }
  }
  children.length = 0
}

module.exports = { startServices, stopServices, PORTS }
