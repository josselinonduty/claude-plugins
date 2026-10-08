import { expect, test } from 'claude-code/testing'

import { buildSections, parseStatus, sanitizeMessage } from './plan'

const changes = parseStatus(' M src/a.ts\0?? src/b.ts\0 D old.ts\0')

test('parses porcelain -z status', () => {
  expect(changes.map(c => c.path)).toEqual(['src/a.ts', 'src/b.ts', 'old.ts'])
  expect(changes[1].code).toBe('??')
})

test('sections cover every file exactly once', () => {
  let n = 0
  const reply = '```json\n{"commits":[{"type":"feat","scope":"Map","subject":"Add pin.","body":"","files":["src/a.ts","src/a.ts","nope.ts"]}]}\n```'
  const sections = buildSections(reply, changes, '/r', 'r', () => `s${++n}`)
  expect(sections.map(s => s.files)).toEqual([['src/a.ts'], ['src/b.ts', 'old.ts']])
  expect(sections[0].message).toBe('feat(map): add pin')
  expect(sections[1].message).toBe('chore: update remaining files')
})

test('unparseable reply falls back to one chore commit', () => {
  const sections = buildSections('sorry', changes, '/r', 'r', () => 'x')
  expect(sections).toHaveLength(1)
  expect(sections[0].message).toBe('chore: update project files')
})

test('assistant mentions never reach a message', () => {
  const msg = 'feat: add thing\n\nBody.\n\nCo-Authored-By: Bot <bot@example.com>\nGenerated-By: tool\n🤖 Generated with tool'
  expect(sanitizeMessage(msg, ['src/a.ts'])).toBe('feat: add thing\n\nBody.')
})

test('a commit about the assistant keeps its own subject', () => {
  expect(sanitizeMessage('feat: add claude hook\n\nCo-Authored-By: Bot <x>', ['.claude/hooks.json'])).toBe('feat: add claude hook')
})

test('a header that mentions the assistant by accident is replaced', () => {
  const sections = buildSections(
    '{"commits":[{"type":"chore","scope":"","subject":"changes by claude","body":"","files":["src/a.ts","src/b.ts","old.ts"]}]}',
    changes, '/r', 'r', () => 'x'
  )
  expect(sections[0].message).toBe('chore: update project files')
})
