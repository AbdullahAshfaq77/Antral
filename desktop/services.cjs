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
  child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`))
  child.on('exit', (code) => console.log(`${tag} exited with code ${code}`))
  children.push(child)
  return child
}

const waitForGateway = async () => {
  const url = `http://127.0.0.1:${PORTS.gateway}/`
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`The Antral services did not start (gateway on ${url}).`)
}

const startServices = async (isPackaged) => {
  const base = baseDir(isPackaged)
  // Order doesn't strictly matter (they retry their own connections), but start
  // the backing services before the gateway that proxies to them.
  startOne(base, 'auth')
  startOne(base, 'agent')
  startOne(base, 'gateway', { SERVE_FRONTEND: '1' })
  await waitForGateway()
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
