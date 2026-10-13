import express from "express"
import dotenv from "dotenv"
import proxy from "express-http-proxy"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
dotenv.config()

const port = process.env.PORT
const serveFrontend = process.env.SERVE_FRONTEND === "1"
const authUpstream = process.env.AUTH_SERVICE_URL || process.env.AUTH_SERVICE
const agentUpstream = process.env.AGENT_SERVICE_URL || process.env.AGENT_SERVICE

const app = express()

// Server-Sent Events (the live run stream) must be piped through unbuffered —
// express-http-proxy collects the whole body, which would break streaming. So
// forward the SSE route manually, flushing chunks as they arrive. This runs
// before the proxy mounts so it wins for the stream path.
const streamSse = (req, res) => {
  const upstream = new URL(agentUpstream)
  // Strip the gateway prefix to the agent's own path: /runs/:id/stream
  const agentPath = req.originalUrl.replace(/^\/api/, "").replace(/^\/agent/, "")
  const proxied = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: agentPath,
      method: "GET",
      headers: { ...req.headers, host: upstream.host },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.pipe(res)
    },
  )
  proxied.on("error", () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.on("close", () => proxied.destroy())
  proxied.end()
}
app.get(/^(?:\/api)?\/agent\/runs\/[^/]+\/stream$/, streamSse)

// In development the Vite proxy strips the /api prefix before the request
// reaches here, so the gateway sees /auth and /agent. In production (one
// origin, no Vite) the gateway also serves the built frontend, and the browser
// calls /api/* directly — so we additionally accept the /api prefix. Mounting
// at "/api/auth" makes Express strip the whole prefix, leaving the same path
// the "/auth" mount produces, so both forward identically.
const mountProxies = (prefix) => {
  app.use(`${prefix}/auth`, proxy(authUpstream))
  app.use(`${prefix}/agent`, proxy(agentUpstream))
}
mountProxies("")
if (serveFrontend) mountProxies("/api")

if (serveFrontend) {
  const dist = path.resolve(fileURLToPath(new URL("../../frontend/dist", import.meta.url)))
  app.use(express.static(dist))
  // SPA fallback: any GET that wasn't an API call or a real file returns the
  // app shell so client-side routing works on refresh / deep links.
  app.use((req, res, next) => {
    if (req.method !== "GET") return next()
    res.sendFile(path.join(dist, "index.html"))
  })
} else {
  app.get("/", (_req, res) => res.json({ message: "Hello from gateway" }))
}

const listening = () =>
  console.log(`gateway on port ${port}${serveFrontend ? " (serving frontend + /api)" : ""}`)
if (process.env.ANTRAL_LOCAL_DESKTOP === "1") app.listen(port, "127.0.0.1", listening)
else app.listen(port, listening)
