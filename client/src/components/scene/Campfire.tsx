import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'

const FRAMES = 6
const FPS = 8
// 32px per tile, 2× upscale — each frame is 32×32px
const SIZE = (32 / 32) * 2

export default function Campfire() {
  const tex = useTexture('/floor map/3 Animated Objects/2 Campfire/2.png')

  // Clone so we can mutate offset without affecting other users of the texture
  const sprite = useMemo(() => {
    const t = tex.clone()
    t.colorSpace = THREE.SRGBColorSpace
    t.magFilter = THREE.NearestFilter
    t.minFilter = THREE.NearestFilter
    t.repeat.set(1 / FRAMES, 1)
    t.offset.set(0, 0)
    t.needsUpdate = true
    return t
  }, [tex])

  const elapsed = useRef(0)
  const frame = useRef(0)

  useFrame((_, delta) => {
    elapsed.current += delta
    if (elapsed.current >= 1 / FPS) {
      elapsed.current -= 1 / FPS
      frame.current = (frame.current + 1) % FRAMES
      sprite.offset.x = frame.current / FRAMES
    }
  })

  return (
    <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[SIZE, SIZE]} />
      <meshBasicMaterial map={sprite} transparent alphaTest={0.1} />
    </mesh>
  )
}
