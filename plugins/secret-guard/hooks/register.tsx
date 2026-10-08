import type { Register } from 'claude-code'

import { detect, mark, redact, toEnvName } from './detect'
import type { Finding } from './detect'

type Fs = {
  read: (path: string) => Promise<unknown>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
}
type Env = { fs: Fs; session: { root: () => Promise<string> } }

const quote = (v: string) => (/^[A-Za-z0-9_./:+@-]*$/.test(v) ? v : JSON.stringify(v))

const parseEnv = (text: string) => {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if (v.startsWith('"')) {
      try { v = JSON.parse(v) } catch { /* keep raw */ }
    } else v = v.replace(/^'(.*)'$/, '$1')
    map.set(m[1], v)
  }

  return map
}

const readText = async ($: Env, path: string) =>
  (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''

/** The project's secrets file: an existing one, else the framework's convention. */
async function pickEnvFile($: Env) {
  const root = (await $.session.root()).replace(/\/$/, '')
  const has = (p: string) => $.fs.exists(`${root}/${p}`)
  const pkg = await readText($, `${root}/package.json`)
  const isWorker =
    (await has('wrangler.toml')) || (await has('wrangler.json')) || (await has('wrangler.jsonc'))
  const order = isWorker
    ? ['.dev.vars', '.env']
    : /"next"\s*:/.test(pkg)
      ? ['.env.local', '.env']
      : ['.env', '.env.local']
  for (const f of order) if (await has(f)) return { root, file: f }

  return { root, file: order[0] }
}

let queue: Promise<unknown> = Promise.resolve()
const serial = <T,>(job: () => Promise<T>) => {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)

  return run
}

const handled = new Map<string, string>() // name -> env file, this session

/** Stores each finding in the env file, returns the variable name used for each. */
function store($: Env, findings: Finding[]) {
  return serial(async () => {
    const { root, file } = await pickEnvFile($)
    const path = `${root}/${file}`
    let text = await readText($, path)
    const env = parseEnv(text)
    const names: string[] = []
    const added: string[] = []

    for (const f of findings) {
      let name = toEnvName(f.name)
      let n = 1
      for (;;) {
        const cur = env.get(name)
        if (cur === undefined || cur === f.value) break
        name = `${toEnvName(f.name)}_${++n}`
      }
      if (env.get(name) === undefined) {
        env.set(name, f.value)
        text += `${text && !text.endsWith('\n') ? '\n' : ''}${name}=${quote(f.value)}\n`
        added.push(name)
      }
      names.push(name)
      handled.set(name, file)
    }

    if (added.length > 0) {
      await $.fs.write(path, text)
      await keepOutOfGit($, root, file)
      await addToExample($, root, added)
    }

    return { names, file, added }
  })
}

async function keepOutOfGit($: Env, root: string, file: string) {
  if (!(await $.fs.exists(`${root}/.git`)) && !(await $.fs.exists(`${root}/.gitignore`))) return
  const gi = await readText($, `${root}/.gitignore`)
  const covered = gi.split('\n').some(l => {
    const p = l.trim().replace(/^\//, '')
    return p === file || p === '.env*' || (p === '.env.*' && file !== '.env')
  })
  if (!covered) await $.fs.write(`${root}/.gitignore`, `${gi}${gi && !gi.endsWith('\n') ? '\n' : ''}${file}\n`)
}

async function addToExample($: Env, root: string, names: string[]) {
  const path = `${root}/.env.example`
  if (!(await $.fs.exists(path))) return
  let text = await readText($, path)
  const have = parseEnv(text)
  for (const n of names) {
    if (have.has(n)) continue
    text += `${text && !text.endsWith('\n') ? '\n' : ''}${n}=\n`
  }
  await $.fs.write(path, text)
}

/** Redacts `text`; the secrets go to the env file. If that fails they are still redacted. */
async function guard($: Env, text: string) {
  const findings = detect(text)
  if (findings.length === 0) return { text, file: undefined, names: [] as string[] }
  try {
    const { names, file } = await store($, findings)

    return { text: redact(text, findings, names), file, names }
  } catch {
    const names = findings.map(f => toEnvName(f.name))

    return { text: redact(text, findings, names), file: undefined, names }
  }
}

/** Scrubs only, no I/O: the fallback when a hook failed. */
const scrub = (text: string) => {
  const f = detect(text)

  return f.length === 0 ? text : redact(text, f, f.map(x => toEnvName(x.name)))
}

type Block = { type: string; text?: string; content?: unknown; [k: string]: unknown }

async function mapBlocks(blocks: Block[], fn: (t: string) => Promise<string> | string): Promise<Block[]> {
  return Promise.all(
    blocks.map(async b => {
      if (b.type === 'text' && typeof b.text === 'string') return { ...b, text: await fn(b.text) }
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string') return { ...b, content: await fn(b.content) }
        if (Array.isArray(b.content)) return { ...b, content: await mapBlocks(b.content as Block[], fn) }
      }

      return b
    }),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'secret-guard',
      description: 'Show where secret-guard stores the secrets it has caught',
    })

    return next(e)
  })

  on('command.run', { command: 'secret-guard' }, async $ => {
    const { root, file } = await pickEnvFile($ as unknown as Env)
    const names = [...handled.keys()]

    return {
      text:
        `secret-guard target: ${root}/${file}\n` +
        (names.length ? `Caught this session: ${names.join(', ')}` : 'No secret caught this session.'),
    }
  })

  // The prompt: redact before the model reads it or the queue records it.
  on('prompt.submit', async ($, e, next) => {
    const r = await guard($ as unknown as Env, e.text)
    if (r.names.length > 0) {
      void $.ui.toast(
        r.file
          ? `secret-guard: ${r.names.join(', ')} moved to ${r.file}`
          : `secret-guard: redacted ${r.names.length} secret(s); could not write the env file`,
      )
    }

    return next({
      ...e,
      text: r.text,
      context:
        r.names.length > 0
          ? [
              ...(e.context ?? []),
              `secret-guard replaced secret(s) in the user's prompt with markers like ${mark('NAME')}. ` +
                `Their values are in ${r.file ?? 'the project env file'} as NAME; reference them through the environment, never ask for or echo them.`,
            ]
          : e.context,
    })
  }).catch(($, e, next) => next.called ? next(e) : next({ ...e, text: scrub(e.text) }))

  // Every row the conversation keeps: tool output (cat .env), model text, notices.
  on('session.append', async ($, e, next) => {
    const content = await mapBlocks(e.message.content as Block[], async t => (await guard($ as unknown as Env, t)).text)

    return next({ ...e, message: { ...e.message, content: content as typeof e.message.content } })
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    const content = await mapBlocks(e.message.content as Block[], scrub)

    return next({ ...e, message: { ...e.message, content: content as typeof e.message.content } })
  })
}
