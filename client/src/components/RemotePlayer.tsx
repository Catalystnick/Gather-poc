import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import { Vector3, type Group } from "three";
import AvatarMesh from "./AvatarMesh";
import ChatBubble from "./ChatBubble";
import type { Avatar } from "../types";

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

export default function RemotePlayer({ name, avatar, position, bubble, inRange, isSpeaking }: Props) {
  const ref = useRef<Group>(null);

  useFrame(() => {
    if (!ref.current) return;
    target.set(position.x, position.y, position.z);
    ref.current.position.lerp(target, 0.15);
  });

  return (
    <group ref={ref} position={[position.x, position.y, position.z]}>
      <AvatarMesh avatar={avatar} />

      {/* Voice range indicator — blue ring when in range, green when speaking */}
      {inRange && !isSpeaking && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.48, 0]}>
          <ringGeometry args={[0.58, 0.72, 32]} />
          <meshBasicMaterial color="#3498db" transparent opacity={0.5} />
        </mesh>
      )}
      {isSpeaking && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.48, 0]}>
          <ringGeometry args={[0.58, 0.72, 32]} />
          <meshBasicMaterial color="#2ecc71" transparent opacity={0.8} />
        </mesh>
      )}

      <Text position={[0, 0.5, -1.6]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.3} color="#ffffff" anchorX="center" anchorY="middle" outlineWidth={0.03} outlineColor="#000000">
        {name}
      </Text>

      {bubble && <ChatBubble text={bubble} />}
    </group>
  );
}
