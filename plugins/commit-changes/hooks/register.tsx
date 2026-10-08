import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Phase, RepoStatus, Section } from '../types'
import {
  buildPrompt,
  buildSections,
  diffSamples,
  parseStatus,
  title
} from './plan'

const repos = atom({ plugin: 'commit-changes', key: 'repos' } as const, [] as RepoStatus[])
const sections = atom({ plugin: 'commit-changes', key: 'sections' } as const, [] as Section[])
const isAuto = atom({ plugin: 'commit-changes', key: 'isAuto' } as const, false)
const phase = atom({ plugin: 'commit-changes', key: 'phase' } as const, 'idle' as Phase)
const note = atom({ plugin: 'commit-changes', key: 'note' } as const, null as string | null)

const POLL_MS = 4000
const REDISCOVER_EVERY = 15
const VISIBLE_SECTIONS = 6

const firstLine = (text: string) =>
  text.split('\n').find(l => l.trim())?.trim() ?? 'unknown error'

const uncovered = (list: RepoStatus[], plan: Section[]) =>
  list.map(r => {
    const covered = new Set(
      plan.filter(s => s.root === r.root).flatMap(s => s.files)
    )
    return { repo: r, files: r.files.filter(f => !covered.has(f.path)) }
  }).filter(u => u.files.length > 0)

type Api = {
  planChanges: () => Promise<void>
  exclusive: (work: () => Promise<void>) => Promise<void>
  commitSection: (id: string) => Promise<void>
  tick: () => Promise<void>
}

let api: Api | undefined

