declare module 'claude-code' {
  interface PluginState {
    'system-instruction': { lines: string[]; editing: number | null }
  }
}
