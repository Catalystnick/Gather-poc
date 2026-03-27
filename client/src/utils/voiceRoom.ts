// Shared primitives for proximity and zone LiveKit rooms.
// Extracted to eliminate duplication between the two room slots in useVoice.

import { Room, Track, AudioPresets, LocalAudioTrack, type RemoteAudioTrack } from 'livekit-client'

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

/**
 * @param audioContext When set, enables LiveKit `webAudioMix` so remote audio uses a
 * `GainNode` — values > 1.0 are valid (HTMLAudioElement.volume cannot exceed 1).
 */
export function createRoom(audioContext?: AudioContext | null): Room {
  const room = new Room({
    adaptiveStream: false,
    dynacast: false,
    webAudioMix: audioContext ? { audioContext } : false,
    // Shared browser mic is owned by useMicTrack — never stop it on unpublish/disconnect.
    stopLocalTrackOnUnpublish: false,
  })
  ;(room as Room & { setMaxListeners?: (n: number) => void }).setMaxListeners?.(32)
  return room
}

// ─── Remote audio attachment ──────────────────────────────────────────────────

/**
 * `linearGain` can exceed 1 when the room uses `webAudioMix` (see `createRoom(ctx)`).
 * Otherwise the browser clamps element volume internally on playback.
 */
export function attachRemoteAudio(track: RemoteAudioTrack, linearGain: number): HTMLAudioElement {
  const audio = track.attach()
  audio.autoplay = true
  audio.setAttribute('playsinline', 'true')
  audio.style.display = 'none'
  const g = Math.max(0, linearGain)
  track.setVolume(g)
  document.body.appendChild(audio)
  return audio
}

// ─── Local mic track (LiveKit publish wrapper for Web Audio send path) ─────────

/**
 * Wrap the shared send-path track for LiveKit publish. Raw mic is acquired in
 * useMicTrack; this wraps the VAD-gated Web Audio output (`userProvided: true`)
 * plus `audioContext` for room `webAudioMix`.
 */
export function createLocalMicTrack(
  rawClone: MediaStreamTrack,
  audioCtx?: AudioContext,
): LocalAudioTrack {
  return new LocalAudioTrack(rawClone, undefined, true, audioCtx)
}