export const register: Register = on => {
  let cwd = ''
  let roots: string[] = []
  let ticks = 0
  let isBusy = false
  let isTurnRunning = false
  let counter = 0

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const nextId = () => `s${++counter}`

    const git = (root: string, args: string[], stdin?: string) =>
      $.process.run(['git', '-C', root, ...args], {
        stdin,
        timeoutMs: 120000
      })

    const discover = async () => {
      const top = await git(cwd, ['rev-parse', '--show-toplevel'])
      if (top.exitCode === 0) {
        roots = [top.stdout.trim()]
        return
      }
      const found = await $.process.run([
        'find', cwd, '-maxdepth', '3',
        '(', '-name', 'node_modules', '-prune', ')',
        '-o', '-name', '.git', '-print'
      ])
      roots = found.stdout
        .split('\n')
        .filter(Boolean)
        .map(p => p.replace(/\/\.git$/, ''))
        .sort()
    }

    const refresh = async () => {
      const fresh: RepoStatus[] = []
      for (const root of roots) {
        const r = await git(root, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'])
        if (r.exitCode !== 0) continue
        const files = parseStatus(r.stdout)
        if (files.length > 0) {
          fresh.push({ root, name: root.split('/').pop() ?? root, files })
        }
      }
      const changed = new Map(fresh.map(r => [r.root, new Set(r.files.map(f => f.path))]))
      await update($, repos, () => fresh)
      await update($, sections, list =>
        list
          .map(s => ({ ...s, files: s.files.filter(f => changed.get(s.root)?.has(f)) }))
          .filter(s => s.files.length > 0)
      )
    }

    const fail = async (message: string) => {
      await update($, note, () => message)
      await update($, isAuto, () => false)
      $.ui.toast(`commit-changes: ${message}`)
    }

    const planChanges = async () => {
      await update($, phase, () => 'planning')
      await update($, note, () => null)
      try {
        const todo = uncovered(await read($, repos), await read($, sections))
        for (const { repo, files } of todo) {
          const batch = files.slice(0, 400)
          const stat = await git(repo.root, ['diff', 'HEAD', '--numstat'])
          const stats = new Map<string, string>()
          for (const line of stat.stdout.split('\n')) {
            const [a, d, ...p] = line.split('\t')
            if (p.length) stats.set(p.join('\t'), `+${a} -${d}`)
          }
          const diff = await git(repo.root, ['diff', 'HEAD', '-U0', '--no-color'])
          const log = await git(repo.root, ['log', '-8', '--format=%s'])
          const subjects = log.exitCode === 0 ? log.stdout.split('\n').filter(Boolean) : []
          const reply = await $.model.complete({
            model: 'sonnet',
            effort: 'low',
            maxTokens: 8000,
            timeoutMs: 180000,
            prompt: buildPrompt(repo.name, batch, stats, diffSamples(diff.stdout), subjects)
          })
          if (!reply.isAnswered) {
            return fail(`could not split ${repo.name}: ${reply.reason}`)
          }
          const made = buildSections(reply.text, batch, repo.root, repo.name, nextId)
          await update($, sections, list => [...list, ...made])
        }
      } finally {
        await update($, phase, () => 'idle')
      }
    }

    const commitSection = async (id: string) => {
      await refresh()
      const section = (await read($, sections)).find(s => s.id === id)
      if (!section) return
      await update($, phase, () => 'committing')
      try {
        // Start from an empty index so the commit holds this section alone.
        await git(section.root, ['reset', '-q'])
        const add = await git(section.root, ['add', '-A', '--', ...section.files])
        if (add.exitCode !== 0) {
          return fail(`git add failed: ${firstLine(add.stderr)}`)
        }
        const commit = await git(section.root, ['commit', '-F', '-'], section.message)
        if (commit.exitCode !== 0) {
          await git(section.root, ['reset', '-q'])
          return fail(`git commit failed: ${firstLine(commit.stderr || commit.stdout)}`)
        }
        await update($, note, () => null)
        await update($, sections, list => list.filter(s => s.id !== id))
        await refresh()
      } finally {
        await update($, phase, () => 'idle')
      }
    }

    const exclusive = async (work: () => Promise<void>) => {
      if (isBusy) return
      isBusy = true
      try {
        await work()
      } catch (error) {
        await fail(error instanceof Error ? error.message : String(error))
      } finally {
        isBusy = false
      }
    }

    const autoStep = async () => {
      const list = await read($, repos)
      if (list.length === 0) {
        await update($, isAuto, () => false)
        $.ui.toast('commit-changes: no changes left')
        return
      }
      const plan = await read($, sections)
      if (uncovered(list, plan).length > 0) return planChanges()
      if (plan.length > 0) return commitSection(plan[0].id)
    }

    const tick = () =>
      exclusive(async () => {
        if (ticks++ % REDISCOVER_EVERY === 0) await discover()
        await refresh()
        if ((await read($, isAuto)) && !isTurnRunning) await autoStep()
      })


    api = { planChanges, exclusive, commitSection, tick }
    const started = await next(e)
    $.clock.every(POLL_MS, () => void tick())
    void tick()
    return started
  })

  on('turn.start', ($, e, next) => {
    isTurnRunning = true
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    isTurnRunning = false
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [list, plan, auto, current, message] = await Promise.all([
      read($, repos),
      read($, sections),
      read($, isAuto),
      read($, phase),
      read($, note)
    ])
    const total = list.reduce((n, r) => n + r.files.length, 0)
    if (e.props.hasSurvey || (total === 0 && plan.length === 0)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const pending = uncovered(list, plan).reduce((n, u) => n + u.files.length, 0)
    const working = current !== 'idle'
    const status =
      current === 'planning'
        ? 'splitting into commits…'
        : current === 'committing'
          ? 'committing…'
          : auto && e.props.isWorking
            ? 'auto: waiting for the turn to finish'
            : auto
              ? 'auto'
              : plan.length > 0
                ? `${plan.length} commit${plan.length > 1 ? 's' : ''} planned`
                : ''

    const run = (work: () => Promise<void>) => () => api!.exclusive(work)

    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow">● {total} uncommitted file{total === 1 ? '' : 's'}</Text>
          <Text dimColor>
            {' '}in {list.length} repo{list.length === 1 ? '' : 's'}
            {status ? ` · ${status}` : ''}{' '}
          </Text>
          {pending > 0 && !working ? (
            <Button
              key="split"
              label={plan.length ? `Split ${pending} new` : 'Split into commits'}
              onPress={run(() => api!.planChanges())}
            />
          ) : null}
          <Text> </Text>
          <Button
            key="auto"
            label={auto ? 'Auto: on' : 'Auto: off'}
            onPress={async () => {
              await update($, isAuto, v => !v)
              void api!.tick()
            }}
          />
          {plan.length > 0 && !working ? (
            <Button
              key="redo"
              label="Redo"
              onPress={run(async () => {
                await update($, sections, () => [])
                await api!.planChanges()
              })}
            />
          ) : null}
        </Box>
        {message ? <Text color="red">{message}</Text> : null}
        {plan.slice(0, VISIBLE_SECTIONS).map((s, i) => (
          <Box key={`row-${s.id}`}>
            <Text dimColor>{i + 1}. </Text>
            <Text wrap="truncate-end">{title(s.message)}</Text>
            <Text dimColor>
              {' '}· {s.files.length} file{s.files.length === 1 ? '' : 's'}
              {list.length > 1 ? ` · ${s.repo}` : ''}{' '}
            </Text>
            {working || auto ? null : (
              <Button
                key={`commit-${s.id}`}
                label="Commit"
                onPress={run(() => api!.commitSection(s.id))}
              />
            )}
          </Box>
        ))}
        {plan.length > VISIBLE_SECTIONS ? (
          <Text dimColor>+{plan.length - VISIBLE_SECTIONS} more</Text>
        ) : null}
      </Box>
    )
  })
}
