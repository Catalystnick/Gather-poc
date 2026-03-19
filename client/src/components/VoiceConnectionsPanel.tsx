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
    <div style={styles.panel}>
      <div style={styles.title}>Voice links (this device)</div>
      {rows.length === 0 ? (
        <div style={styles.empty}>No remote players</div>
      ) : (
        rows.map((row) => (
          <div key={row.id} style={styles.row}>
            <span style={styles.name}>You ↔ {row.name}</span>
            <span style={stateStyle(row.state, row.connected)}>
              {row.speaking ? `${row.state} • speaking` : row.state}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    top: 16,
    right: 16,
    width: 280,
    maxHeight: 220,
    overflowY: 'auto',
    background: 'rgba(0,0,0,0.72)',
    border: '1px solid #3a3a3a',
    borderRadius: 10,
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    zIndex: 10,
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

function stateStyle(state: string, connected: boolean): React.CSSProperties {
  const color =
    state === 'connected' || connected ? '#2ecc71'
      : state === 'connecting' ? '#f1c40f'
      : state === 'disconnected' ? '#e67e22'
      : state === 'failed' ? '#e74c3c'
      : '#b8b8b8'

  return {
    fontSize: 11,
    color,
  }
}
