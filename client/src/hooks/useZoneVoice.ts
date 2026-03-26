// Zone voice — manages the zone LiveKit room lifecycle.
// Called from World.tsx alongside useLiveKitVoice (proximity).
//
// One LiveKit room per zone: gather-world-zone-{key}.
// All participants in the zone room subscribe to each other — no distance gating.
// Token pre-fetching via ZONE_PREFETCH_TRIGGERS to avoid audio gap on entry.

import { useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { MicTrack } from './useMicTrack'
import {
  Room, RoomEvent, Track, AudioPresets, LocalAudioTrack,
  type RemoteAudioTrack,
} from 'livekit-client'
import { isKrispNoiseFilterSupported } from '@livekit/krisp-noise-filter'
import { GainKrispProcessor } from '../utils/GainKrispProcessor'
import { getZoneKey, getPrefetchZoneKey } from '../utils/zoneDetection'

// ─── Constants ────────────────────────────────────────────────────────────────

const TOKEN_TTL_MS        = 55_000  // tokens valid ~60s; re-fetch at 55s
const ZONE_DEBOUNCE_TICKS = 2       // 2 × 100ms = 200ms stable dwell before switching
const ROOM_PREFIX         = 'gather-world-zone-'

function getTokenUrl(): string {
  const base = (import.meta.env as { VITE_SERVER_URL?: string }).VITE_SERVER_URL || ''
  return `${base || window.location.origin}/livekit/token`
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type VoiceMode = 'proximity' | 'zone' | 'switching'

export interface ZoneVoiceState {
  activeZoneKey: string | null
  connectedPeers: Set<string>
  speakingPeers: Set<string>
  mode: VoiceMode
}

// ─── Internal ─────────────────────────────────────────────────────────────────

interface CachedToken { token: string; url: string; fetchedAt: number }
interface RemoteEntry  { track: RemoteAudioTrack; audio: HTMLAudioElement }

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useZoneVoice(
  socket: Socket | null,
  localPositionRef: React.MutableRefObject<{ x: number; y: number; z: number }>,
  mic: MicTrack,
  accessToken: string,
  userId: string,
): ZoneVoiceState {
  const [activeZoneKey, setActiveZoneKey] = useState<string | null>(null)
  const [connectedPeers, setConnectedPeers] = useState<Set<string>>(new Set())
  const [speakingPeers,  setSpeakingPeers]  = useState<Set<string>>(new Set())
  const [mode,           setMode]           = useState<VoiceMode>('proximity')

  // Stable refs — read inside async callbacks without stale closure risk
  const activeZoneKeyRef = useRef<string | null>(null)
  const modeRef          = useRef<VoiceMode>('proximity')
  const zoneRoomRef      = useRef<Room | null>(null)
  const tokenCacheRef    = useRef<Record<string, CachedToken>>({})
  const remoteEntries    = useRef<Map<string, RemoteEntry>>(new Map())
  // Generation counter — incremented on each transition; each step checks its own gen.
  const generationRef    = useRef(0)
  const accessTokenRef   = useRef(accessToken)
  accessTokenRef.current = accessToken

  // Debounce — zone key must stay stable for ZONE_DEBOUNCE_TICKS before we switch
  const pendingZoneRef   = useRef<string | null | undefined>(undefined)
  const debounceTicksRef = useRef(0)
  // Target guard — prevents re-firing transitionToZone every tick while async work is in progress.
  // Set to the target zone when a transition is dispatched; cleared on failure so retry is allowed.
  const targetZoneRef    = useRef<string | null | undefined>(undefined)

  // ── Helpers — stable across renders ──────────────────────────────────────

  function syncMode(m: VoiceMode) {
    console.log('[zone voice] mode:', modeRef.current, '→', m)
    modeRef.current = m; setMode(m)
  }
  function syncZoneKey(k: string | null) {
    console.log('[zone voice] activeZoneKey:', activeZoneKeyRef.current, '→', k)
    activeZoneKeyRef.current = k; setActiveZoneKey(k)
  }

  function cleanupEntry(identity: string) {
    const e = remoteEntries.current.get(identity)
    if (!e) return
    e.track.detach().forEach(el => el.remove())
    e.audio.remove()
    remoteEntries.current.delete(identity)
  }

  function cleanupAll() {
    ;[...remoteEntries.current.keys()].forEach(cleanupEntry)
  }

  function getCachedToken(zoneKey: string): CachedToken | null {
    const c = tokenCacheRef.current[zoneKey]
    if (!c) return null
    if (Date.now() - c.fetchedAt > TOKEN_TTL_MS) {
      delete tokenCacheRef.current[zoneKey]
      return null
    }
    return c
  }

  async function fetchToken(identity: string, zoneKey: string): Promise<CachedToken | null> {
    const roomName = `${ROOM_PREFIX}${zoneKey}`
    console.log('[zone voice] fetching token | zone:', zoneKey, '| room:', roomName)
    try {
      const res = await fetch(getTokenUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessTokenRef.current}`,
        },
        body: JSON.stringify({ roomName, identity, name: identity }),
      })
      if (!res.ok) {
        console.warn('[zone voice] token fetch HTTP error | zone:', zoneKey, '| status:', res.status)
        return null
      }
      const { token, url } = (await res.json()) as { token?: string; url?: string }
      if (!token || !url) {
        console.warn('[zone voice] token response missing fields | zone:', zoneKey)
        return null
      }
      const cached: CachedToken = { token, url, fetchedAt: Date.now() }
      tokenCacheRef.current[zoneKey] = cached
      console.log('[zone voice] token cached | zone:', zoneKey, '| url:', url)
      return cached
    } catch (err) {
      console.warn('[zone voice] token fetch threw | zone:', zoneKey, '| err:', err)
      return null
    }
  }

  // ── Zone room transition ──────────────────────────────────────────────────

  async function transitionToZone(identity: string, targetKey: string | null) {
    const myGen = ++generationRef.current
    const cancelled = () => generationRef.current !== myGen

    console.log('[zone voice] transition start | from:', activeZoneKeyRef.current, '→ to:', targetKey, '| gen:', myGen)
    syncMode('switching')

    // Leave the current zone room (if any)
    const oldRoom = zoneRoomRef.current
    if (oldRoom) {
      console.log('[zone voice] disconnecting old room | gen:', myGen)
      zoneRoomRef.current = null
      cleanupAll()
      setConnectedPeers(new Set())
      setSpeakingPeers(new Set())
      // The zone room holds a clone of the mic track (see publishTrack below),
      // so disconnect() stopping the clone is safe — the original track shared
      // with the proximity room is unaffected. No unpublishTrack needed.
      await oldRoom.disconnect().catch(() => {})
    }
    if (cancelled()) { console.log('[zone voice] cancelled after old room disconnect | gen:', myGen); return }

    // Leaving all zones → return to proximity
    if (targetKey === null) {
      console.log('[zone voice] returned to proximity | gen:', myGen)
      targetZoneRef.current = null
      syncZoneKey(null)
      syncMode('proximity')
      return
    }

    // Resolve token (cached first, then live fetch)
    let cached = getCachedToken(targetKey)
    if (cached) {
      console.log('[zone voice] using cached token | zone:', targetKey, '| age:', Math.round((Date.now() - cached.fetchedAt) / 1000), 's')
    } else {
      console.log('[zone voice] no cached token, fetching | zone:', targetKey)
      cached = await fetchToken(identity, targetKey)
    }
    if (cancelled()) { console.log('[zone voice] cancelled after token fetch | gen:', myGen); return }
    if (!cached) {
      console.warn('[zone voice] token fetch failed for zone:', targetKey, '— staying in proximity')
      console.log('[zone voice] token fetch failed — resetting zone state to proximity fallback')
      targetZoneRef.current = undefined
      syncZoneKey(null)
      syncMode('proximity')
      return
    }

    // Build zone room
    const room = new Room({
      adaptiveStream: false, dynacast: false,
      singlePeerConnection: true, webAudioMix: false,
    })
    ;(room as Room & { setMaxListeners?: (n: number) => void }).setMaxListeners?.(32)

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return
      console.log('[zone voice] track subscribed | peer:', participant.identity)
      cleanupEntry(participant.identity)
      const audioTrack = track as RemoteAudioTrack
      const audio = audioTrack.attach()
      audio.autoplay = true
      audio.setAttribute('playsinline', 'true')
      audio.style.display = 'none'
      document.body.appendChild(audio)
      audioTrack.setVolume(1)
      remoteEntries.current.set(participant.identity, { track: audioTrack, audio })
      setConnectedPeers(new Set(remoteEntries.current.keys()))
      void audio.play().catch(err => console.warn('[zone voice] audio.play blocked:', err))
    })

    room.on(RoomEvent.TrackUnsubscribed, (_t, _p, participant) => {
      console.log('[zone voice] track unsubscribed | peer:', participant.identity)
      cleanupEntry(participant.identity)
      setConnectedPeers(new Set(remoteEntries.current.keys()))
    })

    room.on(RoomEvent.ParticipantDisconnected, participant => {
      console.log('[zone voice] participant left | peer:', participant.identity)
      cleanupEntry(participant.identity)
      setConnectedPeers(new Set(remoteEntries.current.keys()))
    })

    room.on(RoomEvent.LocalTrackPublished, async publication => {
      if (
        publication.source !== Track.Source.Microphone ||
        !(publication.track instanceof LocalAudioTrack)
      ) return
      console.log('[Krisp][zone] local mic published — applying NC | track:', publication.track.mediaStreamTrack.label)
      if (!isKrispNoiseFilterSupported()) {
        console.warn('[Krisp][zone] not supported on this browser/device — NC skipped')
        return
      }
      const gainNode = mic.micGainNodeRef.current
      const srcNode  = mic.micSourceNodeRef.current
      if (!gainNode || !srcNode) {
        console.warn('[Krisp][zone] gain/source nodes not ready — NC skipped')
        return
      }
      const processor = new GainKrispProcessor(gainNode, srcNode)
      try {
        await publication.track.setProcessor(
          processor as unknown as Parameters<typeof publication.track.setProcessor>[0],
        )
        console.log('[Krisp][zone] processor set OK')
      } catch (err) {
        console.error('[Krisp][zone] setProcessor failed:', err)
      }
    })

    room.on(RoomEvent.Disconnected, () => {
      if (zoneRoomRef.current !== room) return
      console.log('[zone voice] room disconnected unexpectedly | zone:', targetKey)
      zoneRoomRef.current = null
      cleanupAll()
      setConnectedPeers(new Set())
      setSpeakingPeers(new Set())
      // Reset transition guards so the detector can immediately retry reconnection.
      // Without this, activeZoneKeyRef still shows the old zone and the detector
      // thinks the transition already succeeded — no retry ever fires.
      console.log('[zone voice] unexpected disconnect — resetting guards | targetZone:', targetZoneRef.current, '→ undefined | activeZone:', activeZoneKeyRef.current, '→ null')
      targetZoneRef.current = undefined
      syncZoneKey(null)
      syncMode('proximity')
    })

    // Connect
    console.log('[zone voice] connecting to room | zone:', targetKey, '| url:', cached.url)
    try {
      await room.connect(cached.url, cached.token, { autoSubscribe: true })
    } catch (err) {
      console.warn('[zone voice] connect failed | zone:', targetKey, '| err:', err)
      if (!cancelled()) {
        console.log('[zone voice] connect failed — resetting zone state to proximity fallback')
        targetZoneRef.current = undefined
        syncZoneKey(null)
        syncMode('proximity')
      }
      return
    }
    if (cancelled()) {
      console.log('[zone voice] cancelled after connect | gen:', myGen, '— disconnecting')
      await room.disconnect().catch(() => {})
      return
    }
    console.log('[zone voice] connected | zone:', targetKey, '| participants:', room.remoteParticipants.size)

    zoneRoomRef.current = room

    // Publish a clone of the raw mic track — the clone is independent so LiveKit
    // can stop it on disconnect without affecting the proximity room's original track.
    // This also removes the need for an explicit unpublishTrack before disconnect().
    const rawStream = mic.rawMicStreamRef.current
    const micTrack  = rawStream?.getAudioTracks()[0]
    if (micTrack) {
      console.log('[zone voice] publishing mic clone | zone:', targetKey)
      await room.localParticipant.publishTrack(micTrack.clone(), {
        source: Track.Source.Microphone,
        name: 'mic',
        audioPreset: AudioPresets.musicStereo,
      }).catch(err => console.warn('[zone voice] publish failed:', err))
    } else {
      console.warn('[zone voice] no mic track to publish | zone:', targetKey)
    }
    if (cancelled()) {
      console.log('[zone voice] cancelled after publish | gen:', myGen, '— disconnecting')
      await room.disconnect().catch(() => {})
      zoneRoomRef.current = null
      return
    }

    // Try to unblock audio
    const ctx = mic.audioCtxRef.current
    if (ctx?.state === 'running') void room.startAudio().catch(() => {})

    console.log('[zone voice] transition complete | zone:', targetKey, '| mode: zone | gen:', myGen)
    syncZoneKey(targetKey)
    syncMode('zone')
  }

  // ── Zone detection + token pre-fetch interval ─────────────────────────────

  useEffect(() => {
    if (!socket?.id || !mic.isReady) return
    const identity = userId
    console.log('[zone voice] detector started | identity:', identity)

    const id = setInterval(() => {
      const { x, z } = localPositionRef.current

      // Pre-fetch token for nearby zones to minimize audio gap on entry
      const prefetchKey = getPrefetchZoneKey(x, z)
      if (prefetchKey && !getCachedToken(prefetchKey)) {
        console.log('[zone voice] prefetch triggered | zone:', prefetchKey, '| pos:', x.toFixed(1), z.toFixed(1))
        void fetchToken(identity, prefetchKey)
      }

      // Debounce zone detection: require ZONE_DEBOUNCE_TICKS stable readings before switching
      const detectedZone = getZoneKey(x, z)
      if (detectedZone !== pendingZoneRef.current) {
        if (detectedZone !== activeZoneKeyRef.current) {
          console.log('[zone voice] zone boundary crossed | detected:', detectedZone, '| pos:', x.toFixed(1), z.toFixed(1), '| debouncing...')
        }
        pendingZoneRef.current = detectedZone
        debounceTicksRef.current = 0
        return
      }
      debounceTicksRef.current++
      if (debounceTicksRef.current < ZONE_DEBOUNCE_TICKS) return
      if (detectedZone === activeZoneKeyRef.current) return  // already in this zone
      if (detectedZone === targetZoneRef.current) return     // already transitioning to this zone

      console.log('[zone voice] debounce settled | triggering transition → zone:', detectedZone, '| targetZone:', targetZoneRef.current, '→', detectedZone)
      targetZoneRef.current = detectedZone
      void transitionToZone(identity, detectedZone)
    }, 100)

    return () => {
      console.log('[zone voice] detector stopped | identity:', identity)
      clearInterval(id)
      generationRef.current++  // cancel any in-flight transition
      const room = zoneRoomRef.current
      zoneRoomRef.current = null
      cleanupAll()
      room?.disconnect()
      // Clear transition guards so a fresh effect run starts with a clean slate
      console.log('[zone voice] detector cleanup — clearing guards | activeZone:', activeZoneKeyRef.current, '→ null | targetZone:', targetZoneRef.current, '→ undefined')
      setConnectedPeers(new Set())
      setSpeakingPeers(new Set())
      syncZoneKey(null)
      syncMode('proximity')
      targetZoneRef.current = undefined
      pendingZoneRef.current = undefined
      debounceTicksRef.current = 0
    }
  }, [socket?.id, mic.isReady])

  // ── Speaking detection ────────────────────────────────────────────────────

  useEffect(() => {
    const id = setInterval(() => {
      if (modeRef.current !== 'zone' || !zoneRoomRef.current) return
      const nextSpeaking = new Set<string>()
      for (const identity of remoteEntries.current.keys()) {
        const participant = zoneRoomRef.current.remoteParticipants.get(identity)
        if (participant?.isSpeaking) nextSpeaking.add(identity)
      }
      setSpeakingPeers(nextSpeaking)
    }, 100)
    return () => clearInterval(id)
  }, [])

  return { activeZoneKey, connectedPeers, speakingPeers, mode }
}
