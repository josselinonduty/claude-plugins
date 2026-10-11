import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'system-instruction'
const lines = atom({ plugin: 'system-instruction', key: 'lines' } as const, [])
const editing = atom({ plugin: 'system-instruction', key: 'editing' } as const, null)

async function load($: any): Promise<string[]> {
  const saved = await $.store.get('lines')

  return Array.isArray(saved) ? saved.map(String) : []
}

async function save($: any, next: string[]) {
  await $.store.set('lines', next)
  await update($, lines, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await load($)
    await update($, lines, () => saved)
    await $.command.register({
      name: 'system-instruction',
      description: 'Edit the custom system instruction given to the model at every session start',
    })

    return next(e)
  })

  on('command.run', { command: 'system-instruction' }, async $ => {
    const saved = await load($)
    await update($, lines, () => saved)
    await $.ui.open({ id: PANE, title: 'System instruction', focus: true })

    return { text: 'System instruction panel opened.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const text = (await load($)).join('\n').trim()

    if (!text) {
      return result
    }

    return {
      sections: [
        ...result.sections,
        { id: 'system-instruction:text', text, scope: 'session' as const },
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, lines)
    const at = await read($, editing)

    const onSubmit = async (value: string) => {
      const current = await read($, lines)
      const index = await read($, editing)
      const text = value.trim()

      if (index !== null) {
        const next = text
          ? current.map((line, i) => (i === index ? text : line))
          : current.filter((_, i) => i !== index)
        await save($, next)
        await update($, editing, () => null)
      } else if (text) {
        await save($, [...current, text])
      }
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>
          Sent to the model at every session start, /clear included. One line per row.
        </Text>
        {list.length === 0 && <Text dimColor>(empty)</Text>}
        {list.map((line, i) => (
          <Box>
            <Button
              key={`edit-${i}`}
              label={at === i ? '✎' : 'edit'}
              onPress={() => update($, editing, () => i)}
            />
            <Button
              key={`del-${i}`}
              label="✕"
              onPress={async () => {
                await save($, (await read($, lines)).filter((_, j) => j !== i))
                await update($, editing, () => null)
              }}
            />
            <Text bold={at === i}> {line}</Text>
          </Box>
        ))}
        <Input
          key={`input-${at ?? 'new'}`}
          label={at === null ? 'add> ' : `edit ${at + 1}> `}
          placeholder={at === null ? 'type a line, Enter to add' : 'Enter to save, empty deletes'}
          value={at === null ? '' : (list[at] ?? '')}
          submitLabel={at === null ? 'add' : 'save'}
          onSubmit={onSubmit}
        />
        {at !== null && <Button label="cancel edit" onPress={() => update($, editing, () => null)} />}
      </Box>
    )
  })
}
