// LiveKit proximity voice — distance-gated subscription within gather-world.
// Mic pipeline is owned by useMicTrack; this hook only manages room lifecycle,
// remote participant subscription, distance gating, and peer speaking detection.
//
// Suppression: when activeZoneKey is non-null OR a remote player has a zoneKey,
// proximity connections are skipped — those players are in a zone room instead.

import { useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { RemotePlayer } from '../types'
import type { MicTrack } from './useMicTrack'
import { Room, RoomEvent, Track, AudioPresets, LocalAudioTrack, type RemoteParticipant, type RemoteTrackPublication, type RemoteAudioTrack } from 'livekit-client'
import { isKrispNoiseFilterSupported } from '@livekit/krisp-noise-filter'
import { GainKrispProcessor } from '../utils/GainKrispProcessor'

// ─── Constants ────────────────────────────────────────────────────────────────

const CONNECT_RANGE    = 7
const DISCONNECT_RANGE = 9
const MIN_GAIN_FLOOR   = 0.15
const MAX_ACTIVE_PEERS = 8
const DEFAULT_ROLLOFF  = 1.4
const GAIN_STORAGE_KEY    = 'gather_poc_remote_gain'
const ROLLOFF_STORAGE_KEY = 'gather_poc_rolloff'
const ROOM_NAME = 'gather-world'

const IS_MOBILE  = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '')
const IS_FIREFOX = /Firefox\//i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '')

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

function resolveIceServersForFirefox(): RTCIceServer[] {
  const env = import.meta.env as Record<string, string | undefined>
  const json = env.VITE_ICE_SERVERS_JSON
  if (json) {
    try {
      const parsed = JSON.parse(json)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as RTCIceServer[]
    } catch { /* fall through */ }
  }
  const turnUrl = env.VITE_TURN_URL, turnUser = env.VITE_TURN_USERNAME, turnCred = env.VITE_TURN_CREDENTIAL
  if (turnUrl && turnUser && turnCred) return [...DEFAULT_ICE_SERVERS, { urls: turnUrl, username: turnUser, credential: turnCred }]
  return DEFAULT_ICE_SERVERS
}

function getTokenUrl(): string {
  const base = (import.meta.env as { VITE_SERVER_URL?: string }).VITE_SERVER_URL || ''
  return `${base || window.location.origin}/livekit/token`
}

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function loadRemoteGain(): number {
  try {
    const v = Number(localStorage.getItem(GAIN_STORAGE_KEY))
    return Number.isNaN(v) ? (IS_MOBILE ? 3.0 : 1) : Math.max(0, v)
  } catch { return IS_MOBILE ? 1.5 : 1 }
}

function loadRolloff(): number {
  try {
    const v = Number(localStorage.getItem(ROLLOFF_STORAGE_KEY))
    return Number.isNaN(v) ? DEFAULT_ROLLOFF : Math.max(0.1, v)
  } catch { return DEFAULT_ROLLOFF }
}

