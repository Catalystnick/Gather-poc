import { useEffect, useMemo, useRef } from "react";
import { Box, Sphere, useTexture } from "@react-three/drei";
import { ClampToEdgeWrapping, Color, MeshBasicMaterial, NearestFilter, SRGBColorSpace } from "three";
import type { Avatar } from "../types";

interface Props {
  avatar: Avatar;
}

/** Idle PNG is 768×256px → 12×4 grid of 64×64 frames. */
const SWORDSMAN_IDLE_COLS = 12;
const SWORDSMAN_IDLE_ROWS = 4;
/** XZ plane size in world units (matches scale of box/sphere avatars better). */
const SWORDSMAN_PLANE_SIZE = 4.28;

/** HSV conversion helpers injected into the fragment shader. */
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

/** Each instance needs its own program so per-player tint uniforms don't stomp each other. */
let _matId = 0;

function SwordsmanPlane({ color }: { color: string }) {
  const texture = useTexture("/avatars/swordsman-idle.png", (tex) => {
    tex.colorSpace = SRGBColorSpace;
    tex.magFilter = NearestFilter;
    tex.minFilter = NearestFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.repeat.set(1 / SWORDSMAN_IDLE_COLS, 1 / SWORDSMAN_IDLE_ROWS);
    tex.offset.set(0, (SWORDSMAN_IDLE_ROWS - 1) / SWORDSMAN_IDLE_ROWS);
  });

  // Uniform object shared by reference — update .value to retint without recompile.
  const tintUniform = useRef({ value: new Color(color) });

  const material = useMemo(() => {
    const id = ++_matId;
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });

    // Unique key per instance so players with different colors each get their own
    // WebGL program and uniforms don't bleed across instances.
    mat.customProgramCacheKey = () => `swordsman-tint-${id}`;

    mat.onBeforeCompile = (shader) => {
      // Bind this instance's uniform into the program.
      shader.uniforms.tintColor = tintUniform.current;

      // Prepend helpers before the existing fragment shader.
      shader.fragmentShader =
        `uniform vec3 tintColor;\n${HSV_GLSL}\n` + shader.fragmentShader;

      // Replace the standard map sampling chunk with our tinted version.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        /* glsl */`
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D(map, vMapUv);

          vec3 hsv     = rgb2hsv(sampledDiffuseColor.rgb);
          vec3 tintHsv = rgb2hsv(tintColor);

          // shift = 0 for near-grey pixels (linework, shadows) → they are untouched.
          // shift = 1 for fully-saturated pixels → full hue replacement.
          float shift = smoothstep(0.12, 0.45, hsv.y);
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

  // Reactively update the tint — no shader recompile needed, just a uniform upload.
  tintUniform.current.value.set(color);

  // Dispose material when component unmounts.
  useEffect(() => () => { material.dispose(); }, [material]);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[SWORDSMAN_PLANE_SIZE, SWORDSMAN_PLANE_SIZE]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

export default function AvatarMesh({ avatar }: Props) {
  const material = <meshStandardMaterial color={avatar.color} />;

  if (avatar.shape === "swordsman") {
    return <SwordsmanPlane color={avatar.color} />;
  }

  if (avatar.shape === "box") {
    return <Box args={[0.6, 1, 0.6]}>{material}</Box>;
  }

  if (avatar.shape === "sphere") {
    return <Sphere args={[0.5, 16, 16]}>{material}</Sphere>;
  }

  return null;
}
