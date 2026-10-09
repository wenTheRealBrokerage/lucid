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

describe('/explain publish', () => {
  const paged = job({ origin: 'command', stage: 'done', note: 'page written', title: 'Locks', finishedAt: 10, file: '/data/jobs/j1/explainer.html', sections: [{ id: 'a', heading: 'A', markdown: 'text' }] })
  const armed = { settings: { shouldPublish: true } }

  test('is off until it is armed: nothing is asked and nothing is uploaded', async ($, on) => {
    const seen = world(on, { job: paged })
    expect((await explain($, 'publish')).text).toBe('publishing is off; /explain set publish on arms this command')
    await seen.clock.advance(5)
    expect(seen.asked).toEqual([])
    expect(seen.artifacts).toEqual([])
  })

  test('needs a page, and a session that has the Artifact tool', async ($, on) => {
    const { file: _file, ...pageless } = paged
    const seen = world(on, { job: pageless, store: armed, tools: [] })
    expect((await explain($, 'publish')).text).toBe('there is no page to publish; /explain page builds one')
    seen.setJob(paged)
    expect((await explain($, 'publish')).text).toBe('this session has no Artifact tool, so the page stays local')
    await seen.clock.advance(5)
    expect(seen.asked).toEqual([])
    expect(seen.artifacts).toEqual([])
  })

  test('armed and declined uploads nothing', async ($, on) => {
    const seen = world(on, { job: paged, store: armed, answers: { ask: ['Keep it local'] } })
    expect((await explain($, 'publish')).text).toBe('asking before anything is uploaded')
    await seen.clock.advance(5)
    expect(seen.asked).toHaveLength(1)
    expect(seen.artifacts).toEqual([])
    expect(seen.logs).toContain('not published; the page stays on this machine')
    expect(seen.job()?.url).toBeUndefined()
  })

  test('armed and accepted makes exactly one Artifact call, for the page file', async ($, on) => {
    const seen = world(on, { job: paged, store: armed, answers: { ask: ['Publish'] } })
    await explain($, 'publish')
    await seen.clock.advance(5)
    expect(seen.artifacts).toHaveLength(1)
    expect(seen.artifacts[0]).toMatchObject({ tool: 'Artifact', action: 'publish', file_path: '/data/jobs/j1/explainer.html' })
    expect(seen.job()).toMatchObject({ stage: 'done', url: 'https://claude.ai/artifact/a1', note: 'published privately' })
    expect(seen.logs).toContain('published privately: https://claude.ai/artifact/a1')
  })
})

describe('what a build sends', () => {
  const built = { '*/explainer.json': JSON.stringify({ title: 'Locks', sections: [{ id: 'a', heading: 'A', markdown: 'text' }] }) }

  test('the offer alone spends nothing: no model call, no subagent, no request', async ($, on) => {
    const seen = world(on, { env: { LUCID_ROSTER_SOURCE: 'api' }, hasLogin: true })
    await $.tool.call(ASK)
    await seen.clock.advance(5)
    expect(seen.modelCalls).toEqual([])
    expect(seen.spawns).toEqual([])
    expect(seen.fetches).toEqual([])
    expect(seen.job()).toBeNull()
  })

  test("a whole build makes no Artifact call, and its only request is the roster's list of models", async ($, on) => {
    const seen = world(on, { files: built, env: { LUCID_ROSTER_SOURCE: 'api' }, hasLogin: true })
    await explain($, 'about which lock')
    await seen.clock.advance(5)
    expect(seen.job()?.stage).toBe('done')
    expect(seen.artifacts).toEqual([])
    expect(seen.fetches).toEqual(['https://api.anthropic.com/v1/models?limit=1000'])
    expect(seen.curls).toEqual([])
  })

  test('a build in a session with no login makes no request at all', async ($, on) => {
    const seen = world(on, { files: built, env: { LUCID_ROSTER_SOURCE: 'api' } })
    await explain($, 'about which lock')
    await seen.clock.advance(5)
    expect(seen.job()?.stage).toBe('done')
    expect(seen.fetches).toEqual([])
  })
})

