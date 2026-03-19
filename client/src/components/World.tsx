import { useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Grid, Environment, KeyboardControls } from '@react-three/drei'
import LocalPlayer from './LocalPlayer'
import RemotePlayer from './RemotePlayer'
import ChatPanel from './ChatPanel'
import VoiceControls from './VoiceControls'
import VoiceConnectionsPanel from './VoiceConnectionsPanel'
import CameraRig from './CameraRig'
import { useSocket } from '../hooks/useSocket'
import { useChat } from '../hooks/useChat'
import { useProximityVoice } from '../hooks/useProximityVoice'
import type { Player } from '../types'

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
  const localPositionRef = useRef({ x: 0, y: 0.5, z: 0 })

  const { socket, remotePlayers, emitMove } = useSocket(player)
  const { messages, bubbles, sendMessage } = useChat(socket)
  const {
    muted,
    toggleMute,
    isLocalSpeaking,
    speakingPeers,
    connectedPeers,
    peerConnectionStates,
    remoteGain,
    setRemoteGain,
    micGain,
    setMicGain,
    rolloff,
    setRolloff,
    hpfFreq,
    setHpfFreq,
    agcEnabled,
    toggleAgc,
    gateThreshold,
    setGateThreshold,
    audioBlocked,
    audioInterrupted,
  } = useProximityVoice(socket, localPositionRef, remotePlayers)

  return (
    <>
      <KeyboardControls map={keyMap}>
        <Canvas orthographic style={{ cursor: 'grab' }}>
          <CameraRig targetRef={localPositionRef} />
          <Environment preset="city" />
          <Grid
            infiniteGrid
            cellSize={1}
            cellThickness={0.5}
            sectionSize={5}
            sectionThickness={1}
            fadeDistance={50}
          />
          <LocalPlayer player={player} onMove={emitMove} positionRef={localPositionRef} isSpeaking={isLocalSpeaking} />
          {Array.from(remotePlayers.values()).map(p => (
            <RemotePlayer
              key={p.id}
              {...p}
              bubble={bubbles.get(p.id)}
              inRange={connectedPeers.has(p.id)}
              isSpeaking={speakingPeers.has(p.id)}
            />
          ))}
        </Canvas>
      </KeyboardControls>

      <ChatPanel
        messages={messages}
        onSend={text => socket && sendMessage(socket, text)}
      />
      <VoiceControls
        muted={muted}
        onToggle={toggleMute}
        remoteGain={remoteGain}
        onGainChange={setRemoteGain}
        micGain={micGain}
        onMicGainChange={setMicGain}
        rolloff={rolloff}
        onRolloffChange={setRolloff}
        hpfFreq={hpfFreq}
        onHpfFreqChange={setHpfFreq}
        agcEnabled={agcEnabled}
        onAgcToggle={toggleAgc}
        gateThreshold={gateThreshold}
        onGateThresholdChange={setGateThreshold}
        audioBlocked={audioBlocked}
        audioInterrupted={audioInterrupted}
      />
      <VoiceConnectionsPanel
        rows={Array.from(remotePlayers.values()).map((player) => ({
          id: player.id,
          name: player.name,
          connected: connectedPeers.has(player.id),
          speaking: speakingPeers.has(player.id),
          state: peerConnectionStates[player.id] ?? (connectedPeers.has(player.id) ? 'connected' : 'idle'),
        }))}
      />
    </>
  )
}
