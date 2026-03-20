import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import {
  ClampToEdgeWrapping, Color, MeshBasicMaterial,
  NearestFilter, SRGBColorSpace, Vector2,
} from "three";
import type { Avatar, Direction } from "../types";

interface Props {
  avatar:       Avatar;
  directionRef?: React.MutableRefObject<Direction>;
  isMovingRef?:  React.MutableRefObject<boolean>;
}

const SHEET_COLS = 8;
const SHEET_ROWS = 12;
const PLANE_SIZE = 4.28;
const IDLE_FPS   = 6;
const WALK_FPS   = 10;

// Template / skirt / shoes share this layout (one direction per row).
const IDLE: Record<Direction, { row: number; count: number }> = {
  down:  { row: 0, count: 4 },
  up:    { row: 1, count: 4 },
  right: { row: 2, count: 4 },
  left:  { row: 3, count: 4 },
};
const WALK: Record<Direction, { row: number; count: number }> = {
  down:  { row: 4, count: 8 },
  up:    { row: 5, count: 8 },
  right: { row: 6, count: 8 },
  left:  { row: 7, count: 8 },
};

// ShirtRed uses a different layout: groups by direction (idle, walk, hurt per direction).
// direction index: down=0, up=1, right=2, left=3
// shirt row = directionIndex * 3 + animType (0=idle, 1=walk)
function shirtRowFor(templateRow: number): number {
  const dirIdx = templateRow % 4;   // 0-3 → same for idle and walk
  const type   = templateRow < 4 ? 0 : 1; // idle=0, walk=1
  return dirIdx * 3 + type;
}

const HSV_GLSL = /* glsl */`
  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
`;

let _matId = 0;

