import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { Vector3, type Group } from 'three'
import AvatarMesh from './AvatarMesh'
import type { Avatar } from '../App'

interface Props {
  id: string
  name: string
  avatar: Avatar
  position: { x: number; y: number; z: number }
}

const target = new Vector3()

export default function RemotePlayer({ name, avatar, position }: Props) {
  const ref = useRef<Group>(null)

  useFrame(() => {
    if (!ref.current) return
    target.set(position.x, position.y, position.z)
    ref.current.position.lerp(target, 0.15)
  })

  return (
    <group ref={ref} position={[position.x, position.y, position.z]}>
      <AvatarMesh avatar={avatar} />
      <Text
        position={[0, 1.4, 0]}
        fontSize={0.25}
        color="#ffffff"
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {name}
      </Text>
    </group>
  )
}
