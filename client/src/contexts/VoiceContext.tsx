import { createContext, useContext } from 'react'
import type { VoiceMode } from '../hooks/useVoice'

export interface VoiceState {
  muted: boolean
  toggleMute: () => void
  isLocalSpeaking: boolean
  speakingPeers: Set<string>
  connectedPeers: Set<string>
  peerConnectionStates: Record<string, string>
  remoteGain: number
  setRemoteGain: (nextValue: number) => void
  /** Linear multiplier (1–4) on remote voice; uses Web Audio gain when room has `webAudioMix`. */
  playbackBoost: number
  setPlaybackBoost: (nextValue: number) => void
  headphonePrompt: string | null
  confirmHeadphones: (accept: boolean) => void
  audioBlocked?: boolean
  audioInterrupted?: boolean
  mode: VoiceMode
  activeZoneKey: string | null
  proximityRoomReady?: boolean
  voiceEnabled: boolean
}

const VoiceContext = createContext<VoiceState | null>(null)

export function useVoice(): VoiceState {
  const voiceContext = useContext(VoiceContext)
  if (!voiceContext) throw new Error('useVoice must be used within VoiceProvider')
  return voiceContext
}

export const VoiceProvider = VoiceContext.Provider
