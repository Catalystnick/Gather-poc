import { memo, useLayoutEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3, type Group } from "three";
import AvatarMesh from "./AvatarMesh";
import ChatBubble from "./ChatBubble";
import PlayerLabel from "./PlayerLabel";
import StatusRing from "./StatusRing";
import type { Avatar, Direction } from "../../types";

interface Props {
  id: string;
  name: string;
  avatar: Avatar;
  position: { x: number; y: number; z: number };
  bubble?: string;
  inRange?: boolean;
  isSpeaking?: boolean;
}

function RemotePlayer({ name, avatar, position, bubble, inRange, isSpeaking }: Props) {
  const ref          = useRef<Group>(null);
  const directionRef = useRef<Direction>('down');
  const isMovingRef  = useRef(false);

  // Always holds the latest server position without stale-closure risk.
  // Updated in the render body so useFrame always reads the current target.
  const positionRef = useRef(position);
  positionRef.current = position;

  // Per-instance target vector — avoids the shared module-level singleton bug
  // that corrupts movement when multiple RemotePlayer instances are alive.
  const targetRef = useRef(new Vector3());

  // Set the group's initial position synchronously before the first frame so
  // the lerp has a correct starting point.
  useLayoutEffect(() => {
    ref.current?.position.set(position.x, position.y, position.z);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    if (!ref.current) return;

    // Read from ref, not from the closure, so we always have the latest value
    // regardless of whether memo suppressed the last re-render.
    const pos = positionRef.current;

    const prevX = ref.current.position.x;
    const prevZ = ref.current.position.z;

    targetRef.current.set(pos.x, pos.y, pos.z);
    ref.current.position.lerp(targetRef.current, 0.15);

    const dx = ref.current.position.x - prevX;
    const dz = ref.current.position.z - prevZ;
    const moving = Math.abs(dx) + Math.abs(dz) > 0.001;

    isMovingRef.current = moving;
    if (moving) {
      if (Math.abs(dx) >= Math.abs(dz)) {
        directionRef.current = dx > 0 ? 'right' : 'left';
      } else {
        directionRef.current = dz > 0 ? 'down' : 'up';
      }
    }
  });

  // No `position` prop on <group> — if we pass it, R3F's reconciler calls
  // group.position.set() on every re-render triggered by a socket update,
  // snapping the group to the server position and making dx = 0 every frame,
  // which keeps isMovingRef false and freezes the walk animation.
  return (
    <group ref={ref}>
      <AvatarMesh avatar={avatar} directionRef={directionRef} isMovingRef={isMovingRef} />
      <StatusRing speaking={isSpeaking} inRange={inRange} />
      <PlayerLabel name={name} />
      {bubble && <ChatBubble text={bubble} />}
    </group>
  );
}

export default memo(RemotePlayer)
