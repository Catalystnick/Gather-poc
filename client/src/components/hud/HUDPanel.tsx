// Shared fixed dark-glass overlay panel used by ChatPanel, VoiceConnectionsPanel, etc.
// Pass positional/layout overrides via the `style` prop.

interface Props {
  children: React.ReactNode
  style?: React.CSSProperties
}

export default function HUDPanel({ children, style }: Props) {
  return (
    <div style={{ ...panelBase, ...style }}>
      {children}
    </div>
  )
}

const panelBase: React.CSSProperties = {
  position: 'fixed',
  width: 280,
  background: 'rgba(0,0,0,0.72)',
  border: '1px solid #3a3a3a',
  borderRadius: 10,
  zIndex: 10,
}
