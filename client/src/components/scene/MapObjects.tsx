// Renders all visual objects extracted from TMX objectgroups (signs, tents, houses, campfires).
// Each object is a textured plane Y-sorted by its south (bottom) edge via spriteOrder().
//
// Objects are grouped by image path so drei's useTexture cache is used efficiently —
// one GPU texture per unique path, shared across all instances of that image.

import { useMemo, useEffect } from "react";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";

import { WORLD_OBJECTS, WORLD_FENCE_OBJECTS } from "../../data/worldMap";
import type { WorldObject } from "../../data/worldMap";
import { spriteOrder } from "../../utils/renderOrder";

// All visual objects: TMX objectgroups + fence tile sprites.
const ALL_OBJECTS: readonly WorldObject[] = [...WORLD_OBJECTS, ...WORLD_FENCE_OBJECTS];

// Collect unique image paths used by the map objects.
const UNIQUE_SRCS = [...new Set(ALL_OBJECTS.map((o) => o.src))];

// ─── ObjectMesh ───────────────────────────────────────────────────────────────
// Renders a single map object as an axis-aligned horizontal plane.

interface ObjectMeshProps {
  obj: WorldObject;
  texture: THREE.Texture;
}

function ObjectMesh({ obj, texture }: ObjectMeshProps) {
  const mat = useMemo(() => {
    const m = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.05,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    return m;
  }, [texture]);

  useEffect(
    () => () => {
      mat.dispose();
    },
    [mat],
  );

  // Y-sort by south edge (center Z + half height)
  const ro = spriteOrder(obj.z + obj.h / 2);

  return (
    <mesh position={[obj.x, 0.01, obj.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={ro}>
      <planeGeometry args={[obj.w, obj.h]} />
      <primitive object={mat} attach="material" />
    </mesh>
  );
}

// ─── MapObjects ───────────────────────────────────────────────────────────────

export default function MapObjects() {
  const textures = useTexture(UNIQUE_SRCS);
  const texArr = Array.isArray(textures) ? textures : [textures];

  useMemo(() => {
    for (const t of texArr) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
    }
  }, [texArr]);

  // Build src → texture lookup.
  const texByPath = useMemo(() => {
    const m = new Map<string, THREE.Texture>();
    UNIQUE_SRCS.forEach((src, i) => m.set(src, texArr[i]));
    return m;
  }, [texArr]);

  return (
    <group>
      {ALL_OBJECTS.map((obj, i) => {
        const tex = texByPath.get(obj.src);
        if (!tex) return null;
        return <ObjectMesh key={i} obj={obj} texture={tex} />;
      })}
    </group>
  );
}
