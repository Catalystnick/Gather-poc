import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Mention from '@tiptap/extension-mention'
import HUDPanel from './HUDPanel'
import type { ChatMessage } from '../../types'
import type { CommandStatus, MentionSuggestion } from '../../chat/types'
import { useChatTokenValidation } from '../../chat/useChatTokenValidation'
import { createSuggestionRenderer, type SuggestionItem } from './tiptap/suggestionRenderer'
import { SlashCommandExtension } from './tiptap/SlashCommandExtension'

interface Props {
  messages: ChatMessage[]
  onSend: (text: string) => void
  commandStatus: CommandStatus | null
  onDismissStatus: () => void
  mentionSuggestions: MentionSuggestion[]
  currentUserToken: string
}

const commandOptions = [
  { command: '/teleport', description: 'Request teleport with @users + message' },
]

const COMMAND_MENTION_ID_PREFIX = 'command-token:'

function isCommandMentionId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(COMMAND_MENTION_ID_PREFIX)
}

function commandMentionId(commandToken: string): string {
  return `${COMMAND_MENTION_ID_PREFIX}${commandToken.toLowerCase()}`
}

function renderMessageWithTags(
  text: string,
  isValidMentionToken: (token: string) => boolean,
  isValidCommandToken: (token: string) => boolean,
  options?: { forceMentionTokenStyle?: boolean },
) {
  const forceMentionTokenStyle = !!options?.forceMentionTokenStyle
  const parts = text.split(/(@[A-Za-z0-9_\-]+|\/[A-Za-z0-9_\-]+)/g)
  return parts.map((part, index) => {
    const looksLikeMentionToken = /^@[A-Za-z0-9_\-]+$/.test(part)
    if (
      part.startsWith('@') && (
        part.toLowerCase() === '@tag'
        || isValidMentionToken(part)
        || (forceMentionTokenStyle && looksLikeMentionToken)
      )
    ) {
      return (
        <span key={`${part}-${index}`} style={styles.inlineTag}>
          {part}
        </span>
      )
    }

    if (part.startsWith('/') && isValidCommandToken(part)) {
      return (
        <span key={`${part}-${index}`} style={styles.inlineCommand}>
          {part}
        </span>
      )
    }

    return <span key={`${part}-${index}`}>{part}</span>
  })
}

function renderStructuredMessage(
  message: ChatMessage,
  isValidMentionToken: (token: string) => boolean,
  isValidCommandToken: (token: string) => boolean,
) {
  const isTagMessage = message.id.startsWith('tag:')
  if (isTagMessage) {
    return renderMessageWithTags(
      message.text,
      isValidMentionToken,
      isValidCommandToken,
      { forceMentionTokenStyle: true },
    )
  }

  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const body = (message.body ?? message.text).trim()
  if (!mentions.length) {
    return renderMessageWithTags(body, isValidMentionToken, isValidCommandToken)
  }

  const mentionNodes = mentions.map((mention, index) => (
    <span key={`${mention.userId}-${index}`} style={styles.inlineTag}>
      {mention.token}
    </span>
  ))

  if (!body) return mentionNodes

  return (
    <>
      {mentionNodes}
      <span>{' '}</span>
      {renderMessageWithTags(body, isValidMentionToken, isValidCommandToken)}
    </>
  )
}

function getComposerText(editor: NonNullable<ReturnType<typeof useEditor>>) {
  return editor.getText({ blockSeparator: ' ' })
}

function tryConvertTypedMentionAtCursor(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  getMentionByTypedToken: (typedWithoutAt: string) => MentionSuggestion | null,
) {
  const from = editor.state.selection.from
  const before = editor.state.doc.textBetween(Math.max(0, from - 120), from, '\n', ' ')
  const match = before.match(/@([A-Za-z0-9_\-]+)$/)
  if (!match) return false

  const suggestion = getMentionByTypedToken(match[1])

  if (!suggestion) return false

  const label = suggestion.token.startsWith('@') ? suggestion.token.slice(1) : suggestion.token
  editor
    .chain()
    .focus()
    .deleteRange({ from: from - match[0].length, to: from })
    .insertContent([
      {
        type: 'mention',
        attrs: {
          id: suggestion.id,
          label,
        },
      },
      { type: 'text', text: ' ' },
    ])
    .run()

  return true
}

function tryConvertTypedCommandAtCursor(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  isValidCommandToken: (token: string) => boolean,
) {
  const from = editor.state.selection.from
  const before = editor.state.doc.textBetween(0, from, '\n', ' ')
  if (!/^\s*\/[A-Za-z0-9_\-]+$/.test(before)) return false
  const match = before.match(/\/[A-Za-z0-9_\-]+$/)
  if (!match) return false

  const commandToken = match[0]
  if (!isValidCommandToken(commandToken)) return false

  editor
    .chain()
    .focus()
    .deleteRange({ from: from - commandToken.length, to: from })
    .insertContent([
      {
        type: 'mention',
        attrs: {
          id: commandMentionId(commandToken),
          label: commandToken,
        },
      },
      { type: 'text', text: ' ' },
    ])
    .run()

  return true
}

