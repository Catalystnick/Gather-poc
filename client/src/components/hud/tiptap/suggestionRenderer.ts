import { ReactRenderer } from '@tiptap/react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import tippy, { type Instance, type Props as TippyProps } from 'tippy.js'
import { SuggestionList, type SuggestionListHandle, type SuggestionListProps } from './SuggestionList'

export interface SuggestionItem {
  title: string
  subtitle?: string
  payload: unknown
}

interface RendererOptions {
  maxHeight?: number
  placement?: TippyProps['placement']
  getAnchorClientRect?: (() => DOMRect | null) | null
}

type SuggestionRendererProps = SuggestionProps<SuggestionItem>

function getSafeClientRect(clientRect: (() => DOMRect | null) | null | undefined) {
  return () => {
    const rect = clientRect?.()
    if (rect) return rect
    return new DOMRect(0, 0, 0, 0)
  }
}

export function createSuggestionRenderer(options: RendererOptions = {}) {
  const maxHeight = options.maxHeight ?? 180
  const placement = options.placement ?? 'top-start'
  const getAnchorClientRect = options.getAnchorClientRect ?? null

  return () => {
    let reactRenderer: ReactRenderer<SuggestionListHandle, SuggestionListProps> | null = null
    let popup: Instance<TippyProps> | null = null

    return {
      onStart: (props: SuggestionRendererProps) => {
        const renderer = new ReactRenderer(SuggestionList, {
          props: {
            items: props.items,
            command: props.command,
            maxHeight,
          },
          editor: props.editor,
        })
        reactRenderer = renderer

        popup = tippy(document.body, {
          getReferenceClientRect: getSafeClientRect(getAnchorClientRect ?? props.clientRect),
          appendTo: () => document.body,
          content: renderer.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement,
          offset: [0, 6],
        })
      },

      onUpdate: (props: SuggestionRendererProps) => {
        reactRenderer?.updateProps({
          items: props.items,
          command: props.command,
          maxHeight,
        })

        if (!popup) return
        popup.setProps({
          getReferenceClientRect: getSafeClientRect(getAnchorClientRect ?? props.clientRect),
        })
      },

      onKeyDown: (props: SuggestionKeyDownProps) => {
        if (props.event.key === 'Escape') {
          popup?.hide()
          return true
        }

        if (!reactRenderer?.ref) return false
        return reactRenderer.ref.onKeyDown(props)
      },

      onExit: () => {
        popup?.destroy()
        reactRenderer?.destroy()
      },
    }
  }
}
