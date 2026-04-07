import { AccessToken } from 'livekit-server-sdk'

const ZONE_KEYS = ['dev', 'design', 'game']
const ALLOWED_ROOMS = new Set([
  'gather-world',
  ...ZONE_KEYS.map(zoneKey => `gather-world-zone-${zoneKey}`),
])

function createLivekitToken({ apiKey, apiSecret, identity, name, roomName, tokenIntent }) {
  const accessToken = new AccessToken(apiKey, apiSecret, {
    identity,
    ttl: tokenIntent === 'prefetch' ? '30s' : '2h',
    name: name || identity,
  })

  accessToken.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: tokenIntent === 'join',
    canSubscribe: tokenIntent === 'join',
    canUpdateOwnMetadata: tokenIntent === 'join',
  })

  return accessToken.toJwt()
}

export function registerLivekitTokenRoute({ app, requireAuth, tokenLimiter }) {
  const livekitUrl = process.env.LIVEKIT_URL
  const livekitApiKey = process.env.LIVEKIT_API_KEY || ''
  const livekitApiSecret = process.env.LIVEKIT_API_SECRET || ''

  if (!livekitUrl) {
    console.error('[livekit] LIVEKIT_URL is not set. Voice will not function.')
  }

  app.post('/livekit/token', requireAuth, tokenLimiter, async (req, res) => {
    const { roomName, identity, name, intent } = req.body || {}
    if (!identity || typeof identity !== 'string') {
      return res.status(400).json({ error: 'identity required' })
    }
    if (!ALLOWED_ROOMS.has(roomName)) {
      return res.status(400).json({ error: 'invalid room' })
    }

    const authedUserId = req.user?.sub
    if (!authedUserId || authedUserId !== identity) {
      return res.status(403).json({ error: 'identity mismatch' })
    }

    const tokenIntent = intent === 'prefetch' ? 'prefetch' : 'join'
    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      return res.status(500).json({ error: 'LiveKit not configured' })
    }

    try {
      const token = await createLivekitToken({
        apiKey: livekitApiKey,
        apiSecret: livekitApiSecret,
        identity,
        name,
        roomName,
        tokenIntent,
      })
      return res.json({ token, url: livekitUrl })
    } catch (error) {
      console.error('[livekit] token error:', error)
      return res.status(500).json({ error: 'Failed to create token' })
    }
  })
}
