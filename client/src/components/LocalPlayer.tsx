import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useKeyboardControls } from '@react-three/drei'
import type { Group } from 'three'
import AvatarMesh from './AvatarMesh'
import type { Player } from '../App'

const SPEED = 5

interface Props {
  player: Player
  onMove: (position: { x: number; y: number; z: number }) => void
}

export default function LocalPlayer({ player, onMove }: Props) {
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

    // throttle emit to ~20Hz
    const now = performance.now()
    if (now - lastEmit.current > 50) {
      lastEmit.current = now
      const { x, y, z } = ref.current.position
      onMove({ x, y, z })
    }
  })

  return (
    <group ref={ref} position={[0, 0.5, 0]}>
      <AvatarMesh avatar={player.avatar} />
    </group>
  )
}
