export type Finding = { start: number; end: number; value: string; name: string }

type Rule = {
  name: string
  re: RegExp
  group?: number
  nameGroup?: number
  /** Rejects a match given the text just before it. */
  skip?: (value: string, before: string) => boolean
}

const HASH_CONTEXT = /(?:sha\d*|md5|commit|digest|integrity|checksum|hash|rev|uuid)\W{0,4}$/i
const inMarker = (_: string, before: string) => /\[secret:[A-Za-z0-9_]*$/.test(before)

const RULES: Rule[] = [
  { name: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'ANTHROPIC_API_KEY', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OPENAI_API_KEY', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'GITHUB_TOKEN', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { name: 'AWS_ACCESS_KEY_ID', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'SLACK_TOKEN', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'STRIPE_SECRET_KEY', re: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{20,}/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'URL_PASSWORD', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/gi, group: 1 },
  {
    name: '',
    re: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*["']?([^\s"',;]{8,})/gi,
    group: 2,
    nameGroup: 1,
    skip: (v, before) => v.endsWith(']') && before.endsWith('['),
  },
  // Anything left that looks encoded: 11+ hex or base64 chars. The mix of classes
  // keeps plain words, numbers and lower-case ids (uuids, slugs) out.
  {
    name: 'HEX_SECRET',
    re: /(?<![A-Za-z0-9_.+\/=-])[0-9a-fA-F]{11,}(?![A-Za-z0-9_+\/-])/g,
    skip: (v, before) => !/\d/.test(v) || !/[a-fA-F]/.test(v) || HASH_CONTEXT.test(before) || inMarker(v, before),
  },
  {
    name: 'BASE64_SECRET',
    re: /(?<![A-Za-z0-9_.+\/=-])[A-Za-z0-9+\/_-]{11,}={0,2}(?![A-Za-z0-9_+\/=-])/g,
    skip: (v, before) =>
      !/\d/.test(v) || !/[a-z]/.test(v) || !/[A-Z]/.test(v) || /^[A-Za-z]+\d*$/.test(v) ||
      (v.includes('/') && !v.includes('+') && !v.endsWith('=')) ||
      HASH_CONTEXT.test(before) || inMarker(v, before),
  },
]

const PLACEHOLDER =
  /^(?:\$\{?\w+\}?|<.*>|\[.*\]|your[_-]|xxx|\*{3,}|changeme|example|placeholder|process\.env|env\.|os\.environ|null$|undefined$|true$|false$)/i

/** Marker the redaction leaves in the history; never matches a rule. */
export const mark = (name: string) => `[secret:${name}]`

const isPlaceholder = (value: string) => PLACEHOLDER.test(value) || value.startsWith('[secret:')

export function toEnvName(raw: string) {
  return raw.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'SECRET'
}

export function detect(text: string): Finding[] {
  const found: Finding[] = []

  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const value = m[rule.group ?? 0]
      if (value === undefined || isPlaceholder(value)) continue
      if (rule.skip?.(value, text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0))) continue
      const offset = rule.group === undefined ? 0 : m[0].indexOf(value, rule.nameGroup ? m[rule.nameGroup].length : 0)
      const start = (m.index ?? 0) + offset
      const name = rule.nameGroup ? toEnvName(m[rule.nameGroup]) : rule.name
      found.push({ start, end: start + value.length, value, name })
    }
  }

  // Earliest first; on overlap keep the longer (a PEM block beats a keyword inside it).
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Finding[] = []
  for (const f of found) {
    const last = kept[kept.length - 1]
    if (last && f.start < last.end) continue
    kept.push(f)
  }

  return kept
}

/** Rewrites `text`, swapping each finding for `names[i]`'s marker. */
export function redact(text: string, findings: Finding[], names: string[]) {
  let out = ''
  let at = 0
  findings.forEach((f, i) => {
    out += text.slice(at, f.start) + mark(names[i])
    at = f.end
  })

  return out + text.slice(at)
}
