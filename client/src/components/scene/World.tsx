import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment, KeyboardControls } from '@react-three/drei'
import FloorMap from './FloorMap'
import Vegetation from './Vegetation'
import Campfire from './Campfire'
import LocalPlayer from '../player/LocalPlayer'
import RemotePlayer from '../player/RemotePlayer'
import ChatPanel from '../hud/ChatPanel'
import VoiceControls from '../hud/VoiceControls'
import VoiceConnectionsPanel from '../hud/VoiceConnectionsPanel'
import CameraRig from './CameraRig'
import { useSocket } from '../../hooks/useSocket'
import { useChat } from '../../hooks/useChat'
import { useLiveKitVoice } from '../../hooks/useLiveKitVoice'
import { VoiceProvider } from '../../contexts/VoiceContext'
import type { Player } from '../../types'

const keyMap = [
  { name: 'forward',  keys: ['ArrowUp',    'KeyW'] },
  { name: 'backward', keys: ['ArrowDown',  'KeyS'] },
  { name: 'left',     keys: ['ArrowLeft',  'KeyA'] },
  { name: 'right',    keys: ['ArrowRight', 'KeyD'] },
]

interface Props {
  player: Player
}

export default function World({ player }: Props) {
  const { socket, remotePlayers, emitMove, spawnPosition } = useSocket(player)
  const localPositionRef = useRef({ x: 0, y: 0.5, z: 0 })

  useEffect(() => {
    if (spawnPosition) localPositionRef.current = spawnPosition
  }, [spawnPosition])
  const { messages, bubbles, sendMessage } = useChat(socket)
  const voice = useLiveKitVoice(socket, player.name, localPositionRef, remotePlayers)

  // Derive connection rows once per render rather than inline in JSX.
  const connectionRows = useMemo(
    () => Array.from(remotePlayers.values()).map(p => ({
      id: p.id,
      name: p.name,
      connected: voice.connectedPeers.has(p.id),
      speaking: voice.speakingPeers.has(p.id),
      state: voice.peerConnectionStates[p.id] ?? (voice.connectedPeers.has(p.id) ? 'connected' : 'idle'),
    })),
    [remotePlayers, voice.connectedPeers, voice.speakingPeers, voice.peerConnectionStates],
  )

  return (
    <VoiceProvider value={voice}>
      <KeyboardControls map={keyMap}>
        <Canvas orthographic style={{ cursor: 'grab' }}>
          <Suspense fallback={null}>
            <CameraRig targetRef={localPositionRef} />
            <Environment preset="city" />
            <FloorMap />
            <Vegetation />
            <Campfire />
            {spawnPosition && (
              <LocalPlayer
                player={player}
                onMove={emitMove}
                positionRef={localPositionRef}
                spawnPosition={spawnPosition}
                isSpeaking={voice.isLocalSpeaking}
              />
            )}
            {Array.from(remotePlayers.values()).map(p => (
              <RemotePlayer
                key={p.id}
                {...p}
                bubble={bubbles.get(p.id)}
                inRange={voice.connectedPeers.has(p.id)}
                isSpeaking={voice.speakingPeers.has(p.id)}
              />
            ))}
          </Suspense>
        </Canvas>
      </KeyboardControls>

      <ChatPanel messages={messages} onSend={sendMessage} />
      <VoiceControls />
      <VoiceConnectionsPanel rows={connectionRows} />
    </VoiceProvider>
  )
}
