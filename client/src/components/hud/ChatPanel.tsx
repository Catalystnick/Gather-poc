import { useEffect, useRef, useState } from "react";
import HUDPanel from "./HUDPanel";
import type { ChatMessage } from "../../types";
import type { CommandStatus, MentionSuggestion } from "../../chat/types";

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  commandStatus: CommandStatus | null;
  onDismissStatus: () => void;
  mentionSuggestions: MentionSuggestion[];
}

function getLastToken(input: string) {
  const parts = input.trimEnd().split(/\s+/);
  return parts[parts.length - 1] ?? "";
}

/** Simplified chat HUD panel with command and mention popups. */
export default function ChatPanel({ messages, onSend, commandStatus, onDismissStatus, mentionSuggestions }: Props) {
  const [input, setInput] = useState("");
  const [hideCommandList, setHideCommandList] = useState(false);
  const [hideMentionList, setHideMentionList] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const showCommands = input.startsWith("/") && !hideCommandList;

  const lastToken = getLastToken(input);
  const mentionQuery = lastToken.startsWith("@") ? lastToken.slice(1).toLowerCase() : null;
  const visibleMentions =
    hideMentionList || mentionQuery === null
      ? []
      : mentionSuggestions
          .filter((suggestion) => {
            if (!mentionQuery) return true;
            return suggestion.name.toLowerCase().includes(mentionQuery) || suggestion.token.toLowerCase().includes(mentionQuery);
          })
          .slice(0, 6);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  function sendCurrent() {
    if (!input.trim()) return;
    onSend(input);
    setInput("");
    setHideCommandList(false);
    setHideMentionList(false);
  }

  function insertCommand(command: string) {
    const next = `${command} `;
    setInput(next);
    setHideCommandList(true);
    setHideMentionList(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.length, next.length);
    });
  }

  function replaceLastToken(nextToken: string) {
    const trimmed = input.trimEnd();
    const parts = trimmed ? trimmed.split(/\s+/) : [];
    if (!parts.length) {
      setInput(`${nextToken} `);
      setHideMentionList(true);
      return;
    }
    parts[parts.length - 1] = nextToken;
    const next = `${parts.join(" ")} `;
    setInput(next);
    setHideMentionList(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.length, next.length);
    });
  }

  return (
    <HUDPanel style={styles.position}>
      <div style={styles.panelInner}>
        <div ref={logRef} style={styles.log}>
          {messages.map((message) => (
            <div key={`${message.id}-${message.timestamp}`} style={styles.message}>
              <span style={styles.sender}>{message.name}: </span>
              <span>{message.text}</span>
            </div>
          ))}
        </div>

        {commandStatus && (
          <div
            style={{
              ...styles.status,
              ...(commandStatus.kind === "error" ? styles.statusError : commandStatus.kind === "success" ? styles.statusSuccess : styles.statusInfo),
            }}
            onClick={onDismissStatus}
          >
            {commandStatus.text}
          </div>
        )}

        <div style={styles.inputRow}>
          <div style={styles.inputStack}>
            {showCommands && (
              <div style={styles.popup}>
                <button
                  type="button"
                  style={styles.popupItem}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertCommand("/teleport");
                  }}
                >
                  <span style={styles.popupLeft}>/teleport</span>
                  <span style={styles.popupRight}>Request teleport with @users + message</span>
                </button>
              </div>
            )}

            {!!visibleMentions.length && (
              <div style={styles.popup}>
                {visibleMentions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    type="button"
                    style={styles.popupItem}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      replaceLastToken(suggestion.token);
                    }}
                  >
                    <span style={styles.popupLeft}>{suggestion.name}</span>
                    <span style={styles.popupRight}>{suggestion.token}</span>
                  </button>
                ))}
              </div>
            )}

            <input
              ref={inputRef}
              style={styles.input}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                if (!event.target.value.startsWith("/")) {
                  setHideCommandList(false);
                }
                if (!event.target.value.includes("@")) {
                  setHideMentionList(false);
                } else {
                  setHideMentionList(false);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setHideCommandList(true);
                  return;
                }

                if (event.key === "Tab") {
                  if (showCommands) {
                    event.preventDefault();
                    insertCommand("/teleport");
                    return;
                  }

                  if (visibleMentions.length) {
                    event.preventDefault();
                    replaceLastToken(visibleMentions[0].token);
                    return;
                  }
                }

                if (event.key === "Enter") {
                  event.preventDefault();
                  sendCurrent();
                }
              }}
              placeholder="Say something..."
            />
          </div>

          <button style={styles.btn} onClick={sendCurrent}>
            Send
          </button>
        </div>
      </div>
    </HUDPanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  position: {
    bottom: 20,
    left: 20,
    overflow: "visible",
    display: "flex",
    flexDirection: "column",
  },
  panelInner: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    overflow: "visible",
  },
  log: {
    padding: "8px 10px",
    maxHeight: 180,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  message: { fontSize: 13, color: "#fff", lineHeight: 1.4 },
  sender: { fontWeight: 600, color: "#3498db" },
  status: { padding: "6px 10px", fontSize: 12, cursor: "pointer" },
  statusError: { background: "rgba(192, 57, 43, 0.22)", color: "#ffb5ab" },
  statusSuccess: { background: "rgba(46, 204, 113, 0.2)", color: "#b7f0c9" },
  statusInfo: { background: "rgba(52, 152, 219, 0.2)", color: "#bedef7" },
  inputRow: { display: "flex", borderTop: "1px solid #333" },
  inputStack: { position: "relative", flex: 1 },
  input: {
    width: "100%",
    background: "transparent",
    border: "none",
    color: "#fff",
    padding: "8px 10px",
    fontSize: 13,
    outline: "none",
  },
  btn: {
    background: "#3498db",
    border: "none",
    color: "#fff",
    padding: "0 14px",
    cursor: "pointer",
    fontSize: 13,
  },
  popup: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 38,
    background: "rgba(18, 18, 18, 0.95)",
    border: "1px solid #323232",
    borderRadius: 8,
    zIndex: 40,
    maxHeight: 180,
    overflowY: "auto",
  },
  popupItem: {
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
  popupLeft: {
    fontWeight: 600,
    marginRight: 8,
  },
  popupRight: {
    color: "#8aaac3",
    fontFamily: "monospace",
  },
};
