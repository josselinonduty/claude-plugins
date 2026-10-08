import { expect, test } from 'claude-code/testing'
import { fuzzyFilter, fuzzyScore } from './fuzzy'

test('subsequence matches, non-subsequence does not', () => {
  expect(fuzzyScore('rfc', 'refactor the code')).not.toBeNull()
  expect(fuzzyScore('xyz', 'refactor the code')).toBeNull()
})

test('tighter matches rank first', () => {
  const out = fuzzyFilter('fix bug', [
    { text: 'f.......i....x b.u.g' },
    { text: 'please fix the bug' },
  ])
  expect(out[0]?.text).toBe('please fix the bug')
})

test('empty query keeps everything', () => {
  expect(fuzzyFilter('', [{ text: 'a' }, { text: 'b' }])).toHaveLength(2)
})
