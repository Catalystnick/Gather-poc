// Unified voice hook — manages both the permanent proximity room (gather-world)
// and transient zone rooms (gather-world-zone-{key}).
//
// Replaces useLiveKitVoice + useZoneVoice. Returns a complete VoiceState so
// World.tsx no longer needs to manually merge state from two separate hooks.
//
// Proximity room: always connected when mic is ready. Distance-gated subscriptions.
// Zone room: created/destroyed as the player enters/leaves zone boundaries.
//
// Both rooms publish from the same raw hardware mic track. Krisp then mic gain
// (per-room processor — see KrispWithMicGainProcessor).

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
import { getZoneKey, getPrefetchZoneKey } from '../utils/zoneDetection'
import {
  ROOM_NAME, ZONE_ROOM_PREFIX,
  type CachedToken, type TokenIntent,
  createRoom, fetchToken, fetchTokenDetailed, tokenIsValid, attachRemoteAudio, createKrispLocalTrack, AUDIO_PUBLISH_OPTS,
} from '../utils/voiceRoom'

// ─── Constants ────────────────────────────────────────────────────────────────

const CONNECT_RANGE       = 7
const DISCONNECT_RANGE    = 9
const MIN_GAIN_FLOOR      = 0.15
const MAX_ACTIVE_PEERS    = 8
const DEFAULT_ROLLOFF     = 1.4
const ZONE_DEBOUNCE_TICKS = 2

const GAIN_STORAGE_KEY    = 'gather_poc_remote_gain'
const ROLLOFF_STORAGE_KEY = 'gather_poc_rolloff'
const KRISP_ENABLED_STORAGE_KEY = 'gather_poc_krisp_enabled'

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

function loadRemoteGain(): number {
  try {
    const raw = localStorage.getItem(GAIN_STORAGE_KEY)
    if (raw === null) return 1
    const v = Number(raw)
    if (Number.isNaN(v)) return 1
    return Math.min(1, Math.max(0, v))
  } catch { return 1 }
}

function loadRolloff(): number {
  try {
    const v = Number(localStorage.getItem(ROLLOFF_STORAGE_KEY))
    return Number.isNaN(v) ? DEFAULT_ROLLOFF : Math.max(0.1, v)
  } catch { return DEFAULT_ROLLOFF }
}

function loadKrispEnabled(): boolean {
  try {
    const raw = localStorage.getItem(KRISP_ENABLED_STORAGE_KEY)
    if (raw === null) return true
    return raw !== '0'
  } catch { return true }
}

