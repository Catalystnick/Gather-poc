// Root scene — loads map data, wires the GameBridge, mounts Phaser + React HUD.

import { useMemo, useRef, useEffect } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { VoiceProvider } from "../../contexts/VoiceContext";
import { useSocket } from "../../hooks/useSocket";
import { useMicTrack } from "../../hooks/useMicTrack";
import { useVoice } from "../../hooks/useVoice";
import { useChat } from "../../hooks/useChat";
import { useLdtk } from "../../hooks/useLdtk";
import { buildMentionSuggestions, buildOnlineUsers } from "../../chat/presenceSelectors";
import GameBridge from "../../game/GameBridge";
import PhaserGame from "../../game/PhaserGame";

import ChatPanel from "../hud/ChatPanel";
import VoiceControls from "../hud/VoiceControls";
import ServerStatusPanel from "../hud/ServerStatusPanel";
import VoiceConnectionsPanel from "../hud/VoiceConnectionsPanel";
import TagPingStack from "../hud/TagPingStack";
import TeleportRequestInbox from "../hud/TeleportRequestInbox";
import type { Player } from "../../types";

interface Props {
  player: Player;
}

/** Top-level game scene wrapper: bridges React hooks, Phaser runtime, and HUD panels. */
export default function World({ player }: Props) {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? "";
  const userId = session?.user?.id ?? "";

  const { mapData, mapError } = useLdtk();

  // positionRef is written by GameScene each frame; read by useVoice for proximity.
  const positionRef = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });

  const { socket, remotePlayers, serverSpawn, emitMove, emitVoiceState, status, lastDisconnectReason, lastError } =
    useSocket(player, accessToken);

  const mic = useMicTrack();

  const voiceState = useVoice(
    socket,
    positionRef,
    remotePlayers,
    mic,
    accessToken,
    userId,
    mapData?.zones ?? [],
  );

  const onlineUsers = useMemo(
    () => buildOnlineUsers(remotePlayers, { id: userId, name: player.name }),
    [remotePlayers, userId, player.name],
  );
  const mentionSuggestions = useMemo(
    () => buildMentionSuggestions(onlineUsers, userId),
    [onlineUsers, userId],
  );

  const {
    messages,
    sendMessage,
    commandStatus,
    clearCommandStatus,
    tagPings,
    dismissTagPing,
    teleportRequests,
    respondToTeleportRequest,
  } = useChat(socket, { currentUserId: userId, onlineUsers });

  // ── Wire GameBridge ─────────────────────────────────────────────────────────

  // Set stable references once — these never change identity
  GameBridge.positionRef         = positionRef;
  GameBridge.playerName          = player.name;
  GameBridge.playerId            = userId;
  GameBridge.playerAvatar        = player.avatar;
  GameBridge.serverSpawn         = serverSpawn;
  GameBridge.onPlayerMove        = emitMove;
  GameBridge.localMuted          = voiceState.muted;
  GameBridge.localSpeaking       = voiceState.isLocalSpeaking;
  GameBridge.speakingPeers       = voiceState.speakingPeers;

  // Map data — set before PhaserGame renders (guarded by mapData check below)
  useEffect(() => {
    GameBridge.mapData = mapData;
  }, [mapData]);

  // Remote players — updated on every socket event
  useEffect(() => {
    GameBridge.remotePlayers = remotePlayers;
  }, [remotePlayers]);

  useEffect(() => {
    if (!socket?.id) return;
    emitVoiceState({ muted: voiceState.muted });
  }, [socket?.id, voiceState.muted, emitVoiceState]);

  // ── HUD rows ────────────────────────────────────────────────────────────────

  const connectionRows = useMemo(
    () =>
      [...remotePlayers.values()].map((rp) => ({
        id:        rp.id,
        name:      rp.name,
        connected: voiceState.connectedPeers.has(rp.id),
        speaking:  voiceState.speakingPeers.has(rp.id),
        state:     voiceState.peerConnectionStates[rp.id] ?? "idle",
      })),
    [remotePlayers, voiceState.connectedPeers, voiceState.speakingPeers, voiceState.peerConnectionStates],
  );

  // ── Loading guard ───────────────────────────────────────────────────────────

  if (!mapData) {
    return (
      <div style={loadingStyle}>
        {mapError ? `Map error: ${mapError}` : "Loading map…"}
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <VoiceProvider value={voiceState}>
      <div style={rootStyle}>
        <PhaserGame style={canvasStyle} />

        <ChatPanel
          messages={messages}
          onSend={sendMessage}
          commandStatus={commandStatus}
          onDismissStatus={clearCommandStatus}
          mentionSuggestions={mentionSuggestions}
        />
        <TagPingStack pings={tagPings} onDismiss={dismissTagPing} />
        <TeleportRequestInbox requests={teleportRequests} onRespond={respondToTeleportRequest} />
        <VoiceControls />
        <ServerStatusPanel
          socketStatus={status}
          socketId={socket?.id}
          lastDisconnectReason={lastDisconnectReason}
          lastError={lastError}
          voiceMode={voiceState.mode}
          activeZoneKey={voiceState.activeZoneKey}
          proximityRoomReady={voiceState.proximityRoomReady}
        />
        <VoiceConnectionsPanel rows={connectionRows} />
      </div>
    </VoiceProvider>
  );
}

const rootStyle: React.CSSProperties = {
  width: "100vw",
  height: "100vh",
  position: "relative",
  overflow: "hidden",
};

const canvasStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
};

const loadingStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100vh",
  background: "#0a0a0a",
  color: "#fff",
  fontFamily: "sans-serif",
};
