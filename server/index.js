import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { requireAuth, requireAuthSocket } from './middleware/requireAuth.js'
import { TeleportRequestsStore } from './chat/teleportRequestsStore.js'
import { createChatRateLimiter } from './chat/chatRateLimiter.js'
import tenantRouter from './routes/tenantRoutes.js'
import { canAccessWorld, getWorldById, getWorldByKey, resolveTenantContext } from './tenant/tenantService.js'
import { registerLivekitTokenRoute } from './routes/livekitTokenRoute.js'
import { registerGameSocketHandlers } from './socket/registerGameSocketHandlers.js'
import { createWorldRuntime } from './world/runtime.js'

const app = express()

function readBooleanEnv(name, defaultValue) {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue
  const normalized = String(raw).trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false
  return defaultValue
}

const ENABLE_TENANT_ROUTES = readBooleanEnv('ENABLE_TENANT_ROUTES', true)
const ENABLE_TENANT_SOCKET_CONTEXT = readBooleanEnv('ENABLE_TENANT_SOCKET_CONTEXT', true)

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : null

app.use(cors({
  origin: allowedOrigins ?? '*',
}))
app.use(express.json())
if (ENABLE_TENANT_ROUTES) {
  app.use('/tenant', tenantRouter)
} else {
  console.warn('[tenant] routes disabled by ENABLE_TENANT_ROUTES flag')
}

const tokenLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: (req) =>
    (req.user?.sub ? `lk:${req.user.sub}` : ipKeyGenerator(req.ip)),
})

registerLivekitTokenRoute({
  app,
  requireAuth,
  tokenLimiter,
})

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins ?? '*' },
})

const runtime = createWorldRuntime()
const teleportRequests = new TeleportRequestsStore({ cooldownMs: 30_000 })
const chatRateLimiter = createChatRateLimiter({
  burstTokens: 1,
  refillPerSecond: 1,
})

setInterval(() => {
  runtime.simulateTick()
}, runtime.simulationIntervalMs)

setInterval(() => {
  runtime.emitWorldSnapshot(io)
}, runtime.snapshotIntervalMs)

io.use(requireAuthSocket)
registerGameSocketHandlers({
  io,
  runtime,
  teleportRequests,
  chatRateLimiter,
  resolveTenantContext,
  canAccessWorld,
  getWorldById,
  getWorldByKey,
  enableTenantSocketContext: ENABLE_TENANT_SOCKET_CONTEXT,
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`)
})
