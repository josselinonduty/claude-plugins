import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { SavedPrompt } from '../types'
import { fuzzyFilter } from './fuzzy'

const PANE = 'prompt-library'
const library = atom({ plugin: 'prompt-library', key: 'library' } as const, [])
const query = atom({ plugin: 'prompt-library', key: 'query' } as const, '')

const idOf = (text: string): string => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat
}

// Fixed, user-level file: the mod folder (and so $.store) is per session.
const FILE = '.claude/prompt-library.json'

async function filePath($: any): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  return `${home}/${FILE}`
}

async function load($: any): Promise<SavedPrompt[]> {
  try {
    const parsed = JSON.parse(await $.fs.read(await filePath($)))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function persist($: any, list: SavedPrompt[]) {
  await $.fs.write(await filePath($), JSON.stringify(list, null, 2))
  await update($, library, () => list)
}

async function save($: any, text: string) {
  const clean = text.trim()
  if (clean === '') return
  const id = idOf(clean)
  const current = await load($)
  if (current.some(p => p.id === id)) {
    $.ui.toast('Already in prompt library')
    return
  }
  const list = [{ id, text: clean, savedAt: await $.clock.now() }, ...current]
  await persist($, list)
  $.ui.toast('Saved to prompt library')
}

async function remove($: any, id: string) {
  const list = (await load($)).filter(p => p.id !== id)
  await persist($, list)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const fresh = await load($)
    await update($, library, () => fresh)
    await $.command.register({
      name: 'prompts',
      description: 'Open the prompt library',
    })

    return next(e)
  })

  on('command.run', { command: 'prompts' }, async $ => {
    const fresh = await load($)
    await update($, library, () => fresh)
    await $.ui.open({ id: PANE, title: 'Prompt library', focus: true })

    return { text: 'Prompt library opened.' }
  })

  // A save button revealed on hover over the person's own past prompts.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const original = await next(e)
    if (e.props.origin.kind !== 'composer' || e.props.text.trim() === '') {
      return original
    }
    const { Box, Button } = $.ui.resolve(e)
    const id = idOf(e.props.text.trim())

    return (
      <Box key={`row:${id}`} flexDirection="column">
        {original}
        <Box
          flexDirection="row"
          justifyContent="flex-start"
          flexShrink={0}
          display="none"
          hover={{ display: 'flex' }}
        >
          <Button
            key={`save:${id}`}
            label="Save"
            onPress={() => save($, e.props.text)}
          />
          <Button
            key={`copy:${id}`}
            label="Copy"
            onPress={async press => {
              const r = await $.ui.copy({ text: e.props.text, surface: press.surface })
              $.ui.toast(r.isCopied ? 'Copied' : 'Copy failed')
            }}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const q = await read($, query)
    const all = await read($, library)
    const shown = fuzzyFilter(q, all)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 6) / 3))

    return (
      <Box flexDirection="column">
        <Input
          key="search"
          label="Search "
          placeholder="fuzzy search saved prompts"
          value={q}
          autoFocus
          onInput={v => update($, query, () => v)}
          onSubmit={v => update($, query, () => v)}
        />
        {all.length === 0 && (
          <Text dimColor>
            Nothing saved yet. Hover a past prompt and press Save.
          </Text>
        )}
        {all.length > 0 && shown.length === 0 && (
          <Text dimColor>No match.</Text>
        )}
        {shown.slice(0, room).map(p => (
          <Box key={`item:${p.id}`} flexDirection="column" marginTop={1}>
            <Text>{preview(p.text)}</Text>
            <Box>
              <Button
                key={`copy:${p.id}`}
                label="Copy"
                onPress={async press => {
                  const r = await $.ui.copy({ text: p.text, surface: press.surface })
                  $.ui.toast(r.isCopied ? 'Copied' : 'Copy failed')
                }}
              />
              <Button
                key={`apply:${p.id}`}
                label="Apply"
                onPress={async () => {
                  const r = await $.prompt.fill({ text: p.text, mode: 'replace' })
                  $.ui.toast(r.isFilled ? 'Applied to prompt' : 'Prompt field unavailable')
                }}
              />
              <Button
                key={`del:${p.id}`}
                label="Delete"
                onPress={() => remove($, p.id)}
              />
            </Box>
          </Box>
        ))}
        {shown.length > room && (
          <Text dimColor>+{shown.length - room} more, refine your search</Text>
        )}
      </Box>
    )
  })
}
