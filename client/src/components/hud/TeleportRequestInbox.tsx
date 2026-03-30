import HUDPanel from './HUDPanel'
import type { TeleportIncomingRequest } from '../../chat/types'

interface Props {
  requests: TeleportIncomingRequest[]
  onRespond: (requestId: string, decision: 'accept' | 'decline') => void
}

export default function TeleportRequestInbox({ requests, onRespond }: Props) {
  if (!requests.length) return null

  return (
    <HUDPanel style={styles.position}>
      <div style={styles.wrapper}>
        {requests.map(request => (
          <div key={request.requestId} style={styles.card}>
            <div style={styles.title}>{request.fromName} requested a teleport</div>
            <div style={styles.body}>{request.message}</div>
            <div style={styles.actions}>
              <button style={{ ...styles.button, ...styles.accept }} onClick={() => onRespond(request.requestId, 'accept')}>
                Yes
              </button>
              <button style={{ ...styles.button, ...styles.decline }} onClick={() => onRespond(request.requestId, 'decline')}>
                No
              </button>
            </div>
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
    width: 320,
  },
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  card: {
    border: '1px solid #2f2f2f',
    borderRadius: 8,
    padding: 10,
    background: 'rgba(15,15,15,0.9)',
  },
  title: {
    fontWeight: 700,
    fontSize: 13,
    color: '#fff',
  },
  body: {
    marginTop: 6,
    color: '#d9d9d9',
    fontSize: 12,
    lineHeight: 1.4,
    whiteSpace: 'pre-wrap',
  },
  actions: {
    marginTop: 8,
    display: 'flex',
    gap: 8,
  },
  button: {
    border: 'none',
    borderRadius: 6,
    padding: '6px 10px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
  },
  accept: {
    background: '#1f9d55',
  },
  decline: {
    background: '#c0392b',
  },
}