export default function AvatarMesh({ avatar, directionRef, isMovingRef }: Props) {
  // All 4 textures loaded once — shared across instances (drei cache).
  // No offset/repeat set here; frame selection is done via uvOffset uniform.
  const [templateTex, shoesTex, skirtTex, shirtTex] = useTexture(
    ['/avatars/template.png', '/avatars/shoes.png', '/avatars/skirt.png', '/avatars/shirt.png'],
    (textures) => {
      for (const tex of textures) {
        tex.colorSpace = SRGBColorSpace;
        tex.magFilter  = NearestFilter;
        tex.minFilter  = NearestFilter;
        tex.wrapS      = ClampToEdgeWrapping;
        tex.wrapT      = ClampToEdgeWrapping;
      }
    }
  );

  // Per-instance uniforms — never shared between players.
  const shirtTintU      = useRef({ value: new Color(avatar.shirt) });
  const skirtTintU      = useRef({ value: new Color(avatar.skirt) });
  const uvOffsetU       = useRef({ value: new Vector2(0, (SHEET_ROWS - 1) / SHEET_ROWS) });
  // Shirt has a different row layout; needs its own UV row offset.
  const uvOffsetShirtU  = useRef({ value: new Vector2(0, (SHEET_ROWS - 1) / SHEET_ROWS) });

  const material = useMemo(() => {
    const id  = ++_matId;
    const mat = new MeshBasicMaterial({
      map: templateTex, transparent: true, depthWrite: false, toneMapped: false,
    });

    // Unique key per instance so each player compiles its own program
    // and owns its uniform values.
    mat.customProgramCacheKey = () => `character-${id}`;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.shoesMap      = { value: shoesTex };
      shader.uniforms.skirtMap      = { value: skirtTex };
      shader.uniforms.shirtMap      = { value: shirtTex };
      shader.uniforms.shirtTint     = shirtTintU.current;
      shader.uniforms.skirtTint     = skirtTintU.current;
      shader.uniforms.uvOffset      = uvOffsetU.current;
      shader.uniforms.uvOffsetShirt = uvOffsetShirtU.current;

      // Prepend helpers + extra uniforms before the existing fragment shader.
      shader.fragmentShader = /* glsl */`
        uniform sampler2D shoesMap;
        uniform sampler2D skirtMap;
        uniform sampler2D shirtMap;
        uniform vec3      shirtTint;
        uniform vec3      skirtTint;
        uniform vec2      uvOffset;
        uniform vec2      uvOffsetShirt;

        ${HSV_GLSL}

        vec3 applyTint(vec3 rgb, vec3 tint) {
          vec3  hsv = rgb2hsv(rgb);
          vec3  th  = rgb2hsv(tint);
          float s   = smoothstep(0.12, 0.45, hsv.y);
          hsv.x = mix(hsv.x, th.x, s);
          hsv.y = mix(hsv.y, th.y, s * 0.8);
          return hsv2rgb(hsv);
        }

        // Porter-Duff "over": composite src on top of dst.
        vec4 over(vec4 dst, vec4 src) {
          float a   = src.a + dst.a * (1.0 - src.a);
          vec3  rgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a))
                      / max(a, 0.001);
          return vec4(rgb, a);
        }
      ` + shader.fragmentShader;

      // Replace the standard map sample with a 4-layer composite.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        /* glsl */`
        #ifdef USE_MAP
          // vMapUv is raw geometry UV (0–1) because we set no offset/repeat.
          // Scale to one frame then shift to the current animation frame.
          vec2 fuv      = vMapUv / vec2(${SHEET_COLS}.0, ${SHEET_ROWS}.0) + uvOffset;
          // Shirt has a different row layout; use its own row offset but same column.
          vec2 shirtFuv = vec2(fuv.x, vMapUv.y / float(${SHEET_ROWS}) + uvOffsetShirt.y);

          // Composite layers bottom → top.
          vec4 col = texture2D(map, fuv);

          col = over(col, texture2D(shoesMap, fuv));

          vec4 skirtPx = texture2D(skirtMap, fuv);
          if (skirtPx.a > 0.01) skirtPx.rgb = applyTint(skirtPx.rgb, skirtTint);
          col = over(col, skirtPx);

          vec4 shirtPx = texture2D(shirtMap, shirtFuv);
          if (shirtPx.a > 0.01) shirtPx.rgb = applyTint(shirtPx.rgb, shirtTint);
          col = over(col, shirtPx);

          if (col.a < 0.01) discard;

          diffuseColor = col;
        #endif
        `
      );
    };

    return mat;
  }, [templateTex, shoesTex, skirtTex, shirtTex]);

  // Reactively update tint uniforms without recompiling.
  shirtTintU.current.value.set(avatar.shirt);
  skirtTintU.current.value.set(avatar.skirt);

  useEffect(() => () => { material.dispose(); }, [material]);

  // ── Animation ──────────────────────────────────────────────────────────────
  const frameRef = useRef(0);
  const elapsed  = useRef(0);
  const lastRow  = useRef(IDLE.down.row);

  useFrame((_, delta) => {
    const direction = directionRef?.current ?? 'down';
    const isMoving  = isMovingRef?.current  ?? false;
    const anim      = isMoving ? WALK[direction] : IDLE[direction];
    const fps       = isMoving ? WALK_FPS : IDLE_FPS;

    if (lastRow.current !== anim.row) {
      lastRow.current  = anim.row;
      frameRef.current = 0;
      elapsed.current  = 0;
    }

    elapsed.current += delta;
    if (elapsed.current >= 1 / fps) {
      elapsed.current -= 1 / fps;
      frameRef.current = (frameRef.current + 1) % anim.count;
    }

    uvOffsetU.current.value.set(
      frameRef.current / SHEET_COLS,
      (SHEET_ROWS - 1 - anim.row) / SHEET_ROWS,
    );

    const sRow = shirtRowFor(anim.row);
    uvOffsetShirtU.current.value.y = (SHEET_ROWS - 1 - sRow) / SHEET_ROWS;
  });

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
