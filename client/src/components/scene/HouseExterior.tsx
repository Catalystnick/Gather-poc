import { useMemo } from "react";
import { useControls, button } from "leva";
import * as THREE from "three";

// Nominal footprint from Exterior.tmx header: 16 cols × 24 rows
// Each tile = 1 world unit (matches FloorMap TILE_SIZE)
// Replace with parsed bounds once the TMX parse script is implemented.
const HOUSE_COLS = 16;
const HOUSE_ROWS = 24;

// Reusable geometry / materials — created once, never inside render loop
const fillGeo = new THREE.PlaneGeometry(HOUSE_COLS, HOUSE_ROWS);
const fillMat = new THREE.MeshBasicMaterial({
  color: 0xf97316,
  transparent: true,
  opacity: 0.18,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const boxGeo = new THREE.BoxGeometry(HOUSE_COLS, 0.02, HOUSE_ROWS);
const boxMat = new THREE.MeshBasicMaterial({ color: "red", wireframe: true });

// Grid lines every 1 world unit so individual tiles are visible
function buildGrid(): THREE.LineSegments {
  const points: number[] = [];
  const hw = HOUSE_COLS / 2;
  const hh = HOUSE_ROWS / 2;

  for (let c = 0; c <= HOUSE_COLS; c++) {
    const x = -hw + c;
    points.push(x, 0, -hh, x, 0, hh);
  }
  for (let r = 0; r <= HOUSE_ROWS; r++) {
    const z = -hh + r;
    points.push(-hw, 0, z, hw, 0, z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const mat = new THREE.LineBasicMaterial({ color: "red", transparent: true, opacity: 0.25 });
  return new THREE.LineSegments(geo, mat);
}

export default function HouseExterior() {
  const { x, z } = useControls("House Position", {
    x: { value: -10, min: -25, max: 25, step: 0.5, label: "X" },
    z: { value: -10, min: -18, max: 18, step: 0.5, label: "Z" },
    "Copy to clipboard": button((get) => {
      const pos = `[${get("House Position.x")}, 0, ${get("House Position.z")}]`;
      console.log("[HouseExterior] position =", pos);
      navigator.clipboard?.writeText(pos).catch(() => {});
    }),
  });

  const grid = useMemo(() => buildGrid(), []);

  return (
    <group position={[x, 0, z]}>
      {/* Tile grid — shows each 1×1 tile slot */}
      <primitive object={grid} position={[0, 0.003, 0]} />

      {/* Semi-transparent fill */}
      <mesh geometry={fillGeo} material={fillMat} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]} />

      {/* Solid border outline */}
      <mesh geometry={boxGeo} material={boxMat} position={[0, 0.01, 0]} />
    </group>
  );
}
