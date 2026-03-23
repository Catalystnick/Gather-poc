import { memo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3, type Group } from "three";
import AvatarMesh from "./AvatarMesh";
import ChatBubble from "./ChatBubble";
import PlayerLabel from "./PlayerLabel";
import StatusRing from "./StatusRing";
import type { Avatar, Direction } from "../types";

interface Props {
  id: string;
  name: string;
  avatar: Avatar;
  position: { x: number; y: number; z: number };
  bubble?: string;
  inRange?: boolean;
  isSpeaking?: boolean;
}

const target = new Vector3();

function RemotePlayer({ name, avatar, position, bubble, inRange, isSpeaking }: Props) {
  const ref          = useRef<Group>(null);
  const directionRef = useRef<Direction>('down');
  const isMovingRef  = useRef(false);

  useFrame(() => {
    if (!ref.current) return;

    const prevX = ref.current.position.x;
    const prevZ = ref.current.position.z;

    target.set(position.x, position.y, position.z);
    ref.current.position.lerp(target, 0.15);

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

  return (
    <group ref={ref} position={[position.x, position.y, position.z]}>
      <AvatarMesh avatar={avatar} directionRef={directionRef} isMovingRef={isMovingRef} />
      <StatusRing speaking={isSpeaking} inRange={inRange} />
      <PlayerLabel name={name} />
      {bubble && <ChatBubble text={bubble} />}
    </group>
  );
}

export default memo(RemotePlayer)
