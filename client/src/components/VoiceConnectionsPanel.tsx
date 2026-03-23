import HUDPanel from './HUDPanel'

interface ConnectionRow {
  id: string
  name: string
  connected: boolean
  speaking: boolean
  state: string
}

interface Props {
  rows: ConnectionRow[]
}

export default function VoiceConnectionsPanel({ rows }: Props) {
  return (
    <HUDPanel style={styles.position}>
      <div style={styles.title}>Voice links (this device)</div>
      {rows.length === 0 ? (
        <div style={styles.empty}>No remote players</div>
      ) : (
        rows.map((row) => (
          <div key={row.id} style={styles.row}>
            <span style={styles.name}>You ↔ {row.name}</span>
            <ConnectionStatus state={row.state} connected={row.connected} speaking={row.speaking} />
          </div>
        ))
      )}
    </HUDPanel>
  )
}

interface ConnectionStatusProps {
  state: string
  connected: boolean
  speaking: boolean
}

function ConnectionStatus({ state, connected, speaking }: ConnectionStatusProps) {
  const color =
    state === 'connected' || connected ? '#2ecc71'
      : state === 'connecting' ? '#f1c40f'
      : state === 'disconnected' ? '#e67e22'
      : state === 'failed' ? '#e74c3c'
      : '#b8b8b8'

  return (
    <span style={{ fontSize: 11, color }}>
      {speaking ? `${state} • speaking` : state}
    </span>
  )
}

const styles: Record<string, React.CSSProperties> = {
  position: {
    top: 16,
    right: 16,
    maxHeight: 220,
    overflowY: 'auto',
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  title: {
    fontSize: 12,
    color: '#9ecbff',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  empty: {
    fontSize: 12,
    color: '#bbb',
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    paddingBottom: 6,
    borderBottom: '1px solid #2f2f2f',
  },
  name: {
    fontSize: 13,
    color: '#fff',
  },
}