describe('the other /explain words', () => {
  const done = job({ origin: 'command', stage: 'done', note: '0 narrated', title: 'Locks', finishedAt: 2000, sections: [{ id: 'a', heading: 'A', markdown: 'The text of A.' }] })

  test('with nothing built, each word says so and starts nothing', async ($, on) => {
    const seen = world(on)
    expect((await explain($, 'status')).text).toBe('no explainer yet')
    expect((await explain($, 'view')).text).toBe('no explainer yet')
    expect((await explain($, 'stop')).text).toBe('narration stopped')
    expect((await explain($, 'cancel')).text).toBe('nothing is being built')
    expect((await explain($, 'open')).text).toBe('there is no page to open yet')
    expect((await explain($, 'revoice')).text).toBe('there is no finished explainer to voice again')
    expect((await explain($, 'page')).text).toBe('there is no finished explainer to build a page from')
    expect((await explain($, '')).text).toBe('there is no question to explain yet. Run /explain after Claude asks one, or /explain about <text>.')
    await seen.clock.advance(5)
    expect(seen.job()).toBeNull()
    expect(seen.modelCalls).toEqual([])
  })

  test('view reports the explainer where the pane is placed, and prints the section where it is not', async ($, on) => {
    world(on, { job: done, isPlaced: false })
    expect((await explain($, 'view')).text).toBe('Locks (1/1): A\n\nThe text of A.')
  })

  test('status tells the stage, the note and how long the build took', async ($, on) => {
    world(on, { job: done })
    expect((await explain($, 'status')).text).toBe('done: 0 narrated | 2 s')
    expect((await explain($, 'view')).text).toBe('done: 0 narrated | 2 s')
  })

  test('a bare /explain builds the last question Claude asked', async ($, on) => {
    const seen = world(on, { pending: { ...OPEN, isOpen: false } })
    expect((await explain($, '')).text).toContain('rating the question')
    expect(seen.job()).toMatchObject({ origin: 'command', question: describeQuestions([QUESTION]) })
    expect(seen.job()?.dialogId).toBeUndefined()
  })

  test('set lists the switches and turns one', async ($, on) => {
    world(on)
    expect((await explain($, 'set')).text).toBe('switches: offer on, confirm off, open on, publish off, animate on. Change one with /explain set <offer | confirm | open | publish | animate> <on | off>.')
    expect((await explain($, 'set publish on')).text).toBe('publish is on')
    expect((await explain($, 'set animate off')).text).toBe('animate is off')
    expect((await explain($, 'set nothing on')).text).toContain('switches: offer on, confirm off, open on, publish on, animate off.')
    expect((await explain($, 'set offer maybe')).text).toContain('switches: offer on')
  })

  test('tts reports the engine, sets the system voice, and names the engines for anything else', async ($, on) => {
    world(on)
    expect((await explain($, 'tts')).text).toBe('speech: say; ffmpeg found. Engines: say [voice], kokoro, hosted.')
    expect((await explain($, 'tts say Samantha')).text).toBe('speech: the macOS system voice "Samantha", on this machine')
    expect((await explain($, 'tts')).text).toContain('speech: say (Samantha)')
    expect((await explain($, 'tts loud')).text).toBe('speech engines are say [voice], kokoro and hosted')
    expect((await explain($, 'tts hosted')).text).toBe('hosted speech needs LUCID_TTS_URL and LUCID_TTS_API_KEY in the environment (and optionally LUCID_TTS_MODEL)')
  })

  test('outside an interactive session nothing starts and no offer is added', async ($, on) => {
    const seen = world(on, { isInteractive: false })
    expect((await explain($, 'about which lock')).text).toBe('explainers need an interactive session')
    await $.tool.call(ASK)
    expect(seen.dialogs.at(-1)?.labels).toEqual([['Optimistic', 'Pessimistic']])
    await seen.clock.advance(5)
    expect(seen.job()).toBeNull()
  })

  test('with confirm on, the pick is shown first, a step stronger is one rung up, and Cancel builds nothing', async ($, on) => {
    const seen = world(on, { store: { settings: { shouldConfirm: true } }, answers: { ask: ['One step stronger', 'Cancel'] } })
    await explain($, 'about which lock')
    await seen.clock.advance(5)
    expect(seen.asked).toHaveLength(2)
    expect(seen.asked[0]).toContain('lucid rated this question simple. Build the explainer with claude-sonnet-5-5 at medium effort')
    expect(seen.asked[1]).toContain('claude-sonnet-5-5 at high effort')
    expect(seen.job()).toMatchObject({ stage: 'cancelled', note: 'cancelled before building' })
    expect(seen.spawns).toEqual([])
  })
})

describe('/explain-models', () => {
  const models = ($: Engine, args: string) => $.command.run({ command: 'explain-models', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  test('use maps a role to a family', async ($, on) => {
    world(on)
    expect((await models($, 'use fast sonnet')).text).toBe('the "fast" role now uses the "sonnet" family')
  })

  test('outside an interactive session it lists the roster and tries no writer', async ($, on) => {
    const seen = world(on, { isInteractive: false })
    expect((await models($, '')).text).toBe('models, from the fallback: claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5, claude-fable-5-1')
    await seen.clock.advance(5)
    expect(seen.spawns).toEqual([])
  })
})
