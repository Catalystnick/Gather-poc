// Reusable colour swatch grid. Renders a row of clickable colour buttons
// with a selection ring on the active colour.

export const DEFAULT_PALETTE = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#ecf0f1',
]

interface Props {
  value: string
  onChange: (color: string) => void
  colors?: string[]
}

export default function ColorPicker({ value, onChange, colors = DEFAULT_PALETTE }: Props) {
  return (
    <div style={styles.grid}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          style={{
            ...styles.swatch,
            background: c,
            boxShadow: value === c ? `0 0 0 2px #1a1a1a, 0 0 0 4px ${c}` : 'none',
            transform: value === c ? 'scale(1.08)' : 'scale(1)',
          }}
        />
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8,
  },
  swatch: {
    aspectRatio: '1',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    transition: 'transform 0.1s, box-shadow 0.1s',
  },
}
