import { expect, mock, test } from 'claude-code/testing'

const INPUT = {
  model: 'claude-sonnet-5-5',
  promptModel: 'claude-sonnet-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

test('adds the stored instruction as a session section', async ($, on) => {
  mock.store(on, { lines: ['Be terse.', 'Answer in French.'] })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' }] }))

  const result = await $.prompt.compose(INPUT)
  const section = result.sections.find(s => s.id === 'system-instruction:text')

  expect(section?.text).toBe('Be terse.\nAnswer in French.')
  expect(section?.scope).toBe('session')
})

test('adds nothing when the instruction is empty', async ($, on) => {
  mock.store(on, {})
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' }] }))

  const result = await $.prompt.compose(INPUT)

  expect(result.sections.some(s => s.id === 'system-instruction:text')).toBe(false)
})
