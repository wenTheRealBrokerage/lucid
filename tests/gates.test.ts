import { describe, expect, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'

import { OFFER_LABEL, describeQuestions } from '../hooks/page'
import type { Job, Pending } from '../types'

import { PANE, PANE_PROPS, world } from './world'

// The hooks around the pane: who the offer is drawn for, what `/explain`
// starts, and what each refusal tells Claude and the person.

const QUESTION = {
  question: 'Which lock should the ledger use?',
  header: 'Locking',
  multiSelect: false,
  options: [
    { label: 'Optimistic', description: 'retry on a clash' },
    { label: 'Pessimistic', description: 'hold the row' },
  ],
}
const ASK = { tool: 'AskUserQuestion' as const, tool_use_id: 'toolu_1', questions: [QUESTION] }
const OPEN: Pending = { id: 'toolu_1', questions: [QUESTION], at: 0, isOpen: true }
const DIALOG = { plugin: 'lucid', surface: 'terminal' as const, component: 'AskUserQuestion' as const, props: { tool: 'AskUserQuestion', questions: [QUESTION] } }
const PICKED = { dialog: { [QUESTION.question]: OFFER_LABEL } }
/** What the engine answers beneath every plugin for a dialog: its own drawing of the props it was handed. */
const ENGINE_DIALOG = { type: 'engine', ref: 0 } as const

const job = (change: Partial<Job>): Job => ({
  id: 'j1',
  origin: 'option',
  question: describeQuestions([QUESTION]),
  stage: 'building',
  note: 'the builder is writing the explainer',
  dir: '/data/jobs/j1',
  startedAt: 0,
  sections: [],
  ...change,
})

const explain = ($: Engine, args: string) => $.command.run({ command: 'explain', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

describe('the offer', () => {
  test("the model's own question gains the offer and is kept for /explain", async ($, on) => {
    const seen = world(on)
    await $.tool.call(ASK)
    expect(seen.dialogs.map(one => one.labels)).toEqual([[['Optimistic', 'Pessimistic', OFFER_LABEL]]])
    expect(seen.pending()?.id).toBe('toolu_1')
  })

  test(
    "another plugin's $.ui.ask dialog is left alone",
    {
      plugins: [
        {
          name: 'other',
          register(on) {
            on('command.run', { command: 'ask-other' }, async $ => ({ text: await $.ui.ask('Delete the branch?', ['Yes', 'No']) }))
          },
        },
      ],
    },
    async ($, on) => {
      const seen = world(on)
      const origin = { kind: 'composer' } as const
      const presentation = { isFullscreen: true, columns: 120 }
      expect((await $.command.run({ command: 'ask-other', args: '', origin, presentation })).text).toBe('Yes')
      expect(seen.dialogs.map(one => one.labels)).toEqual([[['Yes', 'No']]])
      expect(seen.pending()).toBeNull()
    },
  )

  test('the button is drawn for the pending dialog only', async ($, on) => {
    world(on, { pending: OPEN })
    on('ui.render', { component: 'AskUserQuestion' }, () => ENGINE_DIALOG)
    const own = await $.ui.mount({ ...DIALOG, requestId: 'toolu_1' })
    expect(await own.find({ key: 'lucid-explain' })).toBeDefined()
    await own.unmount()
    const another = await $.ui.mount({ ...DIALOG, requestId: 'toolu_2' })
    expect(await another.find({ key: 'lucid-explain' })).toBeUndefined()
    await another.unmount()
  })

  test('/explain set offer off takes the button away as well as the option', async ($, on) => {
    const seen = world(on, { pending: OPEN, store: { settings: { shouldOffer: false } } })
    on('ui.render', { component: 'AskUserQuestion' }, () => ENGINE_DIALOG)
    const ui = await $.ui.mount({ ...DIALOG, requestId: 'toolu_1' })
    expect(await ui.find({ key: 'lucid-explain' })).toBeUndefined()
    await ui.unmount()
    await $.tool.call({ ...ASK, tool_use_id: 'toolu_2' })
    expect(seen.dialogs.at(-1)?.labels).toEqual([['Optimistic', 'Pessimistic']])
    expect(seen.pending()?.id).toBe('toolu_2')
  })

  test('picking the offer while another question is being built says so to Claude and to the person', async ($, on) => {
    const seen = world(on, { job: job({ question: 'another question' }), answers: PICKED })
    const ran = await $.tool.call(ASK)
    expect(ran.deny).toContain('did not start an explainer for this question')
    expect(ran.deny).not.toContain('is building it now')
    expect(seen.toasts.join('\n')).toContain('an explainer is already being built')
    expect(seen.job()?.question).toBe('another question')
  })

  test('picking the offer while this very question is being built still tells Claude it is building', async ($, on) => {
    const seen = world(on, { job: job({ origin: 'button' }), answers: PICKED })
    const ran = await $.tool.call(ASK)
    expect(ran.deny).toContain('The lucid mod is building it now')
    expect(seen.toasts).toEqual([])
  })
})

describe('/explain', () => {
  test('an unknown word answers with the usage and starts nothing', async ($, on) => {
    const seen = world(on)
    const ran = await explain($, 'stauts')
    expect(ran.text).toContain('/explain has no "stauts"')
    expect(ran.text).toContain('about <text>')
    await seen.clock.advance(5)
    expect(seen.job()).toBeNull()
    expect(seen.modelCalls).toEqual([])
    expect(seen.spawns).toEqual([])
  })

  test('about <text> starts a build of that text', async ($, on) => {
    const seen = world(on)
    expect((await explain($, 'about why the lock matters')).text).toContain('rating the question')
    await seen.clock.advance(5)
    expect(seen.job()?.question).toBe('why the lock matters')
    expect(seen.modelCalls).toHaveLength(1)
  })
})

describe('ask me again', () => {
  const done = job({ stage: 'done', dialogId: 'toolu_1', title: 'Locks', sections: [{ id: 'a', heading: 'A', markdown: 'text' }] })

  test('is offered while the dialog the explainer came from is still the last question', async ($, on) => {
    world(on, { job: done, pending: { ...OPEN, isOpen: false } })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect(await ui.find({ key: 'again' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· a$/ })).toBeDefined()
    await ui.unmount()
  })

  test('is gone on a recalled explainer, with no question pending', async ($, on) => {
    world(on, { job: done, pending: null })
    const recalled = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect(await recalled.find({ key: 'again' })).toBeUndefined()
    expect(await recalled.find({ type: 'Text', text: /· a$/ })).toBeUndefined()
    await recalled.unmount()
  })

  test('is gone after a later question', async ($, on) => {
    world(on, { job: done, pending: { ...OPEN, id: 'toolu_9', isOpen: false } })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect(await ui.find({ key: 'again' })).toBeUndefined()
    await ui.unmount()
  })
})