interface RemoteEntry {
  participant: RemoteParticipant
  track: RemoteAudioTrack
  audio: HTMLAudioElement
  gainNode: GainNode | null
  analyser: AnalyserNode | null
  analyserSource: MediaStreamAudioSourceNode | null
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLiveKitVoice(
  socket: Socket | null,
  localPositionRef: React.MutableRefObject<{ x: number; y: number; z: number }>,
  remotePlayers: Map<string, RemotePlayer>,
  mic: MicTrack,
  activeZoneKey: string | null,
  accessToken: string,
  userId: string,
) {
  const [speakingPeers,       setSpeakingPeers]       = useState<Set<string>>(new Set())
  const [connectedPeers,      setConnectedPeers]      = useState<Set<string>>(new Set())
  const [peerConnectionStates, setPeerConnectionStates] = useState<Record<string, string>>({})
  const [remoteGain,          setRemoteGainState]     = useState(loadRemoteGain)
  const [rolloff]                                      = useState(loadRolloff)
  const [audioBlocked,        setAudioBlocked]        = useState(false)
  const [audioInterrupted,    setAudioInterrupted]    = useState(false)
  const [roomReady,           setRoomReady]           = useState(false)

  const roomRef          = useRef<Room | null>(null)
  const remoteEntries    = useRef<Map<string, RemoteEntry>>(new Map())
  const subscribedIds    = useRef<Set<string>>(new Set())
  const remotePlayersRef = useRef(remotePlayers)
  remotePlayersRef.current = remotePlayers
  const remoteGainRef = useRef(remoteGain)
  remoteGainRef.current = remoteGain
  const rolloffRef = useRef(rolloff)
  rolloffRef.current = rolloff
  const activeZoneKeyRef = useRef(activeZoneKey)
  activeZoneKeyRef.current = activeZoneKey
  const accessTokenRef = useRef(accessToken)
  accessTokenRef.current = accessToken
  const socketIdRef = useRef(socket?.id)
  socketIdRef.current = socket?.id

  function setPeerState(identity: string, state: string | null) {
    setPeerConnectionStates(prev => {
      const next = { ...prev }
      if (state === null) delete next[identity]
      else next[identity] = state
      return next
    })
  }

  function cleanupEntry(identity: string) {
    const e = remoteEntries.current.get(identity)
    if (!e) return
    if (e.analyserSource) e.analyserSource.disconnect()
    e.gainNode?.disconnect()
    e.track.detach().forEach(el => el.remove())
    e.audio.remove()
    remoteEntries.current.delete(identity)
  }

  function cleanupAll() {
    ;[...remoteEntries.current.keys()].forEach(cleanupEntry)
  }

  // ── Room connection ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket?.id || !mic.isReady) return

    const identity = userId
    let room: Room | null = null

    async function connect() {
      try {
        const res = await fetch(getTokenUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessTokenRef.current}` },
          body: JSON.stringify({ roomName: ROOM_NAME, identity, name: identity }),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Token ${res.status}`)
        const { token, url } = await res.json()
        if (!token || !url) throw new Error('Invalid token response')

        room = new Room({ adaptiveStream: false, dynacast: false, singlePeerConnection: true, webAudioMix: false })
        ;(room as Room & { setMaxListeners?: (n: number) => void }).setMaxListeners?.(32)

        room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
          if (track.kind !== Track.Kind.Audio) return
          const ctx = mic.audioCtxRef.current
          if (!ctx) return
          cleanupEntry(participant.identity)
          const audioTrack = track as RemoteAudioTrack
          const audio = audioTrack.attach()
          audio.autoplay = true
          audio.setAttribute('playsinline', 'true')
          audio.style.display = 'none'
          document.body.appendChild(audio)
          audioTrack.setVolume(1)

          let gainNode: GainNode | null = null
          if (IS_MOBILE) {
            gainNode = ctx.createGain()
            gainNode.gain.value = MIN_GAIN_FLOOR
            ctx.createMediaElementSource(audio).connect(gainNode).connect(ctx.destination)
          } else {
            audio.volume = MIN_GAIN_FLOOR
          }

          remoteEntries.current.set(participant.identity, { participant, track: audioTrack, audio, gainNode, analyser: null, analyserSource: null })
          setPeerState(participant.identity, 'connected')
          void audio.play().catch(() => setAudioBlocked(true))
        })

