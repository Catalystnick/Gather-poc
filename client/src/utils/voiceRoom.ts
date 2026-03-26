// Shared primitives for proximity and zone LiveKit rooms.
// Extracted to eliminate duplication between the two room slots in useVoice.

import { Room, Track, AudioPresets, LocalAudioTrack, type RemoteAudioTrack } from 'livekit-client'
import { isKrispNoiseFilterSupported, KrispNoiseFilter } from '@livekit/krisp-noise-filter'

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

export type TokenIntent = 'join' | 'prefetch'
export interface CachedToken {
  token: string
  url: string
  fetchedAt: number
  intent: TokenIntent
}
export interface TokenFetchResult {
  cached: CachedToken | null
  status: number | null
}

export function tokenIsValid(c: CachedToken): boolean {
  return Date.now() - c.fetchedAt < TOKEN_TTL_MS
}

// ─── Token URL ────────────────────────────────────────────────────────────────

export function getTokenUrl(): string {
  const base = (import.meta.env as { VITE_SERVER_URL?: string }).VITE_SERVER_URL || ''
  return `${base || window.location.origin}/livekit/token`
}

// ─── Fetch token ──────────────────────────────────────────────────────────────

export async function fetchTokenDetailed(
  identity: string,
  roomName: string,
  accessToken: string,
  intent: TokenIntent = 'join',
): Promise<TokenFetchResult> {
  try {
    const res = await fetch(getTokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ roomName, identity, name: identity, intent }),
    })
    if (!res.ok) {
      console.warn('[voiceRoom] token HTTP error | room:', roomName, '| status:', res.status)
      return { cached: null, status: res.status }
    }
    const { token, url } = (await res.json()) as { token?: string; url?: string }
    if (!token || !url) {
      console.warn('[voiceRoom] token response missing fields | room:', roomName)
      return { cached: null, status: res.status }
    }
    return { cached: { token, url, fetchedAt: Date.now(), intent }, status: res.status }
  } catch (err) {
    console.warn('[voiceRoom] token fetch threw | room:', roomName, '| err:', err)
    return { cached: null, status: null }
  }
}

export async function fetchToken(
  identity: string,
  roomName: string,
  accessToken: string,
  intent: TokenIntent = 'join',
): Promise<CachedToken | null> {
  const result = await fetchTokenDetailed(identity, roomName, accessToken, intent)
  return result.cached
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
// Krisp is applied to a LocalAudioTrack BEFORE publishing, not in a
// LocalTrackPublished event handler. The event approach races with zone
// transitions — applying it here ensures it runs in the correct async context
// with the correct room, before the track enters the PeerConnection.
//
// audioCtx must be the same AudioContext owned by useMicTrack (already running).
// Without it, LocalAudioTrack creates its own context internally which may start
// suspended — Krisp's AudioWorkletNode then never processes audio.

export async function createKrispLocalTrack(
  rawClone: MediaStreamTrack,
  label: string,
  audioCtx?: AudioContext,
  krispEnabled = true,
): Promise<{ localTrack: LocalAudioTrack; krispApplied: boolean }> {
  const localTrack = new LocalAudioTrack(rawClone, undefined, true, audioCtx)
  if (!krispEnabled) {
    console.log(`[Krisp][${label}] disabled by user`)
    return { localTrack, krispApplied: false }
  }
  if (!isKrispNoiseFilterSupported()) {
    console.warn(`[Krisp][${label}] not supported — NC skipped`)
    return { localTrack, krispApplied: false }
  }
  console.log(`[Krisp][${label}] applying NC | track:`, rawClone.label)
  try {
    await localTrack.setProcessor(KrispNoiseFilter())
    console.log(`[Krisp][${label}] processor set OK`)
    return { localTrack, krispApplied: true }
  } catch (err) {
    console.error(`[Krisp][${label}] setProcessor failed:`, err)
    return { localTrack, krispApplied: false }
  }
}
