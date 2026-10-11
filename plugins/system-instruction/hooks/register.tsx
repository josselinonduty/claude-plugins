import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'system-instruction'
const text = atom({ plugin: 'system-instruction', key: 'text' } as const, '')
const isEditing = atom({ plugin: 'system-instruction', key: 'isEditing' } as const, false)

async function load($: any): Promise<string> {
  const saved = await $.store.get('text')

  if (typeof saved === 'string') {
    return saved
  }

  const legacy = await $.store.get('lines')

  return Array.isArray(legacy) ? legacy.map(String).join('\n') : ''
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await load($)
    await update($, text, () => saved)
    await $.command.register({
      name: 'instructions',
      description: 'Edit the custom system instruction given to the model at every session start',
    })

    return next(e)
  })

  on('command.run', { command: 'instructions' }, async $ => {
    const saved = await load($)
    await update($, text, () => saved)
    await $.ui.open({ id: PANE, title: 'Instructions', focus: true })

    return { text: 'System instruction panel opened.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const instruction = (await load($)).trim()

    if (!instruction) {
      return result
    }

    return {
      sections: [
        ...result.sections,
        { id: 'system-instruction:text', text: instruction, scope: 'session' as const },
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, text)
    const editing = await read($, isEditing)

    const edit = async () => {
      const saved = await load($)
      await $.prompt.fill({ text: saved, mode: 'replace' })
      await update($, isEditing, () => true)
    }

    const save = async () => {
      const box = await $.prompt.read()
      const value = box.text.trim()
      await $.store.set('text', value)
      await update($, text, () => value)
      await $.prompt.fill({ text: '', mode: 'replace' })
      await update($, isEditing, () => false)
      $.ui.toast('System instruction saved')
    }

    const cancel = async () => {
      await $.prompt.fill({ text: '', mode: 'replace' })
      await update($, isEditing, () => false)
    }

    return (
      <Box flexDirection="column">
        <Text bold>Initial instructions</Text>
        {current ? <Text>{current}</Text> : <Text dimColor>Nothing set yet.</Text>}
        {editing ? (
          <Box flexDirection="column">
            <Text dimColor>
              Editing in the prompt box below (Shift+Enter for a new line). Do not press Enter to
              send; press Save.
            </Text>
            <Box>
              <Button key="save" label="Save" hotkey="s" onPress={save} />
              <Button key="cancel" label="Cancel" hotkey="c" onPress={cancel} />
            </Box>
          </Box>
        ) : (
          <Button key="edit" label="Edit" hotkey="e" onPress={edit} />
        )}
      </Box>
    )
  })
}
