import { useLayoutEffect } from "react";
import { Box, Sphere, useTexture } from "@react-three/drei";
import { ClampToEdgeWrapping, NearestFilter, SRGBColorSpace } from "three";
import type { Avatar } from "../types";

interface Props {
  avatar: Avatar;
}

/** Idle PNG is 768×256px → 12×4 grid of 64×64 frames. */
const SWORDSMAN_IDLE_COLS = 12;
const SWORDSMAN_IDLE_ROWS = 4;
/** XZ plane size in world units (matches scale of box/sphere avatars better). */
const SWORDSMAN_PLANE_SIZE = 4.28;

function SwordsmanPlane() {
  const texture = useTexture("/avatars/swordsman-idle.png");

  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.repeat.set(1 / SWORDSMAN_IDLE_COLS, 1 / SWORDSMAN_IDLE_ROWS);
    // First column, top row of PNG (default facing / row 0 in source art)
    texture.offset.set(0, (SWORDSMAN_IDLE_ROWS - 1) / SWORDSMAN_IDLE_ROWS);
    texture.needsUpdate = true;
  }, [texture]);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[SWORDSMAN_PLANE_SIZE, SWORDSMAN_PLANE_SIZE]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

export default function AvatarMesh({ avatar }: Props) {
  const material = <meshStandardMaterial color={avatar.color} />;

  if (avatar.shape === "swordsman") {
    return <SwordsmanPlane />;
  }

  if (avatar.shape === "box") {
    return <Box args={[0.6, 1, 0.6]}>{material}</Box>;
  }

  if (avatar.shape === "sphere") {
    return <Sphere args={[0.5, 16, 16]}>{material}</Sphere>;
  }

  return null;
}
