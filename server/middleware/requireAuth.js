import { createRemoteJWKSet, jwtVerify } from 'jose'

const SUPABASE_URL = process.env.SUPABASE_URL
if (!SUPABASE_URL) throw new Error('[auth] SUPABASE_URL is not set')

// JWKS is fetched once and cached automatically by jose.
// Supabase rotates keys gracefully so the cache stays valid across key rotations.
const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
)

async function verifyToken(token) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `${SUPABASE_URL}/auth/v1`,
  })
  if (!payload.email_confirmed_at) throw new Error('Email not verified')
  return payload
}

// HTTP middleware — protects Express routes.
// Expects: Authorization: Bearer <supabase-access-token>
export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    req.user = await verifyToken(token)
    next()
  } catch (err) {
    const isEmailErr = err.message === 'Email not verified'
    return res.status(isEmailErr ? 403 : 401).json({ error: err.message || 'Invalid or expired token' })
  }
}

// Socket.IO middleware — rejects unauthenticated handshakes before connection is created.
// Token passed as: io(url, { auth: { token: accessToken } })
export async function requireAuthSocket(socket, next) {
  const token = socket.handshake.auth?.token
  if (!token) return next(new Error('Unauthorized'))
  try {
    const payload = await verifyToken(token)
    // Attach stable user UUID — replaces socket.id as the player identity key
    socket.userId = payload.sub
    next()
  } catch (err) {
    next(new Error(err.message || 'Invalid or expired token'))
  }
}
