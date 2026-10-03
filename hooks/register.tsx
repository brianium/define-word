import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Definition } from '../types'

const PANE = 'define-word'
const POLL_MS = 150
// How long a selection must hold still to count as done: a drag can pause
// mid-word for a poll or two, and no event says the mouse came up.
const SETTLE_MS = 450
// The dictionary answers a word it knows in well under a second, and hangs on
// one it lacks; past this, Haiku is asked too and the first answer wins.
const HEDGE_MS = 700
const DICTIONARY_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/'

const entry = atom({ plugin: 'define-word', key: 'entry' } as const, null)

type DictionaryMeaning = {
  partOfSpeech?: string
  definitions?: { definition?: string; example?: string }[]
}
type DictionaryEntry = { word?: string; phonetic?: string; meanings?: DictionaryMeaning[] }

/**
 * A selection worth defining: one to three words, no line breaks, with the
 * surrounding punctuation trimmed. Anything else (a code block, a paragraph
 * selected to copy) is left alone.
 */
export const asTerm = (text: string, maxWords = 3): string | undefined => {
  // A line break is a block; a leading -, /, ~, $, @ or backtick is a flag,
  // a path, a command or a variable.
  if (/[\r\n]/.test(text) || /^[-/~$@`]/.test(text.trim())) return undefined
  const term = text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  const words = term.split(/\s+/).filter(Boolean)
  const isTermLike =
    words.length >= 1 &&
    words.length <= maxWords &&
    term.length <= 48 &&
    // Letters, hyphens and apostrophes only: a path, a flag, an env var or
    // anything with digits in it was selected to copy, not to look up.
    /^[\p{L}\p{M}'’\s-]+$/u.test(term) &&
    // camelCase is an identifier; acronyms (API) and capitals (Claude) pass.
    !/\p{Ll}\p{Lu}/u.test(term)

  return isTermLike ? term : undefined
}

const clip = (text: string, length: number) =>
  text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`

/** The dictionary's JSON as a brief line for the toast and markdown for the pane. */
export const fromDictionary = (term: string, body: string): Definition | undefined => {
  let entries: DictionaryEntry[]
  try {
    entries = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!Array.isArray(entries) || entries.length === 0) return undefined

  const first = entries[0]
  const meanings = entries.flatMap(one => one.meanings ?? [])
  const firstSense = meanings.find(m => m.definitions?.[0]?.definition)
  if (firstSense === undefined) return undefined

  const lines = [`## ${first?.word ?? term}${first?.phonetic ? `  \`${first.phonetic}\`` : ''}`]
  for (const meaning of meanings.slice(0, 4)) {
    lines.push('', `*${meaning.partOfSpeech ?? 'sense'}*`)
    for (const [i, sense] of (meaning.definitions ?? []).slice(0, 3).entries()) {
      lines.push(`${i + 1}. ${sense.definition ?? ''}`)
      if (sense.example) lines.push(`   > ${sense.example}`)
    }
  }

  return {
    term,
    brief: `${term} (${firstSense.partOfSpeech}): ${firstSense.definitions?.[0]?.definition}`,
    markdown: lines.join('\n'),
  }
}

// Module state; a reload starts it over, which only empties the cache.
const cache = new Map<string, Definition | undefined>()
let candidate = ''
let held = 0
let shown = ''
let isPolling = false

/** Resolves the first promise to give a value, or undefined once none has. */
export const firstDefined = <T,>(promises: Promise<T | undefined>[]): Promise<T | undefined> =>
  new Promise(resolve => {
    let pending = promises.length
    for (const promise of promises) {
      void promise.then(value => {
        pending -= 1
        if (value !== undefined) resolve(value)
        else if (pending === 0) resolve(undefined)
      })
    }
  })

async function fromHaiku($: EngineInterface, term: string): Promise<Definition | undefined> {
  const reply = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 400,
    timeoutMs: 15000,
    system:
      'You are a concise dictionary. Define the term the user gives in its most common sense; ' +
      'for technical jargon, its usual technical sense. No preamble.',
    prompt:
      `Term: ${term}\n\nReply in exactly this shape:\n` +
      'LINE: <part of speech>: <one-sentence definition, under 25 words>\n' +
      'FULL:\n<a short markdown entry: part of speech in italics, 1-3 numbered senses, one example>',
  })
  if (!reply.isAnswered) return undefined
  const line = /LINE:\s*(.+)/.exec(reply.text)?.[1]?.trim()
  const full = /FULL:\s*([\s\S]+)/.exec(reply.text)?.[1]?.trim()
  if (!line) return undefined

  return {
    term,
    brief: `${term} (${line.replace(/:\s*/, '): ')}`,
    markdown: `## ${term}\n\n${full ?? line}\n\n*Defined by Haiku: no dictionary entry.*`,
  }
}

/**
 * The free dictionary first. A quick miss goes straight to Haiku; a slow
 * answer (it hangs on words it lacks) races Haiku from HEDGE_MS on.
 */
async function define($: EngineInterface, term: string): Promise<Definition | undefined> {
  const key = term.toLowerCase()
  if (cache.has(key)) return cache.get(key)

  const dictionary = $.http
    .fetch(DICTIONARY_URL + encodeURIComponent(key))
    .then(r => (r.ok ? fromDictionary(term, r.text) : undefined))
    .catch(() => undefined)
  const slow = new Promise<'slow'>(resolve => {
    $.clock.after(HEDGE_MS, () => resolve('slow'))
  })
  const early = await Promise.race([dictionary, slow])

  const found =
    early === 'slow'
      ? await firstDefined([dictionary, fromHaiku($, term)])
      : (early ?? (await fromHaiku($, term)))

  if (found !== undefined) cache.set(key, found)
  return found
}

/** Watches the mouse selection; a term held still for SETTLE_MS gets a toast. */
async function poll($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    const selected = await $.ui.selection()
    const text = selected?.text ?? ''
    if (text !== candidate) {
      candidate = text
      held = 0
      return
    }
    held += 1
    if (held * POLL_MS < SETTLE_MS || text === shown) return
    shown = text

    const term = asTerm(text)
    if (term === undefined) return
    $.ui.status(`define: looking up “${term}”…`)
    const found = await define($, term)
    $.ui.status(undefined)
    // The drag went on while this looked up a fragment of the word; the
    // whole word gets its own toast once it settles.
    if ((await $.ui.selection())?.text !== text) return
    $.ui.toast(
      found ? `${clip(found.brief, 220)}  · /define for more` : `${term}: no definition found`,
      { timeoutMs: 9000 },
    )
  } finally {
    isPolling = false
  }
}

const CONTEXT_QUESTION = (term: string) =>
  `In 2-4 sentences of plain prose, explain what "${term}" means as it is used in this ` +
  `conversation and how it applies to what we are discussing. If it has not come up, say so ` +
  `in a few words and give the sense most relevant to this conversation's subject.`

/**
 * The newest messages' text, oldest first, within `budget` characters. Tool
 * calls and their results are left out; what was said carries the meaning.
 */
export const excerpt = (messages: { role: string; text: string }[], budget = 24000): string => {
  const lines: string[] = []
  let used = 0
  for (const message of [...messages].reverse()) {
    const text = message.text.trim()
    if (text === '') continue
    const line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${clip(text, 2000)}`
    if (used + line.length > budget) break
    lines.unshift(line)
    used += line.length
  }
  return lines.join('\n\n')
}

/**
 * A fork has nothing to replay until this process has sent a request, as on
 * a resumed session before its first turn; Haiku reads the transcript instead.
 */
async function fromTranscript($: EngineInterface, term: string): Promise<string> {
  const transcript = excerpt(await $.session.messages())
  if (transcript === '') return '*No conversation yet to read it against.*'

  const reply = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 400,
    timeoutMs: 20000,
    system: 'You explain terms as a conversation uses them. Plain prose, no preamble.',
    prompt: `<conversation>\n${transcript}\n</conversation>\n\n${CONTEXT_QUESTION(term)}`,
  })
  return reply.isAnswered
    ? `${reply.text.trim()}\n\n*Read by Haiku from the recent transcript.*`
    : `*Could not ask the model: ${reply.reason}.*`
}

async function fillContext($: EngineInterface, term: string) {
  const reply = await $.model.fork({
    prompt: `[define-word] Pause the task; do not call tools. ${CONTEXT_QUESTION(term)}`,
  })
  const text = reply.isAnswered
    ? reply.text.trim()
    : reply.reason === 'nothing-to-fork'
      ? await fromTranscript($, term)
      : `*Could not ask the model: ${reply.reason}.*`
  await update($, entry, now => (now?.term === term ? { ...now, context: text } : now))
}

async function fillDictionary($: EngineInterface, term: string) {
  const found = await define($, term)
  const text = found?.markdown ?? `## ${term}\n\n*No definition found.*`
  await update($, entry, now => (now?.term === term ? { ...now, dictionary: text } : now))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'define',
      description: 'Define the selected word (or the one given), with its meaning in this conversation',
      argumentHint: '[word]',
      immediate: true,
    })
    $.clock.every(POLL_MS, () => void poll($))

    return next(e)
  })

  on('command.run', { command: 'define' }, async ($, e) => {
    const typed = e.args.trim()
    const selected = typed === '' ? (await $.ui.selection())?.text : undefined
    const term = typed !== '' ? clip(typed, 80) : selected ? asTerm(selected, 6) : undefined

    if (term === undefined) {
      $.ui.toast('define: select a word first, or type /define <word>')
      return {}
    }

    await update($, entry, () => ({ term, dictionary: null, context: null }))
    await $.ui.open({ id: PANE, title: `Define: ${clip(term, 30)}` })
    void fillDictionary($, term)
    void fillContext($, term)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Markdown, Text, Button } = $.ui.resolve(e)
    const now = await read($, entry)

    if (now === null) {
      return <Text dimColor>Select a word and run /define.</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        {now.dictionary === null ? (
          <Text dimColor>Looking up “{now.term}”…</Text>
        ) : (
          <Markdown text={clip(now.dictionary, 6000)} />
        )}
        <Text bold>In this conversation</Text>
        {now.context === null ? (
          <Text dimColor>Reading the conversation…</Text>
        ) : (
          <Markdown text={clip(now.context, 3000)} />
        )}
        <Button key="close" label="Close" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )
  })
}
