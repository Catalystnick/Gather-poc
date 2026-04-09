import { AccessToken } from 'livekit-server-sdk'
import { canAccessWorld, getWorldById } from '../tenant/tenantService.js'
import { observeLivekitTokenIssued, observeLivekitTokenRejected } from '../observability/tenantObservability.js'

const ROOM_PREFIX = 'gather-tenant-interior-'
const ZONE_SEGMENT = '-zone-'

export function isValidZoneKey(zoneKey) {
  if (zoneKey === undefined || zoneKey === null) return true
  if (typeof zoneKey !== 'string') return false
  const normalized = zoneKey.trim()
  if (!normalized) return false
  return /^[A-Za-z0-9_-]{1,64}$/.test(normalized)
}

function getProximityRoomName(worldId) {
  return `${ROOM_PREFIX}${worldId}`
}

function getZoneRoomName(worldId, zoneKey) {
  return `${ROOM_PREFIX}${worldId}${ZONE_SEGMENT}${zoneKey}`
}

export function deriveLivekitRoomName(worldId, zoneKey) {
  const normalizedZoneKey = typeof zoneKey === 'string' ? zoneKey.trim() : ''
  if (!normalizedZoneKey) return getProximityRoomName(worldId)
  return getZoneRoomName(worldId, normalizedZoneKey)
}

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
    const { identity, name, intent, worldId, zoneKey } = req.body || {}
    if (!identity || typeof identity !== 'string') {
      observeLivekitTokenRejected('identity_required')
      return res.status(400).json({ error: 'identity required' })
    }

    const normalizedWorldId = typeof worldId === 'string' ? worldId.trim() : ''
    if (!normalizedWorldId) {
      observeLivekitTokenRejected('world_id_required')
      return res.status(400).json({ error: 'worldId required' })
    }

    if (!isValidZoneKey(zoneKey)) {
      observeLivekitTokenRejected('invalid_zone_key')
      return res.status(400).json({ error: 'invalid zoneKey' })
    }

    const authedUserId = req.user?.sub
    if (!authedUserId || authedUserId !== identity) {
      observeLivekitTokenRejected('identity_mismatch')
      return res.status(403).json({ error: 'identity mismatch' })
    }

    const tokenIntent = intent === 'prefetch' ? 'prefetch' : 'join'
    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      observeLivekitTokenRejected('livekit_not_configured')
      return res.status(500).json({ error: 'LiveKit not configured' })
    }

    try {
      const world = await getWorldById(normalizedWorldId)
      if (!world || world.world_type !== 'tenant_interior') {
        observeLivekitTokenRejected('voice_world_denied')
        return res.status(403).json({ error: 'voice_world_denied' })
      }

      const canJoinWorldVoice = await canAccessWorld(authedUserId, normalizedWorldId)
      if (!canJoinWorldVoice) {
        observeLivekitTokenRejected('voice_world_denied')
        return res.status(403).json({ error: 'voice_world_denied' })
      }

      const roomName = deriveLivekitRoomName(normalizedWorldId, zoneKey)
      const token = await createLivekitToken({
        apiKey: livekitApiKey,
        apiSecret: livekitApiSecret,
        identity,
        name,
        roomName,
        tokenIntent,
      })
      observeLivekitTokenIssued()
      return res.json({ token, url: livekitUrl })
    } catch (error) {
      console.error('[livekit] token error:', error)
      observeLivekitTokenRejected('token_creation_failed')
      return res.status(500).json({ error: 'Failed to create token' })
    }
  })
}
