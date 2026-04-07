// Unified voice hook — manages both the permanent proximity room (gather-world)
// and transient zone rooms (gather-world-zone-{key}).
//
// Replaces useLiveKitVoice + useZoneVoice. Returns a complete VoiceState so
// World.tsx no longer needs to manually merge state from two separate hooks.
//
// Proximity room: always connected when mic is ready. Distance-gated subscriptions.
// Zone room: created/destroyed as the player enters/leaves zone boundaries.
//
// Voice is proximity XOR zone for UX: while activeZoneKey is set, proximity peer
// subscriptions are suppressed (gating) and zone owns who you hear.
// One underlying capture from useMicTrack; LiveKit publish uses the VAD-gated
// Web Audio send stream (VAD gate → destination), fed from browser-processed mic capture.

import { useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { RemotePlayer } from '../types'
import type { MicTrack } from './useMicTrack'
import type { VoiceState } from '../contexts/VoiceContext'
import {
  Room, RoomEvent, Track,
  type LocalAudioTrack,
  type RemoteParticipant, type RemoteTrackPublication, type RemoteAudioTrack,
} from 'livekit-client'
import { getZoneKey } from '../utils/zoneDetection'
import { tileToWorld } from '../utils/gridHelpers'
import { TILE_PX } from '../game/engine/constants'
import {
  ROOM_NAME, ZONE_ROOM_PREFIX,
  type CachedToken, type TokenIntent,
  createRoom, fetchToken, fetchTokenDetailed, tokenIsValid, attachRemoteAudio,
  createLocalMicTrack,
  AUDIO_PUBLISH_OPTS,
} from '../utils/voiceRoom'

// ─── Constants ────────────────────────────────────────────────────────────────

const CONNECT_RANGE       = 7
const DISCONNECT_RANGE    = 9
const MIN_GAIN_FLOOR      = 0.15
const MAX_ACTIVE_PEERS    = 16
const DEFAULT_ROLLOFF     = 1.4
const ZONE_DEBOUNCE_TICKS = 2
/** Cap linear gain sent to Web Audio (distance × remote slider × boost). */
const MAX_LINEAR_PLAYBACK = 6

const GAIN_STORAGE_KEY    = 'gather_poc_remote_gain'
const PLAYBACK_BOOST_STORAGE_KEY = 'gather_poc_playback_boost'
const DEFAULT_PLAYBACK_BOOST     = 1.75
const MIN_PLAYBACK_BOOST         = 1
const MAX_PLAYBACK_BOOST         = 4
const ROLLOFF_STORAGE_KEY = 'gather_poc_rolloff'

export type VoiceMode = 'proximity' | 'zone' | 'switching'

// ─── Internal entry types ─────────────────────────────────────────────────────

interface ProximityEntry {
  participant: RemoteParticipant
  track: RemoteAudioTrack
  audio: HTMLAudioElement
  gainNode: GainNode | null
}

interface ZoneEntry {
  track: RemoteAudioTrack
  audio: HTMLAudioElement
}

// ─── Storage loaders ──────────────────────────────────────────────────────────

/** Load persisted remote voice gain from local storage. */
function loadRemoteGain(): number {
  try {
    const raw = localStorage.getItem(GAIN_STORAGE_KEY)
    if (raw === null) return 1
    const parsedValue = Number(raw)
    if (Number.isNaN(parsedValue)) return 1
    return Math.min(1, Math.max(0, parsedValue))
  } catch { return 1 }
}

/** Load persisted distance rolloff exponent for proximity attenuation. */
function loadRolloff(): number {
  try {
    const parsedValue = Number(localStorage.getItem(ROLLOFF_STORAGE_KEY))
    return Number.isNaN(parsedValue) ? DEFAULT_ROLLOFF : Math.max(0.1, parsedValue)
  } catch { return DEFAULT_ROLLOFF }
}

/** Load persisted playback boost multiplier for remote audio. */
function loadPlaybackBoost(): number {
  try {
    const parsedValue = Number(localStorage.getItem(PLAYBACK_BOOST_STORAGE_KEY))
    if (Number.isNaN(parsedValue)) return DEFAULT_PLAYBACK_BOOST
    return Math.min(MAX_PLAYBACK_BOOST, Math.max(MIN_PLAYBACK_BOOST, parsedValue))
  } catch { return DEFAULT_PLAYBACK_BOOST }
}

/** Euclidean distance between two world-space points. */
function dist2(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

/** Convert a remote player's tile position into world-space coordinates. */
function playerPos(remotePlayer: RemotePlayer): { x: number; y: number } {
  return tileToWorld(remotePlayer.worldX / TILE_PX, remotePlayer.worldY / TILE_PX)
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVoice(
  socket: Socket | null,
  localPositionRef: React.MutableRefObject<{ x: number; y: number; z: number }>,
  remotePlayers: Map<string, RemotePlayer>,
  mic: MicTrack,
  accessToken: string,
  userId: string,
  zones: import('../types/mapTypes').Zone[],
): VoiceState {
  /** Central voice coordinator: manages proximity room, zone room, and audio state syncing. */

  // ── React state ────────────────────────────────────────────────────────────
  const [speakingPeers,       setSpeakingPeers]       = useState<Set<string>>(new Set())
  const [connectedPeers,      setConnectedPeers]      = useState<Set<string>>(new Set())
  const [peerConnectionStates, setPeerConnectionStates] = useState<Record<string, string>>({})
  const [remoteGain,          setRemoteGainState]     = useState(loadRemoteGain)
  const [rolloff]                                      = useState(loadRolloff)
  const [audioBlocked,        setAudioBlocked]        = useState(false)
  const [audioInterrupted,    setAudioInterrupted]    = useState(false)
  const [proximityRoomReady,  setProximityRoomReady]  = useState(false)
  const [mode,                setMode]                = useState<VoiceMode>('proximity')
  const [activeZoneKey,       setActiveZoneKey]       = useState<string | null>(null)
  const [playbackBoost,      setPlaybackBoostState]   = useState(loadPlaybackBoost)

  // ── Room refs ──────────────────────────────────────────────────────────────
  const proximityRoomRef         = useRef<Room | null>(null)
  const zoneRoomRef              = useRef<Room | null>(null)
  const proximityPublishedCloneRef = useRef<MediaStreamTrack | null>(null)
  const zonePublishedCloneRef    = useRef<MediaStreamTrack | null>(null)
  // LocalAudioTrack wrappers for published send path; stopped on cleanup.
  const proximityLocalTrackRef   = useRef<LocalAudioTrack | null>(null)
  const zoneLocalTrackRef        = useRef<LocalAudioTrack | null>(null)

  // ── Remote entry maps ──────────────────────────────────────────────────────
  const proximityEntries = useRef<Map<string, ProximityEntry>>(new Map())
  const zoneEntries      = useRef<Map<string, ZoneEntry>>(new Map())
  const subscribedIds    = useRef<Set<string>>(new Set())  // proximity subscriptions

  // ── Token cache ────────────────────────────────────────────────────────────
  const tokenCacheRef = useRef<Record<string, CachedToken>>({})
  const tokenInFlightRef = useRef<Set<string>>(new Set())
  const zoneTokenBackoffMsRef = useRef<Record<string, number>>({})
  const zoneTokenBlockedUntilRef = useRef<Record<string, number>>({})

  // ── Zone transition guards ─────────────────────────────────────────────────
  const activeZoneKeyRef  = useRef<string | null>(null)
  const modeRef           = useRef<VoiceMode>('proximity')
  const targetZoneRef     = useRef<string | null | undefined>(undefined)
  const pendingZoneRef    = useRef<string | null | undefined>(undefined)
  const debounceTicksRef  = useRef(0)
  const generationRef     = useRef(0)
  // ── Stable value refs ──────────────────────────────────────────────────────
  const remoteGainRef    = useRef(remoteGain)
  remoteGainRef.current  = remoteGain
  const playbackBoostRef = useRef(playbackBoost)
  playbackBoostRef.current = playbackBoost
  const rolloffRef       = useRef(rolloff)
  rolloffRef.current     = rolloff
  const accessTokenRef   = useRef(accessToken)
  accessTokenRef.current = accessToken
  const remotePlayersRef = useRef(remotePlayers)
  remotePlayersRef.current = remotePlayers

  // ── Sync helpers ───────────────────────────────────────────────────────────

  /** Keep mode in both ref and React state for sync across async transitions. */
  function syncMode(nextMode: VoiceMode) {
    console.log('[voice] mode:', modeRef.current, '->', nextMode)
    modeRef.current = nextMode
    setMode(nextMode)
  }

  /** Keep active zone key in both ref and React state for stable interval reads. */
  function syncZoneKey(nextZoneKey: string | null) {
    console.log('[voice] activeZoneKey:', activeZoneKeyRef.current, '->', nextZoneKey)
    activeZoneKeyRef.current = nextZoneKey
    setActiveZoneKey(nextZoneKey)
  }

  /** Track connection-state badges for HUD diagnostics. */
  function setPeerState(identity: string, state: string | null) {
    setPeerConnectionStates(prev => {
      const next = { ...prev }
      if (state === null) delete next[identity]
      else next[identity] = state
      return next
    })
  }

  /**
   * Remove mic from the LiveKit PC without calling MediaStreamTrack.stop() — the same
   * hardware track must stay alive for useMicTrack / the next publish.
   */
  async function safeUnpublishUserMicTrack(room: Room, track: LocalAudioTrack) {
    const pubs = [...room.localParticipant.trackPublications.values()]
    const publication = pubs.find(trackPublication => trackPublication.track === track || (track.sid && trackPublication.trackSid === track.sid))
    if (!publication) {
      try { await track.stopProcessor() } catch { /* ignore */ }
      return
    }
    try {
      await room.localParticipant.unpublishTrack(track, false)
    } catch {
      /* ignore */
    }
    try {
      await track.stopProcessor()
    } catch {
      /* ignore */
    }
  }

  // ── Proximity entry cleanup ────────────────────────────────────────────────

  /** Tear down one proximity audio subscription and its attached DOM audio node. */
  function cleanupProximityEntry(identity: string) {
    const entry = proximityEntries.current.get(identity)
    if (!entry) return
    entry.gainNode?.disconnect()
    entry.track.detach().forEach(audioElement => audioElement.remove())
    entry.audio.remove()
    proximityEntries.current.delete(identity)
    subscribedIds.current.delete(identity)
  }

  /** Tear down all proximity audio subscriptions. */
  function cleanupAllProximity() {
    ;[...proximityEntries.current.keys()].forEach(cleanupProximityEntry)
  }

  // ── Zone entry cleanup ─────────────────────────────────────────────────────

  /** Tear down one zone-room audio subscription and its attached DOM audio node. */
  function cleanupZoneEntry(identity: string) {
    const entry = zoneEntries.current.get(identity)
    if (!entry) return
    entry.track.detach().forEach(audioElement => audioElement.remove())
    entry.audio.remove()
    zoneEntries.current.delete(identity)
  }

  /** Tear down all zone-room subscriptions. */
  function cleanupAllZone() {
    ;[...zoneEntries.current.keys()].forEach(cleanupZoneEntry)
  }

  // ── Token cache helpers ────────────────────────────────────────────────────

  /** Read a still-valid cached token for the requested zone room intent. */
  function getCachedToken(zoneKey: string, intent: TokenIntent): CachedToken | null {
    const cachedToken = tokenCacheRef.current[zoneKey]
    if (!cachedToken || cachedToken.intent !== intent || !tokenIsValid(cachedToken)) {
      if (cachedToken) delete tokenCacheRef.current[zoneKey]
      return null
    }
    return cachedToken
  }

  /** Return remaining cooldown before we can retry zone token fetches. */
  function getZoneTokenCooldownMs(zoneKey: string): number {
    const blockedUntil = zoneTokenBlockedUntilRef.current[zoneKey] ?? 0
    return Math.max(0, blockedUntil - Date.now())
  }

  /** Fetch and cache a zone token with backoff handling for transient failures/rate limits. */
  async function fetchZoneToken(identity: string, zoneKey: string, intent: TokenIntent): Promise<CachedToken | null> {
    const cooldownMs = getZoneTokenCooldownMs(zoneKey)
    if (cooldownMs > 0) {
      console.warn('[voice] zone token cooldown active | zone:', zoneKey, '| retry in ms:', cooldownMs)
      return null
    }
    if (tokenInFlightRef.current.has(zoneKey)) return null
    tokenInFlightRef.current.add(zoneKey)
    const roomName = `${ZONE_ROOM_PREFIX}${zoneKey}`
    console.log('[voice] fetching token | zone:', zoneKey, '| intent:', intent)
    const result = await fetchTokenDetailed(identity, roomName, accessTokenRef.current, intent)
      .finally(() => tokenInFlightRef.current.delete(zoneKey))
    const cached = result.cached
    if (cached) {
      tokenCacheRef.current[zoneKey] = cached
      zoneTokenBackoffMsRef.current[zoneKey] = 0
      zoneTokenBlockedUntilRef.current[zoneKey] = 0
      console.log('[voice] token cached | zone:', zoneKey, '| age:', Math.round((Date.now() - cached.fetchedAt) / 1000), 's')
    } else {
      let next = 2_000
      if (result.status === 429) {
        const prev = zoneTokenBackoffMsRef.current[zoneKey] || 0
        next = Math.min(60_000, prev > 0 ? prev * 2 : 5_000)
      } else if (result.status === 403) {
        // Likely zone membership propagation race. Retry soon.
        next = 500
      }
      zoneTokenBackoffMsRef.current[zoneKey] = next
      zoneTokenBlockedUntilRef.current[zoneKey] = Date.now() + next
      console.warn('[voice] token fetch failed | zone:', zoneKey, '| status:', result.status, '| backoff ms:', next)
    }
    return cached
  }

  // ── Zone room transition ───────────────────────────────────────────────────

  /** Execute zone-room enter/exit transition while guarding against stale async completions. */
  async function transitionToZone(identity: string, targetKey: string | null) {
    const myGen = ++generationRef.current
    const cancelled = () => generationRef.current !== myGen
    console.log('[voice] zone transition | from:', activeZoneKeyRef.current, '→', targetKey, '| gen:', myGen)
    if (targetKey) {
      console.log('[voice][zone-enter] begin | zone:', targetKey)
    }
    syncMode('switching')

    const oldRoom = zoneRoomRef.current
    const oldLocalTrack = zoneLocalTrackRef.current
    const oldClone = zonePublishedCloneRef.current
    zoneRoomRef.current = null
    zoneLocalTrackRef.current = null
    zonePublishedCloneRef.current = null

    if (oldRoom) {
      console.log('[voice] disconnecting old zone room | gen:', myGen)
      try {
        if (oldLocalTrack) await safeUnpublishUserMicTrack(oldRoom, oldLocalTrack)
        if (oldClone) { mic.removePublishedClone(oldClone); oldClone.stop() }
      } catch { /* ignore */ }
      await oldRoom.disconnect(false).catch(() => {})
      if (cancelled()) { console.log('[voice] cancelled after old room disconnect | gen:', myGen); return }
    }

    // Silence old zone audio before connecting new room.
    cleanupAllZone()
    setConnectedPeers(new Set(subscribedIds.current))

    if (targetKey === null) {
      console.log('[voice] returned to proximity | gen:', myGen)
      targetZoneRef.current = null
      syncZoneKey(null)
      syncMode('proximity')
      return
    }

    // Resolve token (cached first)
    let token = getCachedToken(targetKey, 'join')
    if (token) {
      console.log('[voice] using cached token | zone:', targetKey)
    } else {
      token = await fetchZoneToken(identity, targetKey, 'join')
    }
    if (cancelled()) { console.log('[voice] cancelled after token | gen:', myGen); return }
    if (!token) {
      console.warn('[voice] zone token failed — staying proximity | zone:', targetKey)
      targetZoneRef.current = undefined
      syncZoneKey(null)
      syncMode('proximity')
      return
    }

    // Build zone room
    const room = createRoom(mic.audioCtxRef.current)
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return
      console.log('[voice] zone track subscribed | peer:', participant.identity)
      cleanupZoneEntry(participant.identity)
      const audioTrack = track as RemoteAudioTrack
      const zLinear = Math.min(
        MAX_LINEAR_PLAYBACK,
        Math.max(0, remoteGainRef.current * playbackBoostRef.current),
      )
      const audio = attachRemoteAudio(audioTrack, zLinear)
      zoneEntries.current.set(participant.identity, { track: audioTrack, audio })
      setConnectedPeers(new Set(zoneEntries.current.keys()))
      void audio.play().catch(err => console.warn('[voice] zone audio.play blocked:', err))
    })

    room.on(RoomEvent.TrackUnsubscribed, (_t, _p, participant) => {
      console.log('[voice] zone track unsubscribed | peer:', participant.identity)
      cleanupZoneEntry(participant.identity)
      setConnectedPeers(new Set(zoneEntries.current.keys()))
    })

    room.on(RoomEvent.ParticipantDisconnected, participant => {
      console.log('[voice] zone participant left | peer:', participant.identity)
      cleanupZoneEntry(participant.identity)
      setConnectedPeers(new Set(zoneEntries.current.keys()))
    })

    room.on(RoomEvent.Disconnected, () => {
      if (zoneRoomRef.current !== room) return
      console.log('[voice] zone room unexpected disconnect | zone:', targetKey)
      zoneRoomRef.current = null
      cleanupAllZone()
      setConnectedPeers(new Set(subscribedIds.current))
      console.log('[voice] resetting guards | targetZone:', targetZoneRef.current, '→ undefined')
      targetZoneRef.current = undefined
      syncZoneKey(null)
      syncMode('proximity')
    })

    // Connect
    console.log('[voice] connecting zone room | zone:', targetKey, '| url:', token.url)
    try {
      await room.connect(token.url, token.token, { autoSubscribe: true })
    } catch (err) {
      console.warn('[voice] zone connect failed | zone:', targetKey, '| err:', err)
      if (!cancelled()) {
        targetZoneRef.current = undefined
        syncZoneKey(null)
        syncMode('proximity')
      }
      return
    }
    if (cancelled()) {
      console.log('[voice] cancelled after connect | gen:', myGen)
      await room.disconnect(false).catch(() => {})
      return
    }
    console.log('[voice] zone connected | zone:', targetKey, '| participants:', room.remoteParticipants.size)

    zoneRoomRef.current = room

    const sendTrack = mic.sendMicStreamRef.current?.getAudioTracks()[0]
    if (sendTrack) {
      // Clone so zone and proximity have independent entries in publishedClonesRef.
      // Removing the zone clone on exit won't deregister the proximity clone.
      const zoneTrackClone = sendTrack.clone()
      console.log('[voice][zone] publish mic | zone:', targetKey, '| clone id:', zoneTrackClone.id, '| state:', zoneTrackClone.readyState)
      mic.addPublishedClone(zoneTrackClone)
      zonePublishedCloneRef.current = zoneTrackClone
      const localTrack = createLocalMicTrack(zoneTrackClone, mic.audioCtxRef.current ?? undefined)
      zoneLocalTrackRef.current = localTrack
      console.log('[voice][zone] localTrack ready | sid?:', localTrack.sid ?? 'n/a', '| mediaStreamTrack id:', localTrack.mediaStreamTrack.id)
      await room.localParticipant.publishTrack(localTrack, AUDIO_PUBLISH_OPTS)
        .catch(err => console.warn('[voice] zone publish failed:', err))
      console.log('[voice][zone] publish attempted | mediaStreamTrack id:', localTrack.mediaStreamTrack.id)
    } else {
      console.warn('[voice] no source mic track to publish | zone:', targetKey)
    }
    if (cancelled()) {
      console.log('[voice] cancelled after publish | gen:', myGen)
      const localTrackCleanup = zoneLocalTrackRef.current
      zoneLocalTrackRef.current = null
      if (localTrackCleanup && room) {
        try { await safeUnpublishUserMicTrack(room, localTrackCleanup) } catch { /* ignore */ }
      } else if (localTrackCleanup) {
        try { await localTrackCleanup.stopProcessor() } catch { /* ignore */ }
      }
      await room.disconnect(false).catch(() => {})
      zoneRoomRef.current = null
      const clone = zonePublishedCloneRef.current
      zonePublishedCloneRef.current = null
      if (clone) { mic.removePublishedClone(clone); clone.stop() }
      return
    }

    const ctx = mic.audioCtxRef.current
    if (ctx?.state === 'running') void room.startAudio().catch(() => {})

    console.log('[voice] zone transition complete | zone:', targetKey, '| gen:', myGen)
    syncZoneKey(targetKey)
    syncMode('zone')
  }

  // ── Effect: proximity room connection ──────────────────────────────────────

  useEffect(() => {
    if (!socket?.id || !mic.isReady) return
    const identity = userId
    let room: Room | null = null
    /** Dev Strict Mode remounts immediately; finish async work only if still active. */
    let cancelled  = false

    async function connect() {
      try {
        const token = await fetchToken(identity, ROOM_NAME, accessTokenRef.current)
        if (cancelled) return
        if (!token) throw new Error('proximity token fetch failed')

        room = createRoom(mic.audioCtxRef.current)
        room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
          if (track.kind !== Track.Kind.Audio) return
          cleanupProximityEntry(participant.identity)
          subscribedIds.current.add(participant.identity)
          const audioTrack = track as RemoteAudioTrack
          const initialLinear = Math.min(
            MAX_LINEAR_PLAYBACK,
            Math.max(0, MIN_GAIN_FLOOR * remoteGainRef.current * playbackBoostRef.current),
          )
          const audio = attachRemoteAudio(audioTrack, initialLinear)
          proximityEntries.current.set(participant.identity, { participant, track: audioTrack, audio, gainNode: null })
          setPeerState(participant.identity, 'connected')
          void audio.play().catch(() => setAudioBlocked(true))
        })

        room.on(RoomEvent.TrackUnsubscribed, (_t, _p, participant) => {
          cleanupProximityEntry(participant.identity)
          setPeerState(participant.identity, null)
        })

        room.on(RoomEvent.ParticipantDisconnected, participant => {
          cleanupProximityEntry(participant.identity)
          setPeerState(participant.identity, null)
        })

        room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
          if (!room?.canPlaybackAudio) setAudioBlocked(true)
        })

        room.on(RoomEvent.Disconnected, () => {
          setProximityRoomReady(false)
          proximityRoomRef.current = null
          cleanupAllProximity()
          subscribedIds.current.clear()
          if (activeZoneKeyRef.current === null) setConnectedPeers(new Set())
          setPeerConnectionStates({})
        })

        room.on(RoomEvent.Reconnecting, () => setProximityRoomReady(false))
        room.on(RoomEvent.Reconnected,  () => setProximityRoomReady(true))

        room.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (publication.kind !== Track.Kind.Audio) return
          if (activeZoneKeyRef.current !== null) return
          const player = remotePlayersRef.current.get(participant.identity)
          if (!player || player.zoneKey !== null) return
          if (dist2(localPositionRef.current, playerPos(player)) < CONNECT_RANGE) {
            publication.setSubscribed(true)
            subscribedIds.current.add(participant.identity)
          }
        })

        await room.connect(token.url, token.token, { autoSubscribe: false })
        if (cancelled) {
          await room.disconnect(false).catch(() => {})
          return
        }
        proximityRoomRef.current = room

        const ctx = mic.audioCtxRef.current
        if (ctx?.state === 'running') void room.startAudio().catch(() => {})
        else if (ctx?.state === 'suspended') setAudioBlocked(true)
        setProximityRoomReady(true)

        const sendTrack = mic.sendMicStreamRef.current?.getAudioTracks()[0]
        if (sendTrack) {
          if (cancelled) {
            await room.disconnect(false).catch(() => {})
            return
          }
          console.log('[voice][join] publish mic | proximity | trackId:', sendTrack.id)
          console.log('[voice][proximity] send (VAD) | id:', sendTrack.id, '| state:', sendTrack.readyState, '| enabled:', sendTrack.enabled)
          mic.addPublishedClone(sendTrack)
          proximityPublishedCloneRef.current = sendTrack
          const localTrack = createLocalMicTrack(sendTrack, mic.audioCtxRef.current ?? undefined)
          if (cancelled) {
            mic.removePublishedClone(sendTrack)
            proximityPublishedCloneRef.current = null
            try { await localTrack.stopProcessor() } catch { /* ignore */ }
            await room.disconnect(false).catch(() => {})
            return
          }
          proximityLocalTrackRef.current = localTrack
          console.log('[voice][proximity] localTrack ready | sid?:', localTrack.sid ?? 'n/a', '| mediaStreamTrack id:', localTrack.mediaStreamTrack.id)
          await room.localParticipant.publishTrack(localTrack, AUDIO_PUBLISH_OPTS)
            .catch(err => console.warn('[voice] proximity publish failed:', err))
          if (cancelled) {
            mic.removePublishedClone(sendTrack)
            proximityPublishedCloneRef.current = null
            proximityLocalTrackRef.current = null
            try { await safeUnpublishUserMicTrack(room, localTrack) } catch { /* ignore */ }
            await room.disconnect(false).catch(() => {})
            return
          }
          console.log('[voice][proximity] publish attempted | mediaStreamTrack id:', localTrack.mediaStreamTrack.id)
        }

        // Subscribe to existing in-range participants
        if (cancelled) return
        for (const participant of room.remoteParticipants.values()) {
          const player = remotePlayersRef.current.get(participant.identity)
          if (!player || player.zoneKey !== null || activeZoneKeyRef.current !== null) continue
          if (dist2(localPositionRef.current, playerPos(player)) < DISCONNECT_RANGE) {
            for (const pub of participant.trackPublications.values()) {
              if (pub.kind === Track.Kind.Audio && !pub.isSubscribed) {
                (pub as RemoteTrackPublication).setSubscribed(true)
                subscribedIds.current.add(participant.identity)
              }
            }
          }
        }
      } catch (err) {
        console.warn('[voice] proximity connect failed:', err)
      }
    }

    void connect()

    return () => {
      cancelled = true
      setProximityRoomReady(false)
      const localTrackCleanup = proximityLocalTrackRef.current
      proximityLocalTrackRef.current = null
      const clone = proximityPublishedCloneRef.current
      proximityPublishedCloneRef.current = null
      if (clone) mic.removePublishedClone(clone)
      const roomToCleanup = room
      proximityRoomRef.current = null
      cleanupAllProximity()
      subscribedIds.current.clear()
      void (async () => {
        try {
          if (roomToCleanup && localTrackCleanup) {
            await safeUnpublishUserMicTrack(roomToCleanup, localTrackCleanup)
          } else if (localTrackCleanup) {
            try { await localTrackCleanup.stopProcessor() } catch { /* ignore */ }
          }
          if (roomToCleanup) await roomToCleanup.disconnect(false).catch(() => {})
        } catch { /* ignore */ }
      })()
    }
  }, [socket?.id, mic.isReady])

  // ── Effect: zone detection interval ───────────────────────────────────────

  useEffect(() => {
    if (!socket?.id || !mic.isReady) return
    const identity = userId
    console.log('[voice] zone detector started | identity:', identity)

    const id = setInterval(() => {
      const { x, y } = localPositionRef.current
      const detected = getZoneKey(x, y, zones)

      // Zone speaking detection (runs regardless of debounce/transition state)
      if (modeRef.current === 'zone' && zoneRoomRef.current) {
        const nextSpeaking = new Set<string>()
        for (const peer of zoneEntries.current.keys()) {
          if (zoneRoomRef.current.remoteParticipants.get(peer)?.isSpeaking) nextSpeaking.add(peer)
        }
        setSpeakingPeers(nextSpeaking)
      }

      // Debounce zone boundary detection (entry/exit only from actual zone state).
      if (detected !== pendingZoneRef.current) {
        if (detected !== activeZoneKeyRef.current) {
          console.log('[voice] zone boundary crossed | detected:', detected, '| pos:', x.toFixed(1), y.toFixed(1))
        }
        pendingZoneRef.current = detected
        debounceTicksRef.current = 0
        return
      }
      debounceTicksRef.current++
      if (debounceTicksRef.current < ZONE_DEBOUNCE_TICKS) return
      if (detected === activeZoneKeyRef.current) return
      if (detected === targetZoneRef.current) return
      if (detected) {
        const cooldownMs = getZoneTokenCooldownMs(detected)
        if (cooldownMs > 0) {
          // Keep the user in proximity mode while token endpoint is cooling down.
          return
        }
      }

      console.log('[voice] zone debounce settled | triggering transition → zone:', detected,
        '| targetZone:', targetZoneRef.current, '→', detected)
      targetZoneRef.current = detected
      void transitionToZone(identity, detected)
    }, 100)

    return () => {
      console.log('[voice] zone detector cleanup | activeZone:', activeZoneKeyRef.current, '| targetZone:', targetZoneRef.current)
      clearInterval(id)
      generationRef.current++
      const room = zoneRoomRef.current
      zoneRoomRef.current = null
      const localTrack = zoneLocalTrackRef.current
      zoneLocalTrackRef.current = null
      const clone = zonePublishedCloneRef.current
      zonePublishedCloneRef.current = null
      if (clone) { mic.removePublishedClone(clone); clone.stop() }
      cleanupAllZone()
      void (async () => {
        try {
          if (room && localTrack) await safeUnpublishUserMicTrack(room, localTrack)
          else if (localTrack) await localTrack.stopProcessor().catch(() => {})
          if (room) await room.disconnect(false).catch(() => {})
        } catch { /* ignore */ }
      })()
      setConnectedPeers(new Set(subscribedIds.current))
      syncZoneKey(null)
      syncMode('proximity')
      targetZoneRef.current  = undefined
      pendingZoneRef.current = undefined
      debounceTicksRef.current = 0
    }
  }, [socket?.id, mic.isReady])

  // ── Effect: proximity gating interval ─────────────────────────────────────

  useEffect(() => {
    if (!proximityRoomReady) return
    const room = proximityRoomRef.current
    if (!room) return

    const id = setInterval(() => {
      const local  = localPositionRef.current
      const remote = remotePlayersRef.current
      const ctx    = mic.audioCtxRef.current

      // Unsubscribe out-of-range or zoned peers
      for (const identity of subscribedIds.current) {
        const player = remote.get(identity)
        const distanceToLocal = player ? dist2(local, playerPos(player)) : Infinity
        if (!player || distanceToLocal > DISCONNECT_RANGE || player.zoneKey !== null || activeZoneKeyRef.current !== null) {
          const participant = room.remoteParticipants.get(identity)
          if (participant) {
            for (const pub of participant.trackPublications.values()) {
              if (pub.kind === Track.Kind.Audio && pub.isSubscribed)
                (pub as RemoteTrackPublication).setSubscribed(false)
            }
          }
          subscribedIds.current.delete(identity)
        }
      }

      // In zone — proximity connections suppressed; zone interval handles speaking
      if (activeZoneKeyRef.current !== null) {
        setSpeakingPeers(new Set())
        return
      }

      const candidates = [...remote.entries()]
        .filter(([, remotePlayer]) => remotePlayer.zoneKey === null)
        .map(([id, remotePlayer]) => ({ id, player: remotePlayer, dist: dist2(local, playerPos(remotePlayer)) }))
        .filter(candidate => candidate.dist < DISCONNECT_RANGE)
        .sort((leftCandidate, rightCandidate) => leftCandidate.dist - rightCandidate.dist)
      const preferred = new Set(candidates.slice(0, MAX_ACTIVE_PEERS).map(candidate => candidate.id))

      const nextSpeaking = new Set<string>()

      remote.forEach((player, id) => {
        if (player.zoneKey !== null) return
        const distanceToLocal = dist2(local, playerPos(player))
        const subscribed = subscribedIds.current.has(id)

        if (distanceToLocal < CONNECT_RANGE && preferred.has(id) && !subscribed) {
          const participant = room.remoteParticipants.get(id)
          if (participant) {
            for (const pub of participant.trackPublications.values()) {
              if (pub.kind !== Track.Kind.Audio) continue
              if (!pub.isSubscribed) {
                (pub as RemoteTrackPublication).setSubscribed(true)
                subscribedIds.current.add(id)
              } else if (!proximityEntries.current.has(id)) {
                // Stale subscription from zone transition — force a clean reset
                console.log('[voice] stale subscription for', id, '— forcing reset')
                ;(pub as RemoteTrackPublication).setSubscribed(false)
              } else {
                subscribedIds.current.add(id)
              }
            }
          }
        } else if (subscribed) {
          const entry = proximityEntries.current.get(id)
          if (!entry || !ctx) return
          const normalised   = Math.min(1, Math.max(0, distanceToLocal / DISCONNECT_RANGE))
          const distFactor   = 1 - normalised ** rolloffRef.current
          const target = Math.min(
            MAX_LINEAR_PLAYBACK,
            Math.max(0, distFactor * remoteGainRef.current * playbackBoostRef.current),
          )
          entry.track.setVolume(target)
          if (entry.participant.isSpeaking) nextSpeaking.add(id)
        }
      })

      setSpeakingPeers(nextSpeaking)
      setConnectedPeers(new Set(subscribedIds.current))

      const hasPeers      = proximityEntries.current.size > 0
      const livekitBlock  = hasPeers && !room.canPlaybackAudio
      setAudioInterrupted((mic.audioCtxRef.current?.state === 'interrupted') && hasPeers)
      setAudioBlocked((mic.audioCtxRef.current?.state === 'suspended' || livekitBlock) && hasPeers)
    }, 100)

    return () => clearInterval(id)
  }, [proximityRoomReady, playbackBoost])

  // ── Effect: AudioContext state monitoring ──────────────────────────────────

  useEffect(() => {
    const ctx = mic.audioCtxRef.current
    if (!ctx) return
    const handler = () => {
      const hasPeers = proximityEntries.current.size > 0
      setAudioInterrupted(ctx.state === 'interrupted' && hasPeers)
      setAudioBlocked(ctx.state === 'suspended' && hasPeers)
    }
    ctx.addEventListener('statechange', handler)
    return () => ctx.removeEventListener('statechange', handler)
  }, [mic.isReady])

  // ── Effect: sync zone entry volumes when gain changes ─────────────────────

  useEffect(() => {
    const linear = Math.min(
      MAX_LINEAR_PLAYBACK,
      Math.max(0, remoteGain * playbackBoost),
    )
    for (const entry of zoneEntries.current.values()) {
      entry.track.setVolume(linear)
    }
  }, [remoteGain, playbackBoost])

  // ── Remote gain setter ─────────────────────────────────────────────────────

  /** Persist and apply remote gain slider changes. */
  function setRemoteGain(value: number) {
    const next = Math.min(1, Math.max(0, value))
    setRemoteGainState(next)
    try { localStorage.setItem(GAIN_STORAGE_KEY, String(next)) } catch { /* ignore */ }
  }

  /** Persist and apply playback boost slider changes. */
  function setPlaybackBoost(value: number) {
    const next = Math.min(MAX_PLAYBACK_BOOST, Math.max(MIN_PLAYBACK_BOOST, value))
    setPlaybackBoostState(next)
    try { localStorage.setItem(PLAYBACK_BOOST_STORAGE_KEY, String(next)) } catch { /* ignore */ }
  }

  // ── Return unified VoiceState ──────────────────────────────────────────────

  return {
    muted:              mic.isMuted,
    toggleMute:         mic.toggleMute,
    isLocalSpeaking:    mic.isLocalSpeaking,
    headphonePrompt:    mic.headphonePrompt,
    confirmHeadphones:  mic.confirmHeadphones,
    speakingPeers,
    connectedPeers,
    peerConnectionStates,
    remoteGain,
    setRemoteGain,
    playbackBoost,
    setPlaybackBoost,
    audioBlocked,
    audioInterrupted,
    mode,
    activeZoneKey,
    proximityRoomReady,
  }
}
