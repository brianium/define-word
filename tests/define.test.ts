import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'

import { asTerm, firstDefined, fromDictionary } from '../hooks/register'

const USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const DICTIONARY = JSON.stringify([
  {
    word: 'idempotent',
    phonetic: '/aɪ.dəmˈpoʊ.tənt/',
    meanings: [
      {
        partOfSpeech: 'adjective',
        definitions: [{ definition: 'Having no further effect after the first application.' }],
      },
    ],
  },
])

/** The world beneath the mod: a dictionary that knows one word, Haiku, a fork, a pane, toasts. */
const world = (on: On, selection: { text?: string }, hangingOn?: MockClock) => {
  const toasts: string[] = []
  on('http.fetch', async (_$, e) => {
    // The live API hangs about 20 s on a word it lacks, then answers 522.
    if (hangingOn !== undefined) {
      await hangingOn.sleep(20000)
      return { value: { status: 522, ok: false, headers: {}, text: 'error code: 522' } }
    }
    return { value: e.url.endsWith('/idempotent')
      ? { status: 200, ok: true, headers: {}, text: DICTIONARY }
      : { status: 404, ok: false, headers: {}, text: '{}' } }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: 'LINE: noun: a made-up word\nFULL:\n*noun*\n1. A made-up word.',
      usage: USAGE,
    },
  }))
  on('model.fork', () => ({
    value: { isAnswered: true, text: 'Here it means retries cannot double-charge.', usage: USAGE },
  }))
  on('ui.selection', () => ({
    value: selection.text === undefined ? undefined : { text: selection.text },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  return toasts
}

test('asTerm keeps short terms and skips paragraphs and code', () => {
  expect(asTerm('  idempotent, ')).toBe('idempotent')
  expect(asTerm('(prompt cache)')).toBe('prompt cache')
  expect(asTerm('one two three four')).toBe(undefined)
  expect(asTerm('line one\nline two')).toBe(undefined)
  expect(asTerm('42')).toBe(undefined)
})

test('fromDictionary gives a brief line and a markdown entry', () => {
  const found = fromDictionary('idempotent', DICTIONARY)
  expect(found?.brief).toBe(
    'idempotent (adjective): Having no further effect after the first application.',
  )
  expect(found?.markdown.includes('*adjective*')).toBe(true)
  expect(fromDictionary('x', 'error code: 522')).toBe(undefined)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/define fills the pane with the entry and its meaning here (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    world(on, { text: 'idempotent' })

    const ran = await $.command.run({
      command: 'define',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })
    expect(ran.text).toBe(undefined)
    await clock.settle()

    const pane = await $.ui.mount({
      plugin: 'define-word',
      surface,
      component: 'Pane',
      requestId: 'define-word',
      props: {
        title: 'Define: idempotent',
        isFocused: false,
        bodyColumns: 50,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    const drawn = JSON.stringify(await pane.drawn())
    expect(drawn.includes('Having no further effect')).toBe(true)
    expect(drawn.includes('retries cannot double-charge')).toBe(true)
  })
}

test('a held selection gets a toast once; a word the dictionary lacks falls back to Haiku', async ($, on) => {
  const clock = mock.clock(on)
  const selection = { text: 'idempotent' }
  const toasts = world(on, selection)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  expect(toasts.length).toBe(1)
  expect(toasts[0]?.startsWith('idempotent (adjective)')).toBe(true)

  selection.text = 'frobnicate'
  await clock.advance(2000)
  expect(toasts.length).toBe(2)
  expect(toasts[1]?.startsWith('frobnicate (noun): a made-up word')).toBe(true)
})

test('firstDefined takes the first value and skips misses', async () => {
  const never = new Promise<string | undefined>(() => {})
  expect(await firstDefined([Promise.resolve(undefined), Promise.resolve('b')])).toBe('b')
  expect(await firstDefined([never, Promise.resolve('fast')])).toBe('fast')
  expect(await firstDefined([Promise.resolve(undefined), Promise.resolve(undefined)])).toBe(undefined)
})

test('a dictionary that hangs loses to Haiku after the hedge', async ($, on) => {
  const clock = mock.clock(on)
  const toasts = world(on, { text: 'polylith' }, clock)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1200)
  expect(toasts.length).toBe(1)
  expect(toasts[0]?.startsWith('polylith (noun): a made-up word')).toBe(true)
})
