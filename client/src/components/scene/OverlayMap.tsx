import { useRef, useMemo, useEffect } from "react";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { ROAD_STONES_MAP } from "../../data/worldMap";
import { tileUV } from "../../utils/tileUV";

// Summer plains tileset — 13 cols × 12 rows, 32×32 px tiles, atlas 416×384 px.
const ATLAS_COLS = 13;
const ATLAS_ROWS = 12;

const COLS = 60;
const ROWS = 60;
const TILE_SIZE = 1;
const TOTAL = COLS * ROWS;

const OX = -(COLS * TILE_SIZE) / 2;
const OZ = -(ROWS * TILE_SIZE) / 2;

// Pre-compute world-space centre for each tile — same layout as FloorMap.
const POSITIONS = new Float32Array(TOTAL * 2);
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c;
    POSITIONS[i * 2] = OX + c * TILE_SIZE + TILE_SIZE / 2;
    POSITIONS[i * 2 + 1] = OZ + r * TILE_SIZE + TILE_SIZE / 2;
  }
}

// UV repeat per tile = 1 / atlas dimension.
const REPEAT_U = (1 / ATLAS_COLS).toFixed(8);
const REPEAT_V = (1 / ATLAS_ROWS).toFixed(8);

// Build the per-instance UV offset array.
// Tiles with ID 0 (empty) get offsetU=1.0 (off-atlas → transparent via alphaTest).
function buildUVArray(): Float32Array {
  const uvs = new Float32Array(TOTAL * 2);
  for (let i = 0; i < TOTAL; i++) {
    const id = ROAD_STONES_MAP[i];
    if (id === 0) {
      // Push the UV off the atlas so the fragment is fully transparent.
      uvs[i * 2] = 1.0;
      uvs[i * 2 + 1] = 1.0;
    } else {
      const { offsetU, offsetV } = tileUV(id, ATLAS_COLS, ATLAS_ROWS);
      uvs[i * 2] = offsetU;
      uvs[i * 2 + 1] = offsetV;
    }
  }
  return uvs;
}

// ─── Shader ───────────────────────────────────────────────────────────────────
// Same instanced-UV approach as FloorMap, but with alpha discard for empty tiles.
const VERT = /* glsl */ `
  attribute vec2 uvOffset;
  varying vec2 vUv;

  void main() {
    vec2 tileUV = position.xy + vec2(0.5);
    vUv = tileUV * vec2(${REPEAT_U}, ${REPEAT_V}) + uvOffset;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;

  void main() {
    vec4 color = texture2D(map, vUv);
    if (color.a < 0.1) discard;
    gl_FragColor = color;
  }
`;

const _dummy = new THREE.Object3D();
_dummy.rotation.x = -Math.PI / 2;

export default function OverlayMap() {
  const tex = useTexture("/floor-map/summer/tiles.png");
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const atlas = useMemo(() => {
    const t = tex.clone();
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }, [tex]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { map: { value: atlas } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      }),
    [atlas],
  );

  // Write instance matrices once — positions never change.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < TOTAL; i++) {
      _dummy.position.set(POSITIONS[i * 2], 0.005, POSITIONS[i * 2 + 1]);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  // Write per-instance UV offsets.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const attr = new THREE.InstancedBufferAttribute(buildUVArray(), 2);
    mesh.geometry.setAttribute("uvOffset", attr);
  }, []);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, TOTAL]} material={material} frustumCulled={false} renderOrder={1}>
      <planeGeometry args={[TILE_SIZE, TILE_SIZE]} />
    </instancedMesh>
  );
}
