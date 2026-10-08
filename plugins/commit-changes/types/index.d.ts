export type FileChange = { path: string; code: string }
export type RepoStatus = { root: string; name: string; files: FileChange[] }
export type Section = {
  id: string
  root: string
  repo: string
  message: string
  files: string[]
}
export type Phase = 'idle' | 'planning' | 'committing'

declare module 'claude-code' {
  interface PluginState {
    'commit-changes': {
      repos: RepoStatus[]
      sections: Section[]
      isAuto: boolean
      phase: Phase
      note: string | null
    }
  }
}
