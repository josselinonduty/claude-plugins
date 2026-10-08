import { expect, test } from 'claude-code/testing'

import { detect, redact } from './detect'

const run = (t: string) => {
  const f = detect(t)

  return redact(t, f, f.map(x => x.name))
}


test('redacts known token shapes', () => {
    expect(run('key ghp_' + 'a'.repeat(36))).toBe('key [secret:GITHUB_TOKEN]')
    expect(run('AKIAABCDEFGHIJKLMNOP')).toBe('[secret:AWS_ACCESS_KEY_ID]')
  })

test('redacts only the value of an assignment', () => {
    expect(run('DB_PASSWORD=hunter2hunter2')).toBe('DB_PASSWORD=[secret:DB_PASSWORD]')
  })

test('redacts URL passwords', () => {
    expect(run('postgres://bob:s3cretpw@db/x')).toBe('postgres://bob:[secret:URL_PASSWORD]@db/x')
  })

test('leaves placeholders and markers alone', () => {
    const t = 'API_KEY=${API_KEY} TOKEN=[secret:TOKEN] SECRET=process.env.X'
    expect(run(t)).toBe(t)
  })

test('redacts a bare "secret:" with a hex value', () => {
  expect(run('my client secret: ' + 'ab12'.repeat(16))).toBe('my client secret: [secret:SECRET]')
})

test('redacts bare hex of 11+ chars', () => {
  expect(run('x 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef y')).toBe('x [secret:HEX_SECRET] y')
  expect(run('abc123def45')).toBe('[secret:HEX_SECRET]')
})

test('redacts bare base64 of 11+ chars', () => {
  expect(run('tok dGhpc0lzQVNlY3JldDEyMw== end')).toBe('tok [secret:BASE64_SECRET] end')
})

test('leaves words, numbers, uuids, paths and hash-labelled values alone', () => {
  for (const t of [
    'configuration', '12345678901234', 'getUserById', '550e8400-e29b-41d4-a716-446655440000',
    'src/components/Foo2/bar', 'sha256: ' + 'ab12'.repeat(16), 'commit 1a2b3c4d5e6f7a8b',
    'useRouteQuery2', '[secret:SECRET_2]', '[secret:DB_PASSWORD]',
  ]) expect(run(t)).toBe(t)
})