/** Chat panel rewritten around Tiptap suggestion extensions for @mentions and slash commands. */
export default function ChatPanel({
  messages,
  onSend,
  commandStatus,
  onDismissStatus,
  mentionSuggestions,
  currentUserToken,
}: Props) {
  const logRef = useRef<HTMLDivElement>(null)
  const editorShellRef = useRef<HTMLDivElement>(null)
  const mentionsRef = useRef<MentionSuggestion[]>(mentionSuggestions)
  const {
    isValidMentionToken,
    isValidCommandToken,
    getMentionByTypedToken,
  } = useChatTokenValidation({
    mentionSuggestions,
    commandTokens: commandOptions.map(item => item.command),
    extraMentionTokens: [currentUserToken],
  })
  const [isEditorEmpty, setIsEditorEmpty] = useState(true)

  const mentionRenderer = useMemo(
    () =>
      createSuggestionRenderer({
        getAnchorClientRect: () => editorShellRef.current?.getBoundingClientRect() ?? null,
        placement: 'top-start',
      }),
    [],
  )

  useEffect(() => {
    mentionsRef.current = mentionSuggestions
  }, [mentionSuggestions])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
      }),
      Mention.configure({
        renderHTML({ node }) {
          const commandToken = isCommandMentionId(node.attrs.id)
          const style = commandToken
            ? 'background: rgba(52,152,219,0.18); border: 1px solid rgba(52,152,219,0.55); border-radius: 4px; padding: 1px 4px; color: #7fc8ff; font-weight: 600;'
            : 'background: rgba(241,196,15,0.18); border: 1px solid rgba(241,196,15,0.55); border-radius: 4px; padding: 1px 4px; color: #f1c40f; font-weight: 600;'
          return [
            'span',
            {
              style,
              'data-token-kind': commandToken ? 'command' : 'mention',
            },
            commandToken ? node.attrs.label ?? '' : `@${node.attrs.label ?? 'user'}`,
          ]
        },
        renderText({ node }) {
          return isCommandMentionId(node.attrs.id)
            ? `${node.attrs.label ?? ''}`
            : `@${node.attrs.label ?? 'user'}`
        },
        suggestion: {
          char: '@',
          allowSpaces: false,
          items: ({ query }) => {
            const normalized = query.toLowerCase()
            return mentionsRef.current
              .filter((suggestion) => {
                if (!normalized) return true
                return suggestion.name.toLowerCase().includes(normalized)
                  || suggestion.token.toLowerCase().includes(normalized)
              })
              .slice(0, 6)
              .map((suggestion): SuggestionItem => ({
                title: suggestion.name,
                subtitle: suggestion.token,
                payload: suggestion,
              }))
          },
          command: ({ editor, range, props }) => {
            const suggestion = (props as unknown as SuggestionItem).payload as MentionSuggestion
            const label = suggestion.token.startsWith('@') ? suggestion.token.slice(1) : suggestion.token
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                {
                  type: 'mention',
                  attrs: {
                    id: suggestion.id,
                    label,
                  },
                },
                { type: 'text', text: ' ' },
              ])
              .run()
          },
          render: mentionRenderer,
        },
      }),
      SlashCommandExtension.configure({
        commands: commandOptions,
        getSuggestionAnchorRect: () => editorShellRef.current?.getBoundingClientRect() ?? null,
        insertCommandToken: ({ editor, range, command }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              {
                type: 'mention',
                attrs: {
                  id: commandMentionId(command),
                  label: command,
                },
              },
              { type: 'text', text: ' ' },
            ])
            .run()
          return true
        },
      }),
    ],
    content: '',
    editorProps: {
      attributes: {
        style: 'outline: none; color: #fff; font-size: 13px; line-height: 1.4; white-space: pre-wrap;',
      },
    },
    onCreate: ({ editor }) => {
      setIsEditorEmpty(editor.isEmpty)
    },
    onUpdate: ({ editor }) => {
      setIsEditorEmpty(editor.isEmpty)
    },
  })

  useEffect(() => {
    if (!logRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [messages])

  const sendCurrent = useCallback(() => {
    if (!editor) return
    const text = getComposerText(editor).trim()
    if (!text) return

    onSend(text)
    editor.commands.clearContent()
  }, [editor, onSend])

  useEffect(() => {
    if (!editor) return

    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return

      const active = document.activeElement as HTMLElement | null
      const activeTag = active?.tagName
      const insideChatEditor = !!(active && editorShellRef.current?.contains(active))
      const typingElsewhere = (activeTag === 'INPUT' || activeTag === 'TEXTAREA') && !insideChatEditor
      if (typingElsewhere) return

      if (!editor.isFocused) {
        event.preventDefault()
        editor.commands.focus('end')
        return
      }

      event.preventDefault()
      sendCurrent()
    }

    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [editor, sendCurrent])

  return (
    <HUDPanel style={styles.position}>
      <div style={styles.panelInner}>
        <div ref={logRef} style={styles.log}>
          {messages.map((message) => {
            const isTagMessage = message.id.startsWith('tag:')
            return (
            <div
              key={`${message.id}-${message.timestamp}`}
              style={isTagMessage ? { ...styles.message, ...styles.tagMessage } : styles.message}
            >
              <span style={isTagMessage ? { ...styles.sender, ...styles.tagSender } : styles.sender}>
                {isTagMessage ? '[TAG] ' : ''}
                {message.name}:{' '}
              </span>
              <span>
                {renderStructuredMessage(
                  message,
                  isValidMentionToken,
                  isValidCommandToken,
                )}
              </span>
            </div>
            )
          })}
        </div>

        {commandStatus && (
          <div
            style={{
              ...styles.status,
              ...(commandStatus.kind === 'error' ? styles.statusError : commandStatus.kind === 'success' ? styles.statusSuccess : styles.statusInfo),
            }}
            onClick={onDismissStatus}
          >
            {commandStatus.text}
          </div>
        )}

        <div style={styles.inputRow}>
          <div style={styles.inputStack}>
            <div
              ref={editorShellRef}
              style={styles.editorShell}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  editor?.commands.blur()
                  ;(document.activeElement as HTMLElement | null)?.blur?.()
                  return
                }

                if (event.key === ' ') {
                  if (editor && tryConvertTypedCommandAtCursor(editor, isValidCommandToken)) {
                    event.preventDefault()
                    return
                  }
                  if (editor && tryConvertTypedMentionAtCursor(editor, getMentionByTypedToken)) {
                    event.preventDefault()
                    return
                  }
                }

              }}
            >
              <EditorContent editor={editor} style={styles.editorContent} />
              {isEditorEmpty && <span style={styles.placeholder}>Say something...</span>}
            </div>
          </div>

          <button style={styles.btn} onClick={sendCurrent}>
            Send
          </button>
        </div>
      </div>
    </HUDPanel>
  )
}

