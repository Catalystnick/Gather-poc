// Shared primitives for proximity and zone LiveKit rooms.
// Extracted to eliminate duplication between the two room slots in useVoice.

import { Room, RoomEvent, Track, AudioPresets, LocalAudioTrack, type RemoteAudioTrack } from 'livekit-client'

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
    singlePeerConnection: true,
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

// ─── Local mic track (Krisp attached after publish — see LiveKit docs) ─────────

/**
 * Wrap the shared capture track for LiveKit publish. Mic acquisition uses
 * `createLocalAudioTrack` in useMicTrack; this is a user-managed `LocalAudioTrack`
 * (`userProvided: true`) plus `audioContext` for room `webAudioMix`.
 * Publish first; then {@link attachMicKrispOnLocalTrackPublished} applies Krisp on `LocalTrackPublished`.
 */
export function createLocalMicTrack(
  rawClone: MediaStreamTrack,
  audioCtx?: AudioContext,
): LocalAudioTrack {
  return new LocalAudioTrack(rawClone, undefined, true, audioCtx)
}

/** Processor name from @livekit/krisp-noise-filter (matches components-react `useKrispNoiseFilter`). */
export const LIVEKIT_KRISP_PROCESSOR_NAME = 'livekit-noise-filter'

type KrispProcessorLike = { name?: string; setEnabled?: (enabled: boolean) => Promise<unknown> }

function isLiveKitKrispProcessor(
  proc: KrispProcessorLike | undefined,
): proc is KrispProcessorLike & { setEnabled: (enabled: boolean) => Promise<unknown> } {
  return Boolean(
    proc &&
      typeof proc.setEnabled === 'function' &&
      proc.name === LIVEKIT_KRISP_PROCESSOR_NAME,
  )
}

/** Matches LiveKit Krisp docs: dynamic import, setProcessor, setEnabled(true). */
export async function applyKrispNoiseFilterFromDocs(
  track: LocalAudioTrack,
  label: string,
): Promise<boolean> {
  const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import('@livekit/krisp-noise-filter')
  if (!isKrispNoiseFilterSupported()) {
    console.warn(`[Krisp][${label}] Krisp noise filter is currently not supported on this browser`)
    return false
  }
  try {
    const krispProcessor = KrispNoiseFilter()
    console.log(`[Krisp][${label}] Enabling LiveKit Krisp noise filter`)
    await track.setProcessor(krispProcessor)
    await krispProcessor.setEnabled(true)
    return true
  } catch (err) {
    console.error(`[Krisp][${label}] setProcessor / setEnabled failed:`, err)
    return false
  }
}

/**
 * Enable/disable Krisp on an existing processor, or attach if `enabled` and none yet.
 * Used when toggling was supported and for post-publish cancel if ref flips (unused when Krisp is always on).
 */
async function syncKrispEnabledOnLocalTrack(
  track: LocalAudioTrack,
  enabled: boolean,
  label: string,
): Promise<boolean> {
  const proc = track.getProcessor() as KrispProcessorLike | undefined
  if (isLiveKitKrispProcessor(proc)) {
    try {
      await proc.setEnabled(enabled)
      return enabled
    } catch (err) {
      console.error(`[Krisp][${label}] setEnabled(${enabled}) failed:`, err)
      return !enabled
    }
  }
  if (enabled) {
    return applyKrispNoiseFilterFromDocs(track, `${label}-sync-on`)
  }
  return false
}

/**
 * Register docs-style Krisp setup once per room (before connect / publish).
 */
export function attachMicKrispOnLocalTrackPublished(
  room: Room,
  krispEnabledRef: { current: boolean },
  label: string,
  onApplied: (applied: boolean) => void,
): void {
  room.on(RoomEvent.LocalTrackPublished, async publication => {
    if (publication.source !== Track.Source.Microphone) return
    const track = publication.track
    if (!(track instanceof LocalAudioTrack)) return
    if (!krispEnabledRef.current) {
      onApplied(false)
      return
    }
    const applied = await applyKrispNoiseFilterFromDocs(track, `${label}-published`)
    // User may have turned Krisp off while `applyKrispNoiseFilterFromDocs` was in flight; otherwise toggle does nothing.
    if (!krispEnabledRef.current && applied) {
      await syncKrispEnabledOnLocalTrack(track, false, `${label}-published-cancel`)
      onApplied(false)
      return
    }
    onApplied(Boolean(applied && krispEnabledRef.current))
  })
}
