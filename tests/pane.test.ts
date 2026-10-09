import { describe, expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import type { Job } from '../types'

// The pane through the testing kit: the trees lucid returns for a finished
// explainer on each surface, and what its hotkey Buttons do. The kit never
// paints and has no audio or files, so narration playback is covered by the
// pure helpers in explainer.test.ts.

const PANE = { plugin: 'lucid', component: 'Pane', requestId: 'lucid' } as const
const PROPS = { title: 'Explainer', isFocused: true, bodyColumns: 63, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
/** Seeds lucid's job: the test answers its `state.get` beneath the plugin, as the kit's mocks answer the other nouns. */
const seedJob = (on: On, value: Job | null): void => {
  on('state.get', { plugin: 'lucid', key: 'job' }, () => ({ value: { value, version: 1 } }))
}

const DONE: Job = {
  id: 'j1',
  origin: 'option',
  question: 'Which lock?',
  stage: 'done',
  note: '2 narrated sections',
  dir: '/data/jobs/j1',
  startedAt: 0,
  finishedAt: 10,
  title: 'Optimistic locking',
  sections: [
    {
      id: 'the-race',
      heading: 'The race',
      markdown: 'Two writers read the same row.',
      diagram: { ascii: ['+---+', '| a |', '+---+'], unicode: ['┌───┐', '│ a │', '└───┘'], maxWidth: 5 },
      takeaway: 'Lost updates make no noise.',
      audio: '/data/jobs/j1/audio/the-race.m4a',
    },
    { id: 'the-fix', heading: 'A version column', markdown: 'Add a version.', steps: ['read v7', 'work', 'write if still v7'] },
    { id: 'side-by-side', heading: 'Side by side', markdown: '| a | b |\n| --- | --- |\n| 1 | 2 |' },
  ],
}

/** A job as job.json keeps it: through JSON, with no file and no url. */
const kept = (): Job => JSON.parse(JSON.stringify(DONE)) as Job

const textOf = async (ui: { findAll: (query: { type: 'Text' }) => Promise<{ text: string }[]> }): Promise<string> => (await ui.findAll({ type: 'Text' })).map(one => one.text).join('\n')

describe('the explainer pane', () => {
  test('a kept job draws its title, the first section, its diagram as a Code card and its takeaway; no page button without a file or url', async ($, on) => {
    mock.store(on)
    mock.env(on, { TERM_PROGRAM: 'iTerm.app' })
    seedJob(on, kept())
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    const text = await textOf(ui)
    expect(text).toContain('Optimistic locking')
    expect(text).toContain('The race')
    expect(text).toContain('1 / 3')
    expect((await ui.find({ key: 'tab-1' }))?.text).toContain('A version column')
    expect(text).toContain('Lost updates make no noise.')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('┌───┐\n│ a │\n└───┘')
    expect((await ui.find({ type: 'Code' }))?.props.wrap).toBe('truncate-end')
    expect(await ui.find({ key: 'open' })).toBeUndefined()
    expect(await ui.find({ key: 'play' })).toBeDefined()
    await ui.unmount()
  })

  test('an unverified terminal gets the ascii diagram, and a page button appears once a file exists', async ($, on) => {
    mock.store(on)
    mock.env(on, { TERM: 'xterm-256color' })
    seedJob(on, { ...kept(), file: '/data/jobs/j1/explainer.html' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('+---+\n| a |\n+---+')
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  })

  test('prev and next walk the sections; contents lists them and a digit jumps', async ($, on) => {
    mock.store(on)
    mock.env(on, {})
    seedJob(on, kept())
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    await ui.press({ key: 'next' })
    expect(await textOf(ui)).toContain('2 / 3')
    await ui.press({ key: 'prev' })
    expect(await textOf(ui)).toContain('1 / 3')
    await ui.press({ key: 'tab-2' })
    expect(await textOf(ui)).toContain('3 / 3')
    await ui.press({ key: 'tab-0' })
    await ui.press({ key: 'toc' })
    expect(await textOf(ui)).toContain('CONTENTS')
    expect((await ui.findAll({ type: 'Button' })).filter(one => String(one.key).startsWith('toc-go-'))).toHaveLength(3)
    expect((await ui.find({ key: 'toc-go-2' }))?.props.hotkey).toBe('3')
    await ui.press({ key: 'toc-go-2' })
    const text = await textOf(ui)
    expect(text).not.toContain('CONTENTS')
    expect(text).toContain('Side by side')
    // The table is lucid's own drawing, not a Markdown element the engine would draw dim.
    expect((await ui.findAll({ type: 'Markdown' })).some(one => String(one.props.text).includes('| ---'))).toBe(false)
    expect(await ui.find({ type: 'Text', text: /^a$/ })).toBeDefined()
    await ui.unmount()
  })

  test('two presses before a redraw both land, for sections and for frames', async ($, on) => {
    mock.store(on)
    mock.env(on, {})
    seedJob(on, kept())
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    await Promise.all([ui.press({ key: 'next' }), ui.press({ key: 'next' })])
    expect(await textOf(ui)).toContain('3 / 3')
    await Promise.all([ui.press({ key: 'prev' }), ui.press({ key: 'prev' })])
    expect(await textOf(ui)).toContain('1 / 3')
    await ui.press({ key: 'next' })
    await Promise.all([ui.press({ key: 'frame' }), ui.press({ key: 'frame' })])
    expect(await textOf(ui)).toContain('●━●━◉')
    await Promise.all([ui.press({ key: 'auto' }), ui.press({ key: 'auto' })])
    expect(await textOf(ui)).not.toContain('· auto')
    await ui.unmount()
  })

  test('frames step forward and back, and auto-advance runs them on the clock until the last one', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    mock.env(on, {})
    seedJob(on, kept())
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    await ui.press({ key: 'next' })
    expect(await textOf(ui)).toContain('◉━○━○')
    expect(await textOf(ui)).not.toContain('write if still v7')
    await ui.press({ key: 'frame' })
    expect(await textOf(ui)).toContain('●━◉━○')
    await ui.press({ key: 'frame-back' })
    expect(await textOf(ui)).toContain('◉━○━○')

    await ui.press({ key: 'auto' })
    expect(await textOf(ui)).toContain('· auto')
    await clock.advance(2500)
    expect(await textOf(ui)).toContain('●━◉━○')
    await clock.advance(2500)
    expect(await textOf(ui)).toContain('●━●━◉')
    await clock.advance(2500)
    expect(await textOf(ui)).not.toContain('· auto')
    expect((await ui.find({ key: 'auto' }))?.props.label).toBe('⟳ Auto')
    await ui.unmount()
  })

  test('with animate off there is no auto button', async ($, on) => {
    mock.store(on, { settings: { shouldAnimate: false } })
    mock.env(on, {})
    seedJob(on, kept())
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    await ui.press({ key: 'next' })
    expect(await ui.find({ key: 'frame' })).toBeDefined()
    expect(await ui.find({ key: 'auto' })).toBeUndefined()
    await ui.unmount()
  })

  test('the focus hint shows only while the pane does not hold the keys', async ($, on) => {
    mock.store(on)
    mock.env(on, {})
    seedJob(on, kept())
    const focused = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    expect(await textOf(focused)).not.toContain('ctrl+x tab')
    await focused.unmount()
    const idle = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PROPS, isFocused: false } })
    expect(await textOf(idle)).toContain('ctrl+x tab to take the keys')
    await idle.unmount()
  })

  test('off the terminal the tree is Box, Text, Markdown and Button only: the diagram becomes a fence', async ($, on) => {
    mock.store(on)
    mock.env(on, { TERM_PROGRAM: 'iTerm.app' })
    seedJob(on, kept())
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      const fences = (await ui.findAll({ type: 'Markdown' })).filter(one => String(one.props.text).startsWith('```text'))
      expect(fences).toHaveLength(1)
      expect(await ui.find({ type: 'Text', text: /The race/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a table too wide for the pane is handed to Markdown as it was written, escapes and alignment kept', async ($, on) => {
    const source = '| a | b | c | d | e | f | g |\n| :--- | ---: | --- | --- | --- | --- | --- |\n| 1 | x \\| y | 3 | 4 | 5 | 6 | 7 |'
    mock.store(on)
    mock.env(on, {})
    seedJob(on, { ...kept(), sections: [{ id: 'wide', heading: 'Wide', markdown: source }] })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PROPS, bodyColumns: 20 } })
    expect((await ui.findAll({ type: 'Markdown' })).map(one => one.props.text)).toEqual([source])
    await ui.unmount()
  })

  test('a failed job whose note quotes a control character still draws', async ($, on) => {
    mock.store(on)
    mock.env(on, {})
    seedJob(on, { ...kept(), stage: 'failed', sections: [], note: 'the explainer failed its checks: section id "a\u0008b" is not kebab-case' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    expect(await textOf(ui)).toContain('section id "a b" is not kebab-case')
    await ui.unmount()
  })

  test('without a job the pane says so', async ($, on) => {
    mock.store(on)
    mock.env(on, {})
    seedJob(on, null)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    expect(await textOf(ui)).toContain('No explainer in this session yet.')
    await ui.unmount()
  })
})
