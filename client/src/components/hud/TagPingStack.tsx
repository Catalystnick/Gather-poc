import HUDPanel from './HUDPanel'
import type { TagIncoming } from '../../chat/types'

interface Props {
  pings: TagIncoming[]
  onDismiss: (id: string) => void
}

export default function TagPingStack({ pings, onDismiss }: Props) {
  if (!pings.length) return null

  return (
    <HUDPanel style={styles.position}>
      <div style={styles.wrapper}>
        {pings.map((ping) => (
          <div key={ping.id} style={styles.card}>
            <div style={styles.header}>
              <span style={styles.badge}>TAG</span>
              <button type="button" style={styles.close} onClick={() => onDismiss(ping.id)}>x</button>
            </div>
            <div style={styles.title}>{ping.fromName} tagged you</div>
            <div style={styles.body}>{ping.message}</div>
          </div>
        ))}
      </div>
    </HUDPanel>
  )
}

const styles: Record<string, React.CSSProperties> = {
  position: {
    top: 20,
    right: 20,
    width: 300,
    zIndex: 25,
  },
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  card: {
    border: '1px solid rgba(241, 196, 15, 0.45)',
    borderRadius: 8,
    padding: 10,
    background: 'rgba(30, 24, 6, 0.88)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  badge: {
    fontSize: 11,
    fontWeight: 800,
    color: '#f1c40f',
    letterSpacing: 0.5,
  },
  close: {
    border: 'none',
    background: 'transparent',
    color: '#bbb',
    cursor: 'pointer',
    fontSize: 12,
  },
  title: {
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
  },
  body: {
    marginTop: 4,
    color: '#e9e9e9',
    fontSize: 12,
    lineHeight: 1.4,
    whiteSpace: 'pre-wrap',
  },
}
