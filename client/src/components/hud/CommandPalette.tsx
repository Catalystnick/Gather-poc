import type React from 'react'

export interface CommandOption {
  command: string
  description: string
}

interface Props {
  visible: boolean
  options: CommandOption[]
  selectedIndex: number
  onSelect: (command: string) => void
}

export default function CommandPalette({ visible, options, selectedIndex, onSelect }: Props) {
  if (!visible || !options.length) return null

  return (
    <div style={styles.container}>
      {options.map((option, index) => {
        const selected = index === selectedIndex
        return (
          <button
            key={option.command}
            type="button"
            style={{ ...styles.item, ...(selected ? styles.itemSelected : null) }}
            onMouseDown={event => {
              event.preventDefault()
              onSelect(option.command)
            }}
          >
            <span style={styles.command}>{option.command}</span>
            <span style={styles.description}>{option.description}</span>
          </button>
        )
      })}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 38,
    background: 'rgba(20, 20, 20, 0.95)',
    border: '1px solid #3a3a3a',
    borderRadius: 8,
    overflow: 'hidden',
    zIndex: 41,
  },
  item: {
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    color: '#f6f6f6',
    border: 'none',
    padding: '8px 10px',
    display: 'flex',
    justifyContent: 'space-between',
    cursor: 'pointer',
    fontSize: 12,
  },
  itemSelected: {
    background: 'rgba(52, 152, 219, 0.2)',
  },
  command: {
    fontWeight: 700,
    marginRight: 10,
  },
  description: {
    color: '#bbb',
  },
}
