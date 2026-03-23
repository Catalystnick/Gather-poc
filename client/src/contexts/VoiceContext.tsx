import { createContext, useContext } from 'react'

export interface VoiceState {
  muted: boolean
  toggleMute: () => void
  isLocalSpeaking: boolean
  speakingPeers: Set<string>
  connectedPeers: Set<string>
  peerConnectionStates: Record<string, string>
  remoteGain: number
  setRemoteGain: (v: number) => void
  micGain: number
  setMicGain: (v: number) => void
  headphonePrompt: string | null
  confirmHeadphones: (accept: boolean) => void
  audioBlocked?: boolean
  audioInterrupted?: boolean
}

const VoiceContext = createContext<VoiceState | null>(null)

export function useVoice(): VoiceState {
  const ctx = useContext(VoiceContext)
  if (!ctx) throw new Error('useVoice must be used within VoiceProvider')
  return ctx
}

export const VoiceProvider = VoiceContext.Provider
