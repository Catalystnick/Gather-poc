// Module-level singleton shared between React hooks and the Phaser scene.
// React writes into this object; Phaser reads from it each frame.

import type { LdtkMapData } from '../types/mapTypes';
import type { Avatar, Direction, RemotePlayer } from '../types';

export interface MoveState {
  col:       number;
  row:       number;
  direction: Direction;
  moving:    boolean;
  zoneKey:   string | null;
}

interface PositionRef {
  current: { x: number; y: number; z: number };
}

const GameBridge = {
  // Map data — set by World once useLdtk resolves
  mapData: null as LdtkMapData | null,

  // Remote players — updated on every socket event
  remotePlayers: new Map<string, RemotePlayer>(),

  // Local player identity
  playerName: '',
  playerId: '',
  playerAvatar: { shirt: '#3498db' } as Avatar,
  serverSpawn: null as { col: number; row: number } | null,
  localMuted: false,
  localSpeaking: false,
  speakingPeers: new Set<string>(),

  // Ref shared with useVoice — updated by GameScene each frame
  positionRef: { current: { x: 0, y: 0, z: 0 } } as PositionRef,

  // Called by GameScene on every committed step; wired to socket.emitMove
  onPlayerMove: null as ((state: MoveState) => void) | null,
};

export default GameBridge;
