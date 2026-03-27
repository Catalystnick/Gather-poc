import { useRef, useLayoutEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { useKeyboardControls } from "@react-three/drei";
import type { Group } from "three";
import AvatarMesh from "./AvatarMesh";
import PlayerLabel from "./PlayerLabel";
import StatusRing from "./StatusRing";
import type { Direction, Player } from "../../types";
import { resolveCollision } from "../../utils/fenceCollision";

const SPEED = 5;

interface Props {
  player: Player;
  onMove: (state: { x: number; y: number; z: number; direction: Direction; moving: boolean; zoneKey: string | null }) => void;
  positionRef: React.MutableRefObject<{ x: number; y: number; z: number }>;
  spawnPosition: { x: number; y: number; z: number };
  isSpeaking?: boolean;
  activeZoneKey: string | null;
}

export default function LocalPlayer({ player, onMove, positionRef, spawnPosition, isSpeaking, activeZoneKey }: Props) {
  const ref = useRef<Group>(null);
  const lastEmit = useRef(0);
  const directionRef = useRef<Direction>("down");
  const isMovingRef = useRef(false);
  const activeZoneKeyRef = useRef(activeZoneKey);
  activeZoneKeyRef.current = activeZoneKey;
  const [, getKeys] = useKeyboardControls();

  useLayoutEffect(() => {
    if (ref.current && spawnPosition) {
      ref.current.position.set(spawnPosition.x, spawnPosition.y, spawnPosition.z);
    }
  }, [spawnPosition]);

  useFrame((_, delta) => {
    if (!ref.current) return;
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const { forward, backward, left, right } = getKeys();

    const dx = (right ? 1 : 0) - (left ? 1 : 0);
    const dz = (backward ? 1 : 0) - (forward ? 1 : 0);

    const [cx, cz] = resolveCollision(
      ref.current.position.x,
      ref.current.position.z,
      ref.current.position.x + dx * SPEED * delta,
      ref.current.position.z + dz * SPEED * delta,
    )
    ref.current.position.x = cx
    ref.current.position.z = cz

    isMovingRef.current = dx !== 0 || dz !== 0;
    if (dx !== 0 || dz !== 0) {
      if (Math.abs(dx) >= Math.abs(dz)) {
        directionRef.current = dx > 0 ? "right" : "left";
      } else {
        // dz > 0 = moving +Z = screen-down = facing down
        // dz < 0 = moving -Z = screen-up   = facing up
        directionRef.current = dz > 0 ? "down" : "up";
      }
    }

    const { x, y, z } = ref.current.position;
    positionRef.current = { x, y, z };
    // Set renderOrder on the direct mesh children (not the Group) so the sort
    // key is comparable with the fence InstancedMesh, which also uses its own
    // renderOrder with groupOrder=0 (from its parent group). Setting it on the
    // Group would make groupOrder dynamic and always beat the fence's 0.
    const order = Math.round(z * 100);
    for (const child of ref.current.children) {
      child.renderOrder = order;
    }

    const now = performance.now();
    if (now - lastEmit.current > 100) {
      lastEmit.current = now;
      onMove({ x, y, z, direction: directionRef.current, moving: isMovingRef.current, zoneKey: activeZoneKeyRef.current });
    }
  });

  return (
    <group ref={ref}>
      <AvatarMesh avatar={player.avatar} directionRef={directionRef} isMovingRef={isMovingRef} />
      <PlayerLabel name={player.name} />
      <StatusRing speaking={isSpeaking} />
    </group>
  );
}
