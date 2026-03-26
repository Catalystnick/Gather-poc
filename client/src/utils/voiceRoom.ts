// Shared primitives for proximity and zone LiveKit rooms.
// Extracted to eliminate duplication between the two room slots in useVoice.

import { Room, Track, AudioPresets, type LocalTrackPublication, type LocalAudioTrack, type RemoteAudioTrack } from 'livekit-client'
import { isKrispNoiseFilterSupported } from '@livekit/krisp-noise-filter'
import { GainKrispProcessor } from './GainKrispProcessor'
import type { MicTrack } from '../hooks/useMicTrack'

// ─── Shared constants ─────────────────────────────────────────────────────────

export const ROOM_NAME        = 'gather-world'
export const ZONE_ROOM_PREFIX = 'gather-world-zone-'
// Server issues tokens with ttl: '2h' (see server/index.js).
// Cache them client-side to avoid rate-limit / cold-start churn during zone transitions.
export const TOKEN_TTL_MS     = 105 * 60_000
export const AUDIO_PUBLISH_OPTS = {
  source: Track.Source.Microphone,
  name: 'mic',
  audioPreset: AudioPresets.speech,
} as const

// ─── Token cache entry ────────────────────────────────────────────────────────

export interface CachedToken { token: string; url: string; fetchedAt: number }

export function tokenIsValid(c: CachedToken): boolean {
  return Date.now() - c.fetchedAt < TOKEN_TTL_MS
}

// ─── Token URL ────────────────────────────────────────────────────────────────

export function getTokenUrl(): string {
  const base = (import.meta.env as { VITE_SERVER_URL?: string }).VITE_SERVER_URL || ''
  return `${base || window.location.origin}/livekit/token`
}

// ─── Fetch token ──────────────────────────────────────────────────────────────

export async function fetchToken(
  identity: string,
  roomName: string,
  accessToken: string,
): Promise<CachedToken | null> {
  try {
    const res = await fetch(getTokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ roomName, identity, name: identity }),
    })
    if (!res.ok) {
      console.warn('[voiceRoom] token HTTP error | room:', roomName, '| status:', res.status)
      return null
    }
    const { token, url } = (await res.json()) as { token?: string; url?: string }
    if (!token || !url) {
      console.warn('[voiceRoom] token response missing fields | room:', roomName)
      return null
    }
    return { token, url, fetchedAt: Date.now() }
  } catch (err) {
    console.warn('[voiceRoom] token fetch threw | room:', roomName, '| err:', err)
    return null
  }
}

// ─── Room factory ─────────────────────────────────────────────────────────────

export function createRoom(): Room {
  const room = new Room({ adaptiveStream: false, dynacast: false, singlePeerConnection: true, webAudioMix: false })
  ;(room as Room & { setMaxListeners?: (n: number) => void }).setMaxListeners?.(32)
  return room
}

// ─── Remote audio attachment ──────────────────────────────────────────────────

export function attachRemoteAudio(track: RemoteAudioTrack, volume: number): HTMLAudioElement {
  const audio = track.attach()
  audio.autoplay = true
  audio.setAttribute('playsinline', 'true')
  audio.style.display = 'none'
  const clamped = Math.min(1, Math.max(0, volume))
  audio.volume = clamped
  track.setVolume(clamped)
  document.body.appendChild(audio)
  return audio
}

// ─── Krisp noise filter setup ─────────────────────────────────────────────────
// Called from the proximity room's RoomEvent.LocalTrackPublished handler only.
// Zone rooms publish a clone of processedMicStreamRef which is already Krisp-filtered
// via the proximity room's GainKrispProcessor (mic → Krisp → gainNode → micDest).

export async function applyKrisp(
  publication: Pick<LocalTrackPublication, 'source' | 'track'> & { track?: unknown },
  mic: MicTrack,
  label: string,
): Promise<void> {
  if (publication.source !== Track.Source.Microphone) return

  const track = publication.track as LocalAudioTrack | undefined | null
  // Avoid relying on `instanceof LocalAudioTrack` which can fail across bundling boundaries.
  // Instead, check for an audio track with a setProcessor method.
  if (!track || track.kind !== Track.Kind.Audio || typeof (track as LocalAudioTrack).setProcessor !== 'function') {
    console.warn(`[Krisp][${label}] mic published but track is not a LocalAudioTrack — NC skipped`)
    return
  }

  console.log(`[Krisp][${label}] mic published — applying NC | track:`, track.mediaStreamTrack.label)
  if (!isKrispNoiseFilterSupported()) {
    console.warn(`[Krisp][${label}] not supported — NC skipped`)
    return
  }
  const gainNode = mic.micGainNodeRef.current
  const srcNode  = mic.micSourceNodeRef.current
  if (!gainNode || !srcNode) {
    console.warn(`[Krisp][${label}] gain/source nodes not ready — NC skipped`)
    return
  }
  const processor = new GainKrispProcessor(gainNode, srcNode)
  try {
    await track.setProcessor(
      processor as unknown as Parameters<typeof track.setProcessor>[0],
    )
    console.log(`[Krisp][${label}] processor set OK`)
  } catch (err) {
    console.error(`[Krisp][${label}] setProcessor failed:`, err)
  }
}
