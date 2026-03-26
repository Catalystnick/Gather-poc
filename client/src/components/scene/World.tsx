import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Perf } from "r3f-perf";
import { Environment, KeyboardControls } from "@react-three/drei";
import * as THREE from "three";
import FloorMap from "./FloorMap";
import PlacementTool from "./PlacementTool";
import PlacementHUD, { type PlacementHUDState } from "./PlacementHUD";
import Campfire from "./Campfire";
import LocalPlayer from "../player/LocalPlayer";
import RemotePlayer from "../player/RemotePlayer";
import ChatPanel from "../hud/ChatPanel";
import VoiceControls from "../hud/VoiceControls";
import VoiceConnectionsPanel from "../hud/VoiceConnectionsPanel";
import CameraRig from "./CameraRig";
import Zones from "./Zones";
import Fence from "./Fence";
import { useSocket } from "../../hooks/useSocket";
import { useChat } from "../../hooks/useChat";
import { useMicTrack } from "../../hooks/useMicTrack";
import { useZoneVoice } from "../../hooks/useZoneVoice";
import { useLiveKitVoice } from "../../hooks/useLiveKitVoice";
import { VoiceProvider } from "../../contexts/VoiceContext";
import { useAuth } from "../../contexts/AuthContext";
import type { Player } from "../../types";

const keyMap = [
  { name: "forward", keys: ["ArrowUp", "KeyW"] },
  { name: "backward", keys: ["ArrowDown", "KeyS"] },
  { name: "left", keys: ["ArrowLeft", "KeyA"] },
  { name: "right", keys: ["ArrowRight", "KeyD"] },
];

interface Props {
  player: Player;
}

export default function World({ player }: Props) {
  const { session } = useAuth();
  const accessToken = session!.access_token;
  const { socket, remotePlayers, emitMove, spawnPosition } = useSocket(player, accessToken);
  const localPositionRef = useRef({ x: 0, y: 0.5, z: 0 });
  const uvAttrRef = useRef<THREE.InstancedBufferAttribute | null>(null);

  const [hudState, setHudState] = useState<PlacementHUDState>({ col: 0, row: 0, width: 1, height: 1, fenceId: 1 });
  const onHUDState = useCallback((s: PlacementHUDState) => setHudState(s), []);

  useEffect(() => {
    if (spawnPosition) {
      console.log("[World] spawnPosition received → rendering LocalPlayer at", spawnPosition);
      localPositionRef.current = spawnPosition;
    } else {
      console.log("[World] spawnPosition is null — LocalPlayer will not render");
    }
  }, [spawnPosition]);
  const { messages, bubbles, sendMessage } = useChat(socket);

  // ── Voice coordinator ───────────────────────────────────────────────────
  const mic = useMicTrack();
  const zoneVoice = useZoneVoice(socket, localPositionRef, mic, accessToken);
  const proximityVoice = useLiveKitVoice(socket, localPositionRef, remotePlayers, mic, zoneVoice.activeZoneKey, accessToken);

  // Unified voice state: zone room takes precedence when active
  const inZone = zoneVoice.activeZoneKey !== null;
  const voice = {
    muted: mic.isMuted,
    toggleMute: mic.toggleMute,
    isLocalSpeaking: mic.isLocalSpeaking,
    micGain: mic.micGain,
    setMicGain: mic.setMicGain,
    headphonePrompt: mic.headphonePrompt,
    confirmHeadphones: mic.confirmHeadphones,
    connectedPeers: inZone ? zoneVoice.connectedPeers : proximityVoice.connectedPeers,
    speakingPeers: inZone ? zoneVoice.speakingPeers : proximityVoice.speakingPeers,
    peerConnectionStates: inZone ? {} : proximityVoice.peerConnectionStates,
    remoteGain: proximityVoice.remoteGain,
    setRemoteGain: proximityVoice.setRemoteGain,
    audioBlocked: proximityVoice.audioBlocked,
    audioInterrupted: proximityVoice.audioInterrupted,
    mode: zoneVoice.mode,
    activeZoneKey: zoneVoice.activeZoneKey,
  };

  // Derive connection rows once per render rather than inline in JSX.
  const connectionRows = useMemo(
    () =>
      Array.from(remotePlayers.values()).map((p) => ({
        id: p.id,
        name: p.name,
        connected: voice.connectedPeers.has(p.id),
        speaking: voice.speakingPeers.has(p.id),
        state: voice.peerConnectionStates[p.id] ?? (voice.connectedPeers.has(p.id) ? "connected" : "idle"),
      })),
    [remotePlayers, voice.connectedPeers, voice.speakingPeers, voice.peerConnectionStates],
  );

  return (
    <VoiceProvider value={voice}>
      <KeyboardControls map={keyMap}>
        <Canvas orthographic style={{ cursor: "grab" }}>
          <Suspense fallback={null}>
            <Perf position="top-left" />
            <CameraRig targetRef={localPositionRef} />
            <Environment preset="city" />
            <FloorMap uvAttrRef={uvAttrRef} />
            <Campfire />
            <Zones />
            <Fence />
            {import.meta.env.DEV && <PlacementTool uvAttrRef={uvAttrRef} onHUDState={onHUDState} />}
            {spawnPosition && (
              <LocalPlayer player={player} onMove={emitMove} positionRef={localPositionRef} spawnPosition={spawnPosition} isSpeaking={voice.isLocalSpeaking} activeZoneKey={zoneVoice.activeZoneKey} />
            )}
            {Array.from(remotePlayers.values()).map((p) => (
              <RemotePlayer key={p.id} {...p} bubble={bubbles.get(p.id)} inRange={voice.connectedPeers.has(p.id)} isSpeaking={voice.speakingPeers.has(p.id)} />
            ))}
          </Suspense>
        </Canvas>
      </KeyboardControls>

      {import.meta.env.DEV && <PlacementHUD {...hudState} />}
      <ChatPanel messages={messages} onSend={sendMessage} />
      <VoiceControls />
      <VoiceConnectionsPanel rows={connectionRows} />
    </VoiceProvider>
  );
}
