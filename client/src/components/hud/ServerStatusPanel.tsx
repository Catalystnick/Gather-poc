import HUDPanel from './HUDPanel'
import type { VoiceMode } from '../../hooks/useVoice'

interface Props {
  socketStatus: 'connecting' | 'connected' | 'disconnected' | 'error'
  socketId?: string
  lastDisconnectReason?: string | null
  lastError?: string | null
  voiceMode: VoiceMode
  activeZoneKey: string | null
  proximityRoomReady?: boolean
}

export default function ServerStatusPanel({
  socketStatus,
  socketId,
  lastDisconnectReason,
  lastError,
  voiceMode,
  activeZoneKey,
  proximityRoomReady,
}: Props) {
  const socketColor =
    socketStatus === 'connected' ? '#2ecc71'
      : socketStatus === 'connecting' ? '#f1c40f'
      : socketStatus === 'error' ? '#e74c3c'
      : '#e67e22'

  const livekitColor =
    proximityRoomReady ? '#2ecc71' : '#f1c40f'

  return (
    <HUDPanel style={styles.position}>
      <div style={styles.title}>Connectivity</div>

      <div style={styles.section}>
        <div style={styles.row}>
          <span style={styles.label}>Game server</span>
          <span style={{ ...styles.value, color: socketColor }}>
            {socketStatus}
          </span>
        </div>
        <div style={styles.subRow}>
          <span style={styles.subLabel}>socket id</span>
          <span style={styles.subValue}>{socketId ?? '—'}</span>
        </div>
        {socketStatus === 'disconnected' && lastDisconnectReason && (
          <div style={styles.subRow}>
            <span style={styles.subLabel}>reason</span>
            <span style={styles.subValue}>{lastDisconnectReason}</span>
          </div>
        )}
        {socketStatus === 'error' && lastError && (
          <div style={styles.subRow}>
            <span style={styles.subLabel}>error</span>
            <span style={styles.subValue}>{lastError}</span>
          </div>
        )}
      </div>

      <div style={styles.section}>
        <div style={styles.row}>
          <span style={styles.label}>Voice (LiveKit)</span>
          <span style={{ ...styles.value, color: livekitColor }}>
            {proximityRoomReady ? 'ready' : 'connecting'}
          </span>
        </div>
        <div style={styles.subRow}>
          <span style={styles.subLabel}>mode</span>
          <span style={styles.subValue}>
            {voiceMode === 'zone' && activeZoneKey ? `zone:${activeZoneKey}` : voiceMode}
          </span>
        </div>
      </div>
    </HUDPanel>
  )
}

const styles: Record<string, React.CSSProperties> = {
  position: {
    top: 16,
    left: 16,
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    maxWidth: 340,
  },
  title: {
    fontSize: 12,
    color: '#9ecbff',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    paddingBottom: 8,
    borderBottom: '1px solid #2f2f2f',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 10,
  },
  label: {
    fontSize: 13,
    color: '#fff',
    fontWeight: 600,
  },
  value: {
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
  },
  subRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
  },
  subLabel: {
    fontSize: 11,
    color: '#aaa',
  },
  subValue: {
    fontSize: 11,
    color: '#ddd',
    textAlign: 'right' as const,
    wordBreak: 'break-word' as const,
  },
}

