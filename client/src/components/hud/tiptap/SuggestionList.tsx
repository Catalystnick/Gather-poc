import { forwardRef, useImperativeHandle, useState } from "react";
import type { CSSProperties } from "react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { SuggestionItem } from "./suggestionRenderer";

export interface SuggestionListProps {
  items: SuggestionItem[];
  command: (item: SuggestionItem) => void;
  maxHeight?: number;
}

export interface SuggestionListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

function moveSelection(current: number, total: number, delta: number) {
  if (!total) return 0;
  return (current + delta + total) % total;
}

export const SuggestionList = forwardRef<SuggestionListHandle, SuggestionListProps>(function SuggestionList({ items, command, maxHeight = 180 }, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        if (!items.length) return false;

        if (event.key === "ArrowDown") {
          setSelectedIndex((prev) => moveSelection(prev, items.length, 1));
          return true;
        }

        if (event.key === "ArrowUp") {
          setSelectedIndex((prev) => moveSelection(prev, items.length, -1));
          return true;
        }

        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const item = items[Math.min(selectedIndex, items.length - 1)];
          if (item) command(item);
          return true;
        }

        return false;
      },
    }),
    [items, selectedIndex, command],
  );

  return (
    <div style={{ ...styles.container, maxHeight }}>
      {items.map((item, index) => (
        <button
          key={`${item.title}-${index}`}
          type="button"
          style={{ ...styles.item, ...(index === selectedIndex ? styles.itemSelected : null) }}
          onMouseDown={(event) => {
            event.preventDefault();
            command(item);
          }}
        >
          <span style={styles.left}>{item.title}</span>
          {item.subtitle && <span style={styles.right}>{item.subtitle}</span>}
        </button>
      ))}
    </div>
  );
});

const styles: Record<string, CSSProperties> = {
  container: {
    background: "rgba(18, 18, 18, 0.95)",
    border: "1px solid #323232",
    borderRadius: 8,
    overflowY: "auto",
    minWidth: 220,
    marginBottom: "5px",
  },
  item: {
    width: "100%",
    border: "none",
    background: "transparent",
    color: "#fff",
    display: "flex",
    justifyContent: "space-between",
    textAlign: "left",
    padding: "7px 10px",
    cursor: "pointer",
    fontSize: 12,
  },
  itemSelected: {
    background: "rgba(52,152,219,0.2)",
  },
  left: {
    fontWeight: 600,
  },
  right: {
    color: "#8aaac3",
    fontFamily: "monospace",
    marginLeft: 8,
  },
};
