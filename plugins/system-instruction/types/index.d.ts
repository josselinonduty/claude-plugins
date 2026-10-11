declare module 'claude-code' {
  interface PluginState {
    'system-instruction': { text: string; isEditing: boolean }
  }
}
