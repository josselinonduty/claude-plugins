export type SavedPrompt = { id: string; text: string; savedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'prompt-library': { library: SavedPrompt[]; query: string }
  }
}
