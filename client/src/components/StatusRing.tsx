// Renders a flat ring below a player to indicate voice range / speaking state.
// Local player: speaking only (no inRange ring).
// Remote player: blue = in voice range, green = actively speaking.

interface Props {
  speaking?: boolean
  inRange?: boolean
}

export default function StatusRing({ speaking, inRange }: Props) {
  if (!speaking && !inRange) return null

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.48, 0]}>
      <ringGeometry args={[0.58, 0.72, 32]} />
      <meshBasicMaterial
        color={speaking ? '#2ecc71' : '#3498db'}
        transparent
        opacity={speaking ? 0.8 : 0.5}
      />
    </mesh>
  )
}
