import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useKeyboardControls } from '@react-three/drei'
import type { Group } from 'three'
import AvatarMesh from './AvatarMesh'
import type { Player } from '../types'

const SPEED = 5

interface Props {
  player: Player
  onMove: (position: { x: number; y: number; z: number }) => void
  positionRef: React.MutableRefObject<{ x: number; y: number; z: number }>
  isSpeaking?: boolean
}

export default function LocalPlayer({ player, onMove, positionRef, isSpeaking }: Props) {
  const ref = useRef<Group>(null)
  const lastEmit = useRef(0)
  const [, getKeys] = useKeyboardControls()

  useFrame((_, delta) => {
    if (!ref.current) return
    const { forward, backward, left, right } = getKeys()

    const dx = (right ? 1 : 0) - (left ? 1 : 0)
    const dz = (backward ? 1 : 0) - (forward ? 1 : 0)

    ref.current.position.x += dx * SPEED * delta
    ref.current.position.z += dz * SPEED * delta

    const { x, y, z } = ref.current.position

    // Keep shared ref in sync for proximity voice
    positionRef.current = { x, y, z }

    // Throttle emit to ~20Hz
    const now = performance.now()
    if (now - lastEmit.current > 50) {
      lastEmit.current = now
      onMove({ x, y, z })
    }
  })

  return (
    <group ref={ref} position={[0, 0.5, 0]}>
      <AvatarMesh avatar={player.avatar} />
      {isSpeaking && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.48, 0]}>
          <ringGeometry args={[0.58, 0.72, 32]} />
          <meshBasicMaterial color="#2ecc71" transparent opacity={0.8} />
        </mesh>
      )}
    </group>
  )
}
