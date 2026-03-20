import { Text } from '@react-three/drei'

interface Props {
  name: string
}

export default function PlayerLabel({ name }: Props) {
  return (
    <Text
      position={[0, 0.5, -1.6]}
      rotation={[-Math.PI / 2, 0, 0]}
      fontSize={0.3}
      color="#ffffff"
      anchorX="center"
      anchorY="middle"
      outlineWidth={0.03}
      outlineColor="#000000"
    >
      {name}
    </Text>
  )
}
