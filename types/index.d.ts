export type Definition = { term: string; brief: string; markdown: string }

export type Entry = {
  term: string
  /** null while loading */
  dictionary: string | null
  /** null while loading */
  context: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'define-word': { entry: Entry | null }
  }
}