        room.on(RoomEvent.TrackUnsubscribed,       (_t, _p, participant) => { cleanupEntry(participant.identity); setPeerState(participant.identity, null) })
        room.on(RoomEvent.ParticipantDisconnected, (participant)         => { cleanupEntry(participant.identity); setPeerState(participant.identity, null) })
        room.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (!room?.canPlaybackAudio) setAudioBlocked(true) })
        room.on(RoomEvent.Disconnected, () => {
          setRoomReady(false); roomRef.current = null; cleanupAll()
          subscribedIds.current.clear(); setConnectedPeers(new Set()); setPeerConnectionStates({})
        })
        room.on(RoomEvent.Reconnecting, () => setRoomReady(false))
        room.on(RoomEvent.Reconnected,  () => setRoomReady(true))

        // Apply Krisp on every publish (also fires on reconnect — NC is never silently lost)
        room.on(RoomEvent.LocalTrackPublished, async (publication) => {
          if (publication.source !== Track.Source.Microphone || !(publication.track instanceof LocalAudioTrack)) return
          console.log('[Krisp][proximity] local mic published — applying NC | track:', publication.track.mediaStreamTrack.label)
          if (!isKrispNoiseFilterSupported()) {
            console.warn('[Krisp][proximity] not supported on this browser/device — NC skipped')
            return
          }
          const gainNode = mic.micGainNodeRef.current
          const srcNode  = mic.micSourceNodeRef.current
          if (!gainNode || !srcNode) {
            console.warn('[Krisp][proximity] gain/source nodes not ready — NC skipped')
            return
          }
          const processor = new GainKrispProcessor(gainNode, srcNode)
          try {
            await publication.track.setProcessor(processor as unknown as Parameters<typeof publication.track.setProcessor>[0])
            console.log('[Krisp][proximity] processor set OK')
          } catch (err) {
            console.error('[Krisp][proximity] setProcessor failed:', err)
          }
        })

        room.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (publication.kind !== Track.Kind.Audio) return
          // Suppress connection if either local or remote player is in a zone
          if (activeZoneKeyRef.current !== null) return
          const player = remotePlayersRef.current.get(participant.identity)
          if (!player || player.zoneKey !== null) return
          const dist = distance(localPositionRef.current, player.position)
          if (dist < CONNECT_RANGE) {
            publication.setSubscribed(true)
            subscribedIds.current.add(participant.identity)
          }
        })

        const connectOpts: { autoSubscribe: boolean; rtcConfig?: RTCConfiguration } = { autoSubscribe: false }
        if (IS_FIREFOX) connectOpts.rtcConfig = { iceServers: resolveIceServersForFirefox() }
        await room.connect(url, token, connectOpts)

        roomRef.current = room
        const ctx = mic.audioCtxRef.current
        if (ctx?.state === 'running') void room.startAudio().catch(() => {})
        else if (ctx?.state === 'suspended') setAudioBlocked(true)
        setRoomReady(true)

        // Publish raw hardware track — Krisp requires a real getUserMedia track
        const rawStream = mic.rawMicStreamRef.current
        const micTrack  = rawStream?.getAudioTracks()[0]
        if (micTrack) {
          await room.localParticipant.publishTrack(micTrack, {
            source: Track.Source.Microphone, name: 'mic', audioPreset: AudioPresets.musicStereo,
          })
        }

        // Subscribe to existing participants in range
        for (const participant of room.remoteParticipants.values()) {
          const player = remotePlayersRef.current.get(participant.identity)
          if (!player || player.zoneKey !== null || activeZoneKeyRef.current !== null) continue
          if (distance(localPositionRef.current, player.position) < DISCONNECT_RANGE) {
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
      setRoomReady(false)
      if (room) { room.disconnect(); roomRef.current = null }
      cleanupAll()
      subscribedIds.current.clear()
    }
  }, [socket?.id, mic.isReady])

  // ── AudioContext state monitoring ─────────────────────────────────────────
  useEffect(() => {
    const ctx = mic.audioCtxRef.current
    if (!ctx) return
    const handler = () => {
      const hasPeers = remoteEntries.current.size > 0
      setAudioInterrupted(ctx.state === 'interrupted' && hasPeers)
      setAudioBlocked(ctx.state === 'suspended' && hasPeers)
    }
    ctx.addEventListener('statechange', handler)
    return () => ctx.removeEventListener('statechange', handler)
  }, [mic.isReady])

  // ── Proximity loop ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!roomReady) return
    const room = roomRef.current
    if (!room) return

    const id = setInterval(() => {
      const local  = localPositionRef.current
      const remote = remotePlayersRef.current
      const ctx    = mic.audioCtxRef.current

      // Unsubscribe out-of-range or zoned players
      for (const identity of subscribedIds.current) {
        const player = remote.get(identity)
        const dist   = player ? distance(local, player.position) : Infinity
        const shouldUnsub = !player || dist > DISCONNECT_RANGE || player.zoneKey !== null || activeZoneKeyRef.current !== null
        if (shouldUnsub) {
          const participant = room.remoteParticipants.get(identity)
          if (participant) {
            for (const pub of participant.trackPublications.values()) {
              if (pub.kind === Track.Kind.Audio && pub.isSubscribed) (pub as RemoteTrackPublication).setSubscribed(false)
            }
          }
          subscribedIds.current.delete(identity)
        }
      }

      // When local player is in a zone, no proximity connections at all
      if (activeZoneKeyRef.current !== null) {
        setConnectedPeers(new Set())
        return
      }

      const candidates = [...remote.entries()]
        .filter(([, p]) => p.zoneKey === null)
        .map(([id, p]) => ({ id, player: p, dist: distance(local, p.position) }))
        .filter(e => e.dist < DISCONNECT_RANGE)
        .sort((a, b) => a.dist - b.dist)
      const preferred = new Set(candidates.slice(0, MAX_ACTIVE_PEERS).map(e => e.id))

      const nextSpeaking = new Set<string>()

      remote.forEach((player, id) => {
        if (player.zoneKey !== null) return
        const dist      = distance(local, player.position)
        const subscribed = subscribedIds.current.has(id)

        if (dist < CONNECT_RANGE && preferred.has(id) && !subscribed) {
          const participant = room.remoteParticipants.get(id)
          if (participant) {
            for (const pub of participant.trackPublications.values()) {
              if (pub.kind === Track.Kind.Audio && !pub.isSubscribed) {
                (pub as RemoteTrackPublication).setSubscribed(true)
                subscribedIds.current.add(id)
              }
            }
          }
        } else if (subscribed) {
          const entry = remoteEntries.current.get(id)
          if (!entry || !ctx) return
          const normalized    = Math.min(1, Math.max(0, dist / DISCONNECT_RANGE))
          const distanceFactor = 1 - normalized ** rolloffRef.current
          const target        = distanceFactor * remoteGainRef.current
          if (entry.gainNode) entry.gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.05)
          else entry.audio.volume = Math.min(1, target)
          if (entry.participant.isSpeaking) nextSpeaking.add(id)
        }
      })

      setSpeakingPeers(nextSpeaking)
      const shouldDuck = nextSpeaking.size > 0
      mic.applyEffectiveMicGain(mic.micGainRef.current, shouldDuck)
      setConnectedPeers(new Set(subscribedIds.current))

      const hasPeers = remoteEntries.current.size > 0
      const livekitBlocked = hasPeers && roomRef.current != null && !roomRef.current.canPlaybackAudio
      setAudioInterrupted(mic.audioCtxRef.current?.state === 'interrupted' && hasPeers)
      setAudioBlocked((mic.audioCtxRef.current?.state === 'suspended' || livekitBlocked) && hasPeers)
    }, 100)

    return () => clearInterval(id)
  }, [roomReady])

  function setRemoteGain(value: number) {
    const next = Math.max(0, value)
    setRemoteGainState(next)
    try { localStorage.setItem(GAIN_STORAGE_KEY, String(next)) } catch { /* ignore */ }
  }

  return { speakingPeers, connectedPeers, peerConnectionStates, remoteGain, setRemoteGain, audioBlocked, audioInterrupted }
}
