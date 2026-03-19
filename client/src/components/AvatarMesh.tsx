import { Capsule, Box, Sphere } from '@react-three/drei'
import type { Avatar } from '../types'

interface Props {
  avatar: Avatar
}

export default function AvatarMesh({ avatar }: Props) {
  const material = <meshStandardMaterial color={avatar.color} />

  if (avatar.shape === 'box') {
    return <Box args={[0.6, 1, 0.6]}>{material}</Box>
  }

  if (avatar.shape === 'sphere') {
    return <Sphere args={[0.5, 16, 16]}>{material}</Sphere>
  }

  // default: capsule
  return <Capsule args={[0.3, 0.6, 8, 16]}>{material}</Capsule>
}