function dist3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVoice(
  socket: Socket | null,
  localPositionRef: React.MutableRefObject<{ x: number; y: number; z: number }>,
  remotePlayers: Map<string, RemotePlayer>,
  mic: MicTrack,
  accessToken: string,
  userId: string,
): VoiceState {

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
  const [krispEnabled,        setKrispEnabled]        = useState(loadKrispEnabled)

  // ── Room refs ──────────────────────────────────────────────────────────────
  const proximityRoomRef         = useRef<Room | null>(null)
  const zoneRoomRef              = useRef<Room | null>(null)
  const proximityPublishedCloneRef = useRef<MediaStreamTrack | null>(null)
  const zonePublishedCloneRef    = useRef<MediaStreamTrack | null>(null)
  // LocalAudioTrack wrappers — hold the Krisp processor; stopped on cleanup.
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
  const krispAppliedRef   = useRef<{ proximity: boolean; zone: boolean }>({ proximity: false, zone: false })
  const proximityPostGainRef = useRef<GainNode | null>(null)
  const zonePostGainRef      = useRef<GainNode | null>(null)

  // ── Stable value refs ──────────────────────────────────────────────────────
  const remoteGainRef    = useRef(remoteGain)
  remoteGainRef.current  = remoteGain
  const rolloffRef       = useRef(rolloff)
  rolloffRef.current     = rolloff
  const accessTokenRef   = useRef(accessToken)
  accessTokenRef.current = accessToken
  const remotePlayersRef = useRef(remotePlayers)
  remotePlayersRef.current = remotePlayers
  const krispEnabledRef = useRef(krispEnabled)
  krispEnabledRef.current = krispEnabled

  // Publish path: mic gain after Krisp (separate GainNode per room).
  useEffect(() => {
    const ctx = mic.audioCtxRef.current
    if (!ctx) return
    const t = ctx.currentTime
    const g = Math.max(0, mic.micGain)
    const a = proximityPostGainRef.current
    const b = zonePostGainRef.current
    if (a) a.gain.setTargetAtTime(g, t, 0.03)
    if (b) b.gain.setTargetAtTime(g, t, 0.03)
  }, [mic.micGain])

  // ── Sync helpers ───────────────────────────────────────────────────────────

  function syncMode(m: VoiceMode) {
    console.log('[voice] mode:', modeRef.current, '→', m)
    modeRef.current = m; setMode(m)
  }

  function syncZoneKey(k: string | null) {
    console.log('[voice] activeZoneKey:', activeZoneKeyRef.current, '→', k)
    activeZoneKeyRef.current = k; setActiveZoneKey(k)
  }

  function setPeerState(identity: string, state: string | null) {
    setPeerConnectionStates(prev => {
      const next = { ...prev }
      if (state === null) delete next[identity]
      else next[identity] = state
      return next
    })
  }

  function safeUnpublishLocalTrack(room: Room, track: LocalAudioTrack) {
    const pubs = [...room.localParticipant.trackPublications.values()]
    const pub = pubs.find(p => p.track === track || (track.sid && p.trackSid === track.sid))
    if (!pub) return
    try {
      room.localParticipant.unpublishTrack(track)
    } catch {
      /* ignore */
    }
  }

  // ── Proximity entry cleanup ────────────────────────────────────────────────

  function cleanupProximityEntry(identity: string) {
    const e = proximityEntries.current.get(identity)
    if (!e) return
    e.gainNode?.disconnect()
    e.track.detach().forEach(el => el.remove())
    e.audio.remove()
    proximityEntries.current.delete(identity)
    subscribedIds.current.delete(identity)
  }

  function cleanupAllProximity() {
    ;[...proximityEntries.current.keys()].forEach(cleanupProximityEntry)
  }

  // ── Zone entry cleanup ─────────────────────────────────────────────────────

  function cleanupZoneEntry(identity: string) {
    const e = zoneEntries.current.get(identity)
    if (!e) return
    e.track.detach().forEach(el => el.remove())
    e.audio.remove()
    zoneEntries.current.delete(identity)
  }

  function cleanupAllZone() {
    ;[...zoneEntries.current.keys()].forEach(cleanupZoneEntry)
  }

  // ── Token cache helpers ────────────────────────────────────────────────────

  function getCachedToken(zoneKey: string, intent: TokenIntent): CachedToken | null {
    const c = tokenCacheRef.current[zoneKey]
    if (!c || c.intent !== intent || !tokenIsValid(c)) {
      if (c) delete tokenCacheRef.current[zoneKey]
      return null
    }
    return c
  }

  function getZoneTokenCooldownMs(zoneKey: string): number {
    const blockedUntil = zoneTokenBlockedUntilRef.current[zoneKey] ?? 0
    return Math.max(0, blockedUntil - Date.now())
  }

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

  async function transitionToZone(identity: string, targetKey: string | null) {
    const myGen = ++generationRef.current
    const cancelled = () => generationRef.current !== myGen
    console.log('[voice] zone transition | from:', activeZoneKeyRef.current, '→', targetKey, '| gen:', myGen)
    if (targetKey) {
      console.log('[voice][krisp][zone-enter] begin | zone:', targetKey, '| enabled:', krispEnabledRef.current)
    }
    syncMode('switching')

    // Capture old room state before clearing refs, then fire-and-forget cleanup
    // so the new room can start connecting immediately in parallel.
    const oldRoom = zoneRoomRef.current
    const oldLocalTrack = zoneLocalTrackRef.current
    const oldClone = zonePublishedCloneRef.current
    zoneRoomRef.current = null
    zoneLocalTrackRef.current = null
    zonePublishedCloneRef.current = null

    if (oldRoom) {
      console.log('[voice] disconnecting old zone room (async) | gen:', myGen)
      void (async () => {
        try {
          if (oldLocalTrack) {
            safeUnpublishLocalTrack(oldRoom, oldLocalTrack)
          }
          if (oldClone) mic.removePublishedClone(oldClone)
        } catch { /* ignore */ }
        await oldRoom.disconnect().catch(() => {})
      })()
    }

    // Immediately silence old zone audio — doesn't block new connection.
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
    const room = createRoom()

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return
      console.log('[voice] zone track subscribed | peer:', participant.identity)
      cleanupZoneEntry(participant.identity)
      const audioTrack = track as RemoteAudioTrack
      const audio = attachRemoteAudio(audioTrack, remoteGainRef.current)
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
      await room.disconnect().catch(() => {})
      return
    }
    console.log('[voice] zone connected | zone:', targetKey, '| participants:', room.remoteParticipants.size)

    zoneRoomRef.current = room

    // Always create a dedicated zone LocalAudioTrack from a raw clone and apply Krisp
    // before publish. LocalAudioTrack.mediaStreamTrack may still point to the source
    // input handle even when a processor is active, so cloning it is not a reliable
    // way to inherit processed output.
    const rawTrack = mic.rawMicStreamRef.current?.getAudioTracks()[0]
    if (rawTrack) {
      console.log('[voice][zone] path=raw-plus-krisp | zone:', targetKey, '| source id:', rawTrack.id, '| state:', rawTrack.readyState)
      zonePublishedCloneRef.current = rawTrack
      const { localTrack, krispApplied } = await createKrispLocalTrack(
        rawTrack,
        'zone',
        mic.audioCtxRef.current ?? undefined,
        krispEnabledRef.current,
        mic.micGainRef,
        zonePostGainRef,
      )
      krispAppliedRef.current.zone = krispApplied
      console.log('[voice][krisp] zone applied:', krispApplied)
      console.log('[voice][krisp][zone-enter] publish-ready | zone:', targetKey, '| enabled:', krispEnabledRef.current, '| applied:', krispApplied, '| trackId:', rawTrack.id)
      if (krispEnabledRef.current && !krispApplied) {
        console.warn('[voice][zone] Krisp unavailable/failed; publishing without Krisp so zone audio stays connected')
      }
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
      await room.disconnect().catch(() => {})
      zoneRoomRef.current = null
      const localTrack = zoneLocalTrackRef.current
      zoneLocalTrackRef.current = null
      void localTrack
      const clone = zonePublishedCloneRef.current
      zonePublishedCloneRef.current = null
      if (clone) mic.removePublishedClone(clone)
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

    async function connect() {
      try {
        const token = await fetchToken(identity, ROOM_NAME, accessTokenRef.current)
        if (!token) throw new Error('proximity token fetch failed')

        room = createRoom()

        room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
          if (track.kind !== Track.Kind.Audio) return
          if (!mic.audioCtxRef.current) return
          cleanupProximityEntry(participant.identity)
          subscribedIds.current.add(participant.identity)
          const audioTrack = track as RemoteAudioTrack
          const audio = attachRemoteAudio(audioTrack, MIN_GAIN_FLOOR)
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
          if (dist3(localPositionRef.current, player.position) < CONNECT_RANGE) {
            publication.setSubscribed(true)
            subscribedIds.current.add(participant.identity)
          }
        })

        await room.connect(token.url, token.token, { autoSubscribe: false })
        proximityRoomRef.current = room

        const ctx = mic.audioCtxRef.current
        if (ctx?.state === 'running') void room.startAudio().catch(() => {})
        else if (ctx?.state === 'suspended') setAudioBlocked(true)
        setProximityRoomReady(true)

        // Clone the raw mic track and apply Krisp before publishing.
        const rawTrack = mic.rawMicStreamRef.current?.getAudioTracks()[0]
        if (rawTrack) {
          console.log('[voice][krisp][join] begin | room: proximity | enabled:', krispEnabledRef.current, '| trackId:', rawTrack.id)
          console.log('[voice][proximity] source raw | id:', rawTrack.id, '| state:', rawTrack.readyState, '| enabled:', rawTrack.enabled)
          mic.addPublishedClone(rawTrack)
          proximityPublishedCloneRef.current = rawTrack
          const { localTrack, krispApplied } = await createKrispLocalTrack(
            rawTrack,
            'proximity',
            mic.audioCtxRef.current ?? undefined,
            krispEnabledRef.current,
            mic.micGainRef,
            proximityPostGainRef,
          )
          krispAppliedRef.current.proximity = krispApplied
          console.log('[voice][krisp] proximity applied:', krispApplied)
          console.log('[voice][krisp][join] publish-ready | room: proximity | enabled:', krispEnabledRef.current, '| applied:', krispApplied, '| trackId:', rawTrack.id)
          proximityLocalTrackRef.current = localTrack
          console.log('[voice][proximity] localTrack ready | sid?:', localTrack.sid ?? 'n/a', '| mediaStreamTrack id:', localTrack.mediaStreamTrack.id)
          await room.localParticipant.publishTrack(localTrack, AUDIO_PUBLISH_OPTS)
            .catch(err => console.warn('[voice] proximity publish failed:', err))
          console.log('[voice][proximity] publish attempted | mediaStreamTrack id:', localTrack.mediaStreamTrack.id)
        }

        // Subscribe to existing in-range participants
        for (const participant of room.remoteParticipants.values()) {
          const player = remotePlayersRef.current.get(participant.identity)
          if (!player || player.zoneKey !== null || activeZoneKeyRef.current !== null) continue
          if (dist3(localPositionRef.current, player.position) < DISCONNECT_RANGE) {
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
      setProximityRoomReady(false)
      const localTrack = proximityLocalTrackRef.current
      proximityLocalTrackRef.current = null
      void localTrack
      const clone = proximityPublishedCloneRef.current
      proximityPublishedCloneRef.current = null
      if (clone) mic.removePublishedClone(clone)
      if (room) { room.disconnect(); proximityRoomRef.current = null }
      cleanupAllProximity()
      subscribedIds.current.clear()
    }
  }, [socket?.id, mic.isReady])

  // ── Effect: zone detection interval ───────────────────────────────────────

  useEffect(() => {
    if (!socket?.id || !mic.isReady) return
    const identity = userId
    console.log('[voice] zone detector started | identity:', identity)

    const id = setInterval(() => {
      const { x, z } = localPositionRef.current
      const detected = getZoneKey(x, z)
      const prefetchKey = getPrefetchZoneKey(x, z)

      // Prefetch is for approach only. Never prefetch while already inside
      // a zone (detected !== null) or while in an active transition.
      if (detected === null && modeRef.current === 'proximity' && targetZoneRef.current === undefined) {
        if (prefetchKey && !getCachedToken(prefetchKey, 'prefetch') && !tokenInFlightRef.current.has(prefetchKey)) {
          console.log('[voice] prefetch triggered | zone:', prefetchKey)
          void fetchZoneToken(identity, prefetchKey, 'prefetch')
        }
      }

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
          console.log('[voice] zone boundary crossed | detected:', detected, '| pos:', x.toFixed(1), z.toFixed(1))
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
      // Best-effort: unpublish + stop before disconnecting.
      try {
        const localTrack = zoneLocalTrackRef.current
        zoneLocalTrackRef.current = null
        if (room && localTrack) {
          safeUnpublishLocalTrack(room, localTrack)
        }
        const clone = zonePublishedCloneRef.current
        zonePublishedCloneRef.current = null
        if (clone) mic.removePublishedClone(clone)
      } catch { /* ignore */ }
      cleanupAllZone()
      room?.disconnect()
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
        const d = player ? dist3(local, player.position) : Infinity
        if (!player || d > DISCONNECT_RANGE || player.zoneKey !== null || activeZoneKeyRef.current !== null) {
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
        .filter(([, p]) => p.zoneKey === null)
        .map(([id, p]) => ({ id, player: p, dist: dist3(local, p.position) }))
        .filter(e => e.dist < DISCONNECT_RANGE)
        .sort((a, b) => a.dist - b.dist)
      const preferred = new Set(candidates.slice(0, MAX_ACTIVE_PEERS).map(e => e.id))

      const nextSpeaking = new Set<string>()

      remote.forEach((player, id) => {
        if (player.zoneKey !== null) return
        const d = dist3(local, player.position)
        const subscribed = subscribedIds.current.has(id)

        if (d < CONNECT_RANGE && preferred.has(id) && !subscribed) {
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
          const normalised   = Math.min(1, Math.max(0, d / DISCONNECT_RANGE))
          const distFactor   = 1 - normalised ** rolloffRef.current
          const target       = distFactor * remoteGainRef.current
          if (entry.gainNode) entry.gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.05)
          else entry.audio.volume = Math.min(1, target)
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
  }, [proximityRoomReady])

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
    const gain = Math.min(1, Math.max(0, remoteGain))
    for (const entry of zoneEntries.current.values()) {
      entry.audio.volume = gain
      entry.track.setVolume(gain)
    }
  }, [remoteGain])

  // ── Remote gain setter ─────────────────────────────────────────────────────

  function setRemoteGain(value: number) {
    const next = Math.min(1, Math.max(0, value))
    setRemoteGainState(next)
    try { localStorage.setItem(GAIN_STORAGE_KEY, String(next)) } catch { /* ignore */ }
  }

  function toggleKrispEnabled() {
    setKrispEnabled(prev => {
      const next = !prev
      try { localStorage.setItem(KRISP_ENABLED_STORAGE_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  useEffect(() => {
    const sourceTrack = mic.rawMicStreamRef.current?.getAudioTracks()[0]
    if (!sourceTrack) return
    const publishSource: MediaStreamTrack = sourceTrack

    async function republishForRoom(
      room: Room | null,
      cloneRef: React.MutableRefObject<MediaStreamTrack | null>,
      localRef: React.MutableRefObject<LocalAudioTrack | null>,
      label: 'proximity' | 'zone',
      strictWhenEnabled: boolean,
    ) {
      if (!room) return
      const oldLocal = localRef.current
      const oldClone = cloneRef.current
      localRef.current = null
      cloneRef.current = null
      if (oldLocal) {
        safeUnpublishLocalTrack(room, oldLocal)
      }
      if (oldClone) {
        mic.removePublishedClone(oldClone)
      }

      const source = publishSource
      mic.addPublishedClone(source)
      cloneRef.current = source
      const postGainSlot = label === 'proximity' ? proximityPostGainRef : zonePostGainRef
      const { localTrack, krispApplied } = await createKrispLocalTrack(
        source,
        `${label}-republish`,
        mic.audioCtxRef.current ?? undefined,
        krispEnabled,
        mic.micGainRef,
        postGainSlot,
      )
      if (label === 'proximity') krispAppliedRef.current.proximity = krispApplied
      else krispAppliedRef.current.zone = krispApplied
      console.log(`[voice][krisp] ${label} applied after toggle:`, krispApplied, '| enabled:', krispEnabled)
      if (strictWhenEnabled && krispEnabled && !krispApplied) {
        mic.removePublishedClone(source)
        cloneRef.current = null
        return
      }
      localRef.current = localTrack
      await room.localParticipant.publishTrack(localTrack, AUDIO_PUBLISH_OPTS).catch(() => {})
    }

    void republishForRoom(proximityRoomRef.current, proximityPublishedCloneRef, proximityLocalTrackRef, 'proximity', false)
    void republishForRoom(zoneRoomRef.current, zonePublishedCloneRef, zoneLocalTrackRef, 'zone', true)
  }, [krispEnabled, mic.isReady])

  // ── Return unified VoiceState ──────────────────────────────────────────────

  return {
    muted:              mic.isMuted,
    toggleMute:         mic.toggleMute,
    micGain:            mic.micGain,
    setMicGain:         mic.setMicGain,
    isLocalSpeaking:    mic.isLocalSpeaking,
    headphonePrompt:    mic.headphonePrompt,
    confirmHeadphones:  mic.confirmHeadphones,
    speakingPeers,
    connectedPeers,
    peerConnectionStates,
    remoteGain,
    setRemoteGain,
    krispEnabled,
    toggleKrispEnabled,
    audioBlocked,
    audioInterrupted,
    mode,
    activeZoneKey,
    proximityRoomReady,
  }
}
