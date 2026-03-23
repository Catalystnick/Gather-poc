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
  direction: Direction;
  moving: boolean;
  bubble?: string;
  inRange?: boolean;
  isSpeaking?: boolean;
}

function RemotePlayer({ name, avatar, position, direction, moving, bubble, inRange, isSpeaking }: Props) {
  const ref = useRef<Group>(null);

  // Animation state driven directly by the sender — no delta inference.
  const directionRef = useRef<Direction>(direction);
  const isMovingRef  = useRef(moving);
  directionRef.current = direction;
  isMovingRef.current  = moving;

  // Latest server position via ref so useFrame never has a stale closure.
  const positionRef = useRef(position);
  positionRef.current = position;

  const targetRef = useRef(new Vector3());

  // Initialise group position before the first frame.
  useLayoutEffect(() => {
    ref.current?.position.set(position.x, position.y, position.z);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Only lerp position — animation state comes straight from the server.
  useFrame(() => {
    if (!ref.current) return;
    const pos = positionRef.current;
    targetRef.current.set(pos.x, pos.y, pos.z);
    ref.current.position.lerp(targetRef.current, 0.15);
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
