import type { FileChange, Section } from '../types'

export const TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'style',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'revert'
]

const MAX_PROMPT_FILES = 400
const MAX_SAMPLE_CHARS = 700
const MAX_TOTAL_SAMPLE_CHARS = 30000

/** Parses `git status --porcelain=v1 -z --no-renames` output. */
export function parseStatus(out: string): FileChange[] {
  const changes: FileChange[] = []
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue
    changes.push({ code: entry.slice(0, 2), path: entry.slice(3) })
  }
  return changes
}

export function describeCode(code: string): string {
  if (code === '??') return 'new'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

/** Splits `git diff` output into a map of path to the head of its patch. */
export function diffSamples(diff: string): Map<string, string> {
  const samples = new Map<string, string>()
  let total = 0
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const match = /^a\/(.+?) b\/(.+)\n/.exec(chunk)
    if (!match) continue
    const body = chunk
      .split('\n')
      .filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
      .join('\n')
      .slice(0, MAX_SAMPLE_CHARS)
    if (total + body.length > MAX_TOTAL_SAMPLE_CHARS) break
    total += body.length
    samples.set(match[2], body)
  }
  return samples
}

export function buildPrompt(
  repo: string,
  changes: FileChange[],
  stats: Map<string, string>,
  samples: Map<string, string>,
  recentSubjects: string[]
): string {
  const listed = changes.slice(0, MAX_PROMPT_FILES)
  const lines = listed.map(c => {
    const stat = stats.get(c.path)
    const sample = samples.get(c.path)
    const head = `- ${c.path} [${describeCode(c.code)}${stat ? `, ${stat}` : ''}]`
    return sample ? `${head}\n${sample.replace(/^/gm, '    ')}` : head
  })
  return [
    `Repository: ${repo}`,
    '',
    'Group the uncommitted changes below into logical commits: one per feature, fix,',
    'domain, refactor, or one commit for related chores (dependencies, config, formatting).',
    'Every file must appear in exactly one commit. Prefer fewer, coherent commits over',
    'many tiny ones, and order them so that foundations (deps, config, shared code)',
    'come before the features that use them.',
    '',
    'Commit message rules:',
    `- type is one of: ${TYPES.join(', ')}`,
    '- scope is a short lowercase area name, or empty',
    '- subject is imperative, lowercase, no trailing period, at most 60 characters',
    '- body is optional: one or two sentences on why, or a short bullet list',
    '- describe only the code changes; never mention AI, assistants or tooling used to write them',
    '',
    recentSubjects.length
      ? `Recent commit subjects, for style:\n${recentSubjects.map(s => `  ${s}`).join('\n')}\n`
      : '',
    'Answer with JSON only, no prose, in this shape:',
    '{"commits":[{"type":"feat","scope":"map","subject":"add pin button","body":"","files":["path"]}]}',
    '',
    'Changes:',
    ...lines,
    changes.length > listed.length
      ? `(${changes.length - listed.length} more files not shown; they are handled separately)`
      : ''
  ].join('\n')
}

type Draft = {
  type: string
  scope: string
  subject: string
  body: string
  files: string[]
}

export function parseDrafts(text: string): Draft[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return []
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as { commits?: unknown }
    if (!Array.isArray(data.commits)) return []
    return data.commits.flatMap((c: Record<string, unknown>) => {
      if (!c || !Array.isArray(c.files)) return []
      return [
        {
          type: String(c.type ?? 'chore'),
          scope: String(c.scope ?? ''),
          subject: String(c.subject ?? ''),
          body: String(c.body ?? ''),
          files: c.files.map(String)
        }
      ]
    })
  } catch {
    return []
  }
}

const TRAILER = /^(co-authored-by|claude-session|generated-by)\s*:/i
const TOOLING = /(generated with|noreply@anthropic|claude\.ai\/|🤖)/i
const MENTION = /\b(claude|anthropic)\b/i

/**
 * Removes any trace of the authoring assistant from a message, unless the
 * commit is about it (a file path naming it).
 */
export function sanitizeMessage(message: string, files: string[]): string {
  const isFeature = files.some(f => MENTION.test(f))
  const kept = message
    .split('\n')
    .filter(line => !TRAILER.test(line) && !TOOLING.test(line))
    .filter(line => isFeature || !MENTION.test(line))
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function formatMessage(draft: Draft, files: string[]): string {
  const type = TYPES.includes(draft.type.toLowerCase())
    ? draft.type.toLowerCase()
    : 'chore'
  const scope = draft.scope
    .toLowerCase()
    .replace(/[^a-z0-9/_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const prefix = scope ? `${type}(${scope}): ` : `${type}: `
  let subject = draft.subject.trim().replace(/\.+$/, '')
  subject = subject.charAt(0).toLowerCase() + subject.slice(1)
  if (!subject) subject = 'update project files'
  subject = subject.slice(0, Math.max(20, 72 - prefix.length))
  const raw = `${prefix}${subject}${draft.body.trim() ? `\n\n${draft.body.trim()}` : ''}`
  const clean = sanitizeMessage(raw, files)
  const header = clean.split('\n')[0]
  return header && header.startsWith(prefix.trim()) ? clean : `chore: update project files`
}

/**
 * Turns a model reply into sections that cover `changes` exactly once:
 * unknown paths are dropped, repeated ones keep their first commit, and
 * whatever the model left out becomes a final chore commit.
 */
export function buildSections(
  text: string,
  changes: FileChange[],
  root: string,
  repo: string,
  nextId: () => string
): Section[] {
  const known = new Set(changes.map(c => c.path))
  const seen = new Set<string>()
  const sections: Section[] = []
  for (const draft of parseDrafts(text)) {
    const files: string[] = []
    for (const f of draft.files) {
      if (!known.has(f) || seen.has(f)) continue
      seen.add(f)
      files.push(f)
    }
    if (files.length === 0) continue
    sections.push({
      id: nextId(),
      root,
      repo,
      message: formatMessage(draft, files),
      files
    })
  }
  const rest = changes.map(c => c.path).filter(p => !seen.has(p))
  if (rest.length > 0) {
    sections.push({
      id: nextId(),
      root,
      repo,
      message: sections.length ? 'chore: update remaining files' : 'chore: update project files',
      files: rest
    })
  }
  return sections
}

export function title(message: string): string {
  return message.split('\n')[0]
}
