import { Extension, type Editor } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { createSuggestionRenderer, type SuggestionItem } from './suggestionRenderer'

export interface SlashCommandOption {
  command: string
  description: string
}

interface SlashCommandExtensionOptions {
  commands: SlashCommandOption[]
  getSuggestionAnchorRect?: (() => DOMRect | null) | null
  insertCommandToken?: ((params: {
    editor: Editor
    range: { from: number; to: number }
    command: string
  }) => boolean) | null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    slashCommand: {
      insertSlashCommand: (command: string) => ReturnType
    }
  }
}

export const SlashCommandExtension = Extension.create<SlashCommandExtensionOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      commands: [],
      getSuggestionAnchorRect: null,
      insertCommandToken: null,
    }
  },

  addCommands() {
    return {
      insertSlashCommand:
        (command: string) =>
        ({ chain }) =>
          chain().insertContent(`${command} `).run(),
    }
  },

  addProseMirrorPlugins() {
    const renderer = createSuggestionRenderer({
      getAnchorClientRect: this.options.getSuggestionAnchorRect,
      placement: 'top-start',
    })

    return [
      Suggestion<SuggestionItem>({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        allow: ({ range }) => range.from === 1,
        items: ({ query }) =>
          this.options.commands
            .filter(option => option.command.slice(1).startsWith(query.toLowerCase()))
            .slice(0, 6)
            .map(option => ({
              title: option.command,
              subtitle: option.description,
              payload: option,
            })),
        command: ({ editor, range, props }) => {
          const command = (props.payload as SlashCommandOption).command
          if (this.options.insertCommandToken?.({ editor, range, command })) return
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent(`${command} `)
            .run()
        },
        render: renderer,
      }),
    ]
  },
})
