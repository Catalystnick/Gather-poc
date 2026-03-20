import { useEffect, useMemo, useRef } from "react";
import { useTexture } from "@react-three/drei";
import {
  ClampToEdgeWrapping, Color, MeshBasicMaterial,
  NearestFilter, SRGBColorSpace, type Texture,
} from "three";
import type { Avatar } from "../types";

interface Props {
  avatar: Avatar;
}

/** 512×768 sheet — 8 cols × 12 rows of 64×64 frames. */
const SHEET_COLS = 8;
const SHEET_ROWS = 12;
const PLANE_SIZE = 4.28;

function setupTex(tex: Texture) {
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter  = NearestFilter;
  tex.minFilter  = NearestFilter;
  tex.wrapS      = ClampToEdgeWrapping;
  tex.wrapT      = ClampToEdgeWrapping;
  tex.repeat.set(1 / SHEET_COLS, 1 / SHEET_ROWS);
  // Row 0 of the PNG is the top — UV y=0 is bottom, so offset to top row.
  tex.offset.set(0, (SHEET_ROWS - 1) / SHEET_ROWS);
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

/** A flat layer without colour tinting — used for template and shoes. */
function UntintedLayer({ url, yOffset, order }: {
  url: string; yOffset: number; order: number;
}) {
  const texture = useTexture(url, setupTex);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, yOffset, 0]} renderOrder={order}>
      <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

/** A flat layer with HSV hue-shift tinting — used for shirt and skirt. */
function TintedLayer({ url, color, yOffset, order }: {
  url: string; color: string; yOffset: number; order: number;
}) {
  const texture    = useTexture(url, setupTex);
  const tintUniform = useRef({ value: new Color(color) });

  const material = useMemo(() => {
    const id  = ++_matId;
    const mat = new MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false, toneMapped: false,
    });

    mat.customProgramCacheKey = () => `tinted-layer-${id}`;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tintColor = tintUniform.current;
      shader.fragmentShader =
        `uniform vec3 tintColor;\n${HSV_GLSL}\n` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        /* glsl */`
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D(map, vMapUv);
          vec3 hsv     = rgb2hsv(sampledDiffuseColor.rgb);
          vec3 tintHsv = rgb2hsv(tintColor);
          float shift  = smoothstep(0.12, 0.45, hsv.y);
          hsv.x = mix(hsv.x, tintHsv.x, shift);
          hsv.y = mix(hsv.y, tintHsv.y, shift * 0.8);
          sampledDiffuseColor.rgb = hsv2rgb(hsv);
          diffuseColor *= sampledDiffuseColor;
        #endif
        `
      );
    };
    return mat;
  }, [texture]);

  // Update tint colour without recompiling the shader.
  tintUniform.current.value.set(color);

  useEffect(() => () => { material.dispose(); }, [material]);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, yOffset, 0]} renderOrder={order}>
      <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

export default function AvatarMesh({ avatar }: Props) {
  return (
    <group>
      <UntintedLayer url="/avatars/template.png" yOffset={0}     order={0} />
      <UntintedLayer url="/avatars/shoes.png"    yOffset={0.001} order={1} />
      <TintedLayer   url="/avatars/skirt.png"    yOffset={0.002} order={2} color={avatar.skirt} />
      <TintedLayer   url="/avatars/shirt.png"    yOffset={0.003} order={3} color={avatar.shirt} />
    </group>
  );
}