const styles: Record<string, React.CSSProperties> = {
  position: {
    bottom: 20,
    left: 20,
    overflow: 'visible',
    display: 'flex',
    flexDirection: 'column',
  },
  panelInner: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    overflow: 'visible',
  },
  log: {
    padding: '8px 10px',
    maxHeight: 180,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  message: { fontSize: 13, color: '#fff', lineHeight: 1.4 },
  sender: { fontWeight: 600, color: '#3498db' },
  tagMessage: {
    background: 'rgba(241, 196, 15, 0.12)',
    borderLeft: '3px solid #f1c40f',
    padding: '4px 6px',
    borderRadius: 4,
  },
  tagSender: {
    color: '#f1c40f',
  },
  status: { padding: '6px 10px', fontSize: 12, cursor: 'pointer' },
  statusError: { background: 'rgba(192, 57, 43, 0.22)', color: '#ffb5ab' },
  statusSuccess: { background: 'rgba(46, 204, 113, 0.2)', color: '#b7f0c9' },
  statusInfo: { background: 'rgba(52, 152, 219, 0.2)', color: '#bedef7' },
  inputRow: { display: 'flex', borderTop: '1px solid #333' },
  inputStack: { position: 'relative', flex: 1 },
  editorShell: {
    minHeight: 33,
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    padding: '6px 10px',
    color: '#fff',
    fontSize: 13,
    cursor: 'text',
  },
  editorContent: {
    width: '100%',
    minHeight: 20,
    display: 'block',
    caretColor: '#fff',
  },
  placeholder: {
    position: 'absolute',
    left: 10,
    top: '50%',
    transform: 'translateY(-50%)',
    color: '#8a8a8a',
    pointerEvents: 'none',
    fontSize: 13,
  },
  btn: {
    background: '#3498db',
    border: 'none',
    color: '#fff',
    padding: '0 14px',
    cursor: 'pointer',
    fontSize: 13,
  },
  inlineTag: {
    background: 'rgba(241,196,15,0.18)',
    border: '1px solid rgba(241,196,15,0.55)',
    borderRadius: 4,
    padding: '0 4px',
    color: '#f1c40f',
    fontWeight: 600,
  },
  inlineCommand: {
    background: 'rgba(52,152,219,0.18)',
    border: '1px solid rgba(52,152,219,0.55)',
    borderRadius: 4,
    padding: '0 4px',
    color: '#7fc8ff',
    fontWeight: 600,
  },
}
