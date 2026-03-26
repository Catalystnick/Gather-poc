import { useVoice } from '../contexts/VoiceContext'

/**
 * Same API as `useKrispNoiseFilter` from `@livekit/components-react/krisp`, but uses
 * Gather's dual-room `LiveKit` setup (no `LiveKitRoom` / track ref required).
 *
 * @example
 * ```tsx
 * const krisp = useKrispNoiseFilter()
 * return (
 *   <input
 *     type="checkbox"
 *     checked={krisp.isNoiseFilterEnabled}
 *     disabled={krisp.isNoiseFilterPending}
 *     onChange={(e) => krisp.setNoiseFilterEnabled(e.target.checked)}
 *   />
 * )
 * ```
 */
export function useKrispNoiseFilter() {
  const v = useVoice()
  return {
    setNoiseFilterEnabled: v.setKrispNoiseFilterEnabled,
    isNoiseFilterEnabled: v.krispEnabled,
    isNoiseFilterPending: v.krispNoiseFilterPending,
  }
}
