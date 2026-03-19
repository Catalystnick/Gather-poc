import { Canvas } from '@react-three/fiber'
import { Grid, Environment, OrbitControls, KeyboardControls } from '@react-three/drei'
import LocalPlayer from './LocalPlayer'
import RemotePlayer from './RemotePlayer'
import { useSocket } from '../hooks/useSocket'
import type { Player } from '../App'

const keyMap = [
  { name: 'forward',  keys: ['ArrowUp',    'KeyW'] },
  { name: 'backward', keys: ['ArrowDown',  'KeyS'] },
  { name: 'left',     keys: ['ArrowLeft',  'KeyA'] },
  { name: 'right',    keys: ['ArrowRight', 'KeyD'] },
]

interface Props {
  player: Player
}

export default function World({ player }: Props) {
  const { remotePlayers, emitMove } = useSocket(player)

  return (
    <KeyboardControls map={keyMap}>
      <Canvas camera={{ position: [0, 8, 12], fov: 60 }}>
        <Environment preset="city" />
        <Grid
          infiniteGrid
          cellSize={1}
          cellThickness={0.5}
          sectionSize={5}
          sectionThickness={1}
          fadeDistance={50}
        />
        <LocalPlayer player={player} onMove={emitMove} />
        {Array.from(remotePlayers.values()).map(p => (
          <RemotePlayer key={p.id} {...p} />
        ))}
        <OrbitControls makeDefault />
      </Canvas>
    </KeyboardControls>
  )
}
