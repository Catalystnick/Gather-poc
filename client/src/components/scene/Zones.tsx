import * as THREE from 'three'
import { useControls, button } from 'leva'
import { Html } from '@react-three/drei'
import { WORLD_ZONES, ZONE_PREFETCH_TRIGGERS } from '../../data/worldMap'

// Static zone definitions — colour and label live here, position/size in worldMap.ts.
// Default positions align with the fence thirds (COLS=60 → thirds at X ±10).
const ZONE_DEFS = [
  { key: 'dev',    label: 'Dev',    color: '#3b82f6', defaultX: -20, defaultZ: 0, defaultW: 20, defaultH: 60 },
  { key: 'design', label: 'Design', color: '#a855f7', defaultX:   0, defaultZ: 0, defaultW: 20, defaultH: 60 },
  { key: 'game',   label: 'Game',   color: '#22c55e', defaultX:  20, defaultZ: 0, defaultW: 20, defaultH: 60 },
]

interface ZoneDef {
  key: string
  label: string
  color: string
  defaultX: number
  defaultZ: number
  defaultW: number
  defaultH: number
}

// Returns the saved value for a zone field, falling back to the built-in default.
function saved(key: string, field: 'x' | 'z' | 'width' | 'depth', fallback: number): number {
  return WORLD_ZONES?.find(z => z.key === key)?.[field] ?? fallback
}

function Zone({ def }: { def: ZoneDef }) {
  const folder = `Zone: ${def.label}`

  const { x, z, width, height } = useControls(folder, {
    x:      { value: saved(def.key, 'x',      def.defaultX), min: -30, max: 30, step: 0.5, label: 'X' },
    z:      { value: saved(def.key, 'z',      def.defaultZ), min: -30, max: 30, step: 0.5, label: 'Z' },
    width:  { value: saved(def.key, 'width',  def.defaultW), min: 2,   max: 60, step: 1,   label: 'Width (tiles)'  },
    height: { value: saved(def.key, 'depth',  def.defaultH), min: 2,   max: 60, step: 1,   label: 'Depth (tiles)' },
    Copy: button((get) => {
      const snap =
        `{ x: ${get(`${folder}.x`)}, z: ${get(`${folder}.z`)}, ` +
        `width: ${get(`${folder}.width`)}, height: ${get(`${folder}.height`)} }`
      navigator.clipboard?.writeText(snap).catch(() => {})
    }),
  })

  return (
    <group position={[x, 0, z]}>
      {/* Colored fill — sits just above the floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          color={def.color}
          transparent
          opacity={0.15}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Thin wireframe border box */}
      <mesh position={[0, 0.01, 0]}>
        <boxGeometry args={[width, 0.02, height]} />
        <meshBasicMaterial color={def.color} wireframe />
      </mesh>

      {/* HTML label — always screen-facing, centered on the zone */}
      <Html center position={[0, 0.05, 0]}>
        <div
          style={{
            color: def.color,
            fontSize: '13px',
            fontWeight: 700,
            fontFamily: 'monospace',
            textShadow: '0 1px 4px #000, 0 0 8px #000',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          {def.label}
        </div>
      </Html>
    </group>
  )
}

// Visual overlay for ZONE_PREFETCH_TRIGGERS — dev only.
// Renders as an orange-tinted strip to distinguish from zone fills.
function PrefetchTriggers() {
  return (
    <>
      {ZONE_PREFETCH_TRIGGERS.map((t) => {
        const cx = (t.xMin + t.xMax) / 2
        const cz = (t.zMin + t.zMax) / 2
        const w  = t.xMax - t.xMin
        const d  = t.zMax - t.zMin
        const color = ZONE_DEFS.find(z => z.key === t.zoneKey)?.color ?? '#f59e0b'
        return (
          <group key={t.zoneKey} position={[cx, 0, cz]}>
            {/* Fill */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0]}>
              <planeGeometry args={[w, d]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={0.25}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
            {/* Border */}
            <mesh position={[0, 0.012, 0]}>
              <boxGeometry args={[w, 0.02, d]} />
              <meshBasicMaterial color={color} wireframe />
            </mesh>
            <Html center position={[0, 0.05, 0]}>
              <div style={{
                color,
                fontSize: '10px',
                fontWeight: 600,
                fontFamily: 'monospace',
                opacity: 0.85,
                textShadow: '0 1px 3px #000',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                userSelect: 'none',
              }}>
                ⚡ {t.zoneKey} prefetch
              </div>
            </Html>
          </group>
        )
      })}
    </>
  )
}

export default function Zones() {
  return (
    <>
      {ZONE_DEFS.map((def) => (
        <Zone key={def.key} def={def} />
      ))}
      <PrefetchTriggers />
    </>
  )
}
