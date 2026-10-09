import { describe, expect, test } from 'claude-code/testing'

import type { Job } from '../types'

import { PANE, PANE_PROPS, explain, world } from './world'

// A build from start to finish through the testing kit, and what a cancel, a
// second start, a reload and a recall do to it at each stage. The kit starts
// no subagent, so each test seeds the file a builder would have written and
// narration falls back to the sections as written.

const DOCUMENT = JSON.stringify({
  title: 'Lock choice',
  sections: [
    { id: 'the-race', heading: 'The race', markdown: 'Two writers read the same row.', narrate: true },
    { id: 'the-fix', heading: 'A version column', markdown: 'Add a version.', narrate: true },
  ],
})
const PAGE = [
  '<title>Ledger Lock Choice</title>',
  '<style>:root{--bg:#fff}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#111}}:root[data-theme="dark"]{--bg:#111}body{background:var(--bg)}</style>',
  '<section data-lucid-section="the-race"><h2>The race</h2></section>',
  '<section data-lucid-section="the-fix"><h2>A version column</h2></section>',
].join('\n')
const BUILT = { '*/explainer.json': DOCUMENT }
const DIR = '/home/.claude/plugins/data/lucid/jobs'
const isSay = (argv: readonly string[]): boolean => argv[0] === 'say'
const says = (processes: string[][]): string[][] => processes.filter(isSay)

const DONE: Job = {
  id: 'j1',
  origin: 'command',
  question: 'Which lock?',
  stage: 'done',
  note: '1 narrated sections',
  dir: `${DIR}/j1`,
  startedAt: 0,
  finishedAt: 10,
  title: 'Lock choice',
  sections: [
    { id: 'the-race', heading: 'The race', markdown: 'Two writers read the same row.', audio: `${DIR}/j1/audio/the-race.m4a` },
    { id: 'the-fix', heading: 'A version column', markdown: 'Add a version.', audio: `${DIR}/j1/audio/the-fix.m4a` },
  ],
}
const KEPT = { store: { lastJob: `${DIR}/j1/job.json` }, files: { [`${DIR}/j1/job.json`]: JSON.stringify(DONE) } }
const SCRIPTS = { [`${DIR}/j1/audio/the-race.txt`]: 'Two writers read the same row.', [`${DIR}/j1/audio/the-race.m4a`]: 'AAAA', [`${DIR}/j1/audio/the-fix.m4a`]: 'AAAA' }

describe('a build', () => {
  test('runs from the rating to a kept explainer with a clip per narrated section', async ($, on) => {
    const seen = world(on, { files: BUILT, runMs: argv => (isSay(argv) ? 1000 : 0) })
    expect((await explain($, 'about which lock')).text).toContain('rating the question')
    await seen.clock.advance(1)
    const id = seen.job()?.id ?? ''
    expect(seen.job()?.stage).toBe('voicing')
    expect(seen.spawns.slice(0, 1)).toEqual(['lucid:explainer'])
    await seen.clock.advance(2000)
    expect(seen.job()?.stage).toBe('done')
    expect(seen.job()?.sections.map(section => section.audio)).toEqual([`${DIR}/${id}/audio/the-race.m4a`, `${DIR}/${id}/audio/the-fix.m4a`])
    expect(says(seen.processes).map(argv => argv[argv.indexOf('-o') + 1])).toEqual([`${DIR}/${id}/audio/the-race.new.m4a`, `${DIR}/${id}/audio/the-fix.new.m4a`])
    expect(seen.toasts.at(-1)).toContain('explainer ready')
    expect(seen.files.has(`${DIR}/${id}/job.json`)).toBe(true)
  })

  test('two starts at once: one builds, the other is told one is already being built', async ($, on) => {
    const seen = world(on, { files: BUILT })
    const texts = (await Promise.all([explain($, 'about a'), explain($, 'about b')])).map(ran => ran.text ?? '')
    expect(texts.filter(text => text.includes('rating the question'))).toHaveLength(1)
    expect(texts.filter(text => text.includes('already being built'))).toHaveLength(1)
    await seen.clock.advance(1)
    expect(seen.modelCalls).toHaveLength(1)
  })
})

describe('a cancel', () => {
  test('while the question is being rated stays cancelled, and the next start is not refused', async ($, on) => {
    const seen = world(on, { files: BUILT, rateMs: 500 })
    await explain($, 'about a')
    await seen.clock.advance(1)
    expect(seen.job()?.stage).toBe('classifying')
    expect((await explain($, 'cancel')).text).toBe('cancelled')
    await seen.clock.advance(500)
    expect(seen.job()?.stage).toBe('cancelled')
    expect(seen.toasts).toEqual([])
    expect(seen.spawns).toEqual([])
    expect((await explain($, 'about b')).text).toContain('rating the question')
  })

  test('while a clip is being rendered is not overwritten by "done", and nothing is kept or announced', async ($, on) => {
    const seen = world(on, { files: BUILT, runMs: argv => (isSay(argv) ? 1000 : 0) })
    await explain($, 'about a')
    await seen.clock.advance(1)
    const id = seen.job()?.id ?? ''
    expect(seen.job()?.stage).toBe('voicing')
    await explain($, 'cancel')
    await seen.clock.advance(5000)
    expect(seen.job()?.stage).toBe('cancelled')
    expect(says(seen.processes)).toHaveLength(1)
    expect(seen.toasts.join('\n')).not.toContain('explainer ready')
    expect(seen.files.has(`${DIR}/${id}/job.json`)).toBe(false)
  })

  test('of one build, then of the next, does not bring the first back to life', async ($, on) => {
    const seen = world(on, { files: BUILT, runMs: argv => (isSay(argv) ? 1000 : 0) })
    await explain($, 'about a')
    await seen.clock.advance(1)
    await explain($, 'cancel')
    await explain($, 'about b')
    await seen.clock.advance(1)
    expect(seen.job()?.question).toBe('b')
    await explain($, 'cancel')
    await seen.clock.advance(5000)
    expect(says(seen.processes)).toHaveLength(2)
    expect(seen.toasts.join('\n')).not.toContain('explainer ready')
    expect(seen.job()).toMatchObject({ question: 'b', stage: 'cancelled' })
  })

  test('of a revoice leaves the finished explainer finished, with its first finish time', async ($, on) => {
    const seen = world(on, { job: DONE, files: SCRIPTS, runMs: argv => (isSay(argv) ? 1000 : 0) })
    await explain($, 'revoice')
    await seen.clock.advance(1)
    expect(seen.job()?.stage).toBe('voicing')
    expect((await explain($, 'cancel')).text).toBe('cancelled the new narration; the explainer is kept')
    await seen.clock.advance(5000)
    expect(seen.job()).toMatchObject({ stage: 'done', finishedAt: 10, note: 'the new narration was cancelled; the explainer is as it stood' })
    expect(seen.toasts.join('\n')).not.toContain('explainer ready')
  })

  test('of a page build leaves the explainer finished and without a page', async ($, on) => {
    const seen = world(on, { job: DONE, files: { ...SCRIPTS, '*/page.html': PAGE }, runMs: argv => (argv[1]?.endsWith('embed.sh') ? 1000 : 0) })
    await explain($, 'page')
    await seen.clock.advance(1)
    expect(seen.job()?.stage).toBe('paging')
    expect((await explain($, 'cancel')).text).toBe('cancelled the page build; the explainer is kept')
    await seen.clock.advance(5000)
    expect(seen.job()).toMatchObject({ stage: 'done', finishedAt: 10 })
    expect(seen.job()?.file).toBeUndefined()
    expect(seen.toasts.join('\n')).not.toContain('page ready')
  })
})

describe('a revoice', () => {
  test('with an engine that writes a silent clip keeps the clip, the audio and the finish time it had', async ($, on) => {
    const seen = world(on, { job: DONE, files: SCRIPTS, bytes: path => (path.endsWith('.new.m4a') ? 28 : 400_000) })
    await explain($, 'revoice')
    await seen.clock.advance(1)
    expect(seen.job()).toMatchObject({ stage: 'done', finishedAt: 10 })
    expect(seen.job()?.sections.map(section => section.audio)).toEqual(DONE.sections.map(section => section.audio))
    expect(seen.job()?.note).toContain('the earlier clips are kept')
    expect(says(seen.processes).map(argv => argv[argv.indexOf('-o') + 1])).toEqual([`${DIR}/j1/audio/the-race.new.m4a`])
    expect(seen.processes.filter(argv => argv[0] === 'mv')).toEqual([])
    expect(seen.processes).toContainEqual(['rm', '-f', `${DIR}/j1/audio/the-race.new.m4a`])
  })

  test('with a clip that holds speech moves it over the old one', async ($, on) => {
    const seen = world(on, { job: DONE, files: SCRIPTS })
    await explain($, 'revoice')
    await seen.clock.advance(1)
    expect(seen.processes).toContainEqual(['mv', '-f', `${DIR}/j1/audio/the-race.new.m4a`, `${DIR}/j1/audio/the-race.m4a`])
    expect(seen.job()).toMatchObject({ stage: 'done', finishedAt: 10, note: '1 narrated sections' })
  })
})

describe('a reload during a build', () => {
  const live = (change: Partial<Job>): Job => ({ ...DONE, id: 'j2', stage: 'building', note: 'the builder is writing the explainer', sections: [], ...change })
  const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const

  test('fails a job that had no sections yet, so the next start is not refused', async ($, on) => {
    const { finishedAt: _finishedAt, ...unfinished } = live({})
    const seen = world(on, { job: unfinished })
    await $.session.start(start)
    expect(seen.job()).toMatchObject({ stage: 'failed', note: 'a reload of lucid interrupted this build; run /explain again' })
    expect((await explain($, 'about b')).text).toContain('rating the question')
  })

  test('finishes and keeps a job that already had its sections', async ($, on) => {
    const { finishedAt: _finishedAt, ...unfinished } = live({ stage: 'voicing', sections: DONE.sections })
    const seen = world(on, { job: unfinished })
    await $.session.start(start)
    expect(seen.job()?.stage).toBe('done')
    expect(seen.job()?.finishedAt).toBe(1_000_000)
    expect(seen.files.has(`${DIR}/j1/job.json`)).toBe(true)
  })

  test('leaves a finished job alone', async ($, on) => {
    const seen = world(on, { job: DONE })
    await $.session.start(start)
    expect(seen.job()).toEqual(DONE)
  })
})

describe('the explainer in hand', () => {
  const failed: Job = { ...DONE, id: 'j2', stage: 'failed', note: 'the explainer failed its checks', sections: [] }

  test('after a failed build is the last one kept, while status still reports the failure', async ($, on) => {
    const seen = world(on, { ...KEPT, job: failed, files: { ...KEPT.files, '*/page.html': PAGE } })
    expect((await explain($, 'status')).text).toContain('failed: the explainer failed its checks')
    expect((await explain($, 'page')).text).toContain('a second subagent is writing the HTML page')
    expect(seen.job()?.id).toBe('j1')
  })

  test('after a cancelled build with nothing kept is that cancelled build', async ($, on) => {
    const seen = world(on, { job: { ...failed, stage: 'cancelled' } })
    expect((await explain($, 'revoice')).text).toBe('there is no finished explainer to voice again')
    expect(seen.job()?.id).toBe('j2')
  })

  test('while a build is live is that build, never the kept one', async ($, on) => {
    const seen = world(on, { ...KEPT, job: { ...failed, stage: 'building' } })
    expect((await explain($, 'page')).text).toBe('there is no finished explainer to build a page from')
    expect(seen.job()?.id).toBe('j2')
  })

  test('is not a job.json that holds something else', async ($, on) => {
    const seen = world(on, { store: KEPT.store, files: { [`${DIR}/j1/job.json`]: '{"hello": 1}' } })
    expect((await explain($, 'view')).text).toBe('no explainer yet')
    expect(seen.job()).toBeNull()
    expect((await explain($, 'about b')).text).toContain('rating the question')
  })
})

describe('a rebuilt page', () => {
  test('marks the published copy as older, and status and open prefer the local file until the next publish', async ($, on) => {
    const seen = world(on, { job: DONE, store: { settings: { shouldPublish: true } }, files: { ...SCRIPTS, '*/page.html': PAGE }, answers: { ask: ['Publish'] } })
    await explain($, 'page')
    await seen.clock.advance(1)
    expect(seen.job()?.file).toBe(`${DIR}/j1/explainer.html`)
    await explain($, 'publish')
    await seen.clock.advance(1)
    expect(seen.artifacts).toHaveLength(1)
    expect(seen.job()).toMatchObject({ url: 'https://claude.ai/artifact/a1', isUrlStale: false })
    expect((await explain($, 'status')).text).toContain('| https://claude.ai/artifact/a1')

    await explain($, 'page')
    await seen.clock.advance(1)
    expect(seen.job()).toMatchObject({ url: 'https://claude.ai/artifact/a1', isUrlStale: true })
    expect((await explain($, 'status')).text).toContain(`| ${DIR}/j1/explainer.html`)
    expect(seen.processes.at(-1)).toEqual(['open', '-a', 'Google Chrome', `file://${DIR}/j1/explainer.html`])

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect((await ui.find({ type: 'Link' }))?.text).toContain('older than the local page')
    await ui.unmount()
  })
})

describe('a clip that is playing', () => {
  // The kit runs a test's audio hook to its end whether or not lucid aborted the call, so the abort itself is not seen here.
  test('is no longer shown as playing once a new build starts, and no further clip follows it', async ($, on) => {
    const seen = world(on, { job: DONE, files: { ...SCRIPTS, ...BUILT }, clipMs: 60_000 })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    await ui.press({ key: 'play' })
    expect(seen.clipsStarted).toBe(1)
    expect(seen.view().playing).toBe('the-race')
    await ui.unmount()
    await explain($, 'about b')
    expect(seen.view().playing).toBeNull()
    await seen.clock.advance(60_000)
    expect(seen.clipsStarted).toBe(1)
  })

  test('does not carry on into another explainer that took its place', async ($, on) => {
    const seen = world(on, { job: DONE, files: SCRIPTS, clipMs: 60_000 })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    await ui.press({ key: 'play' })
    seen.setJob({ ...DONE, id: 'j9' })
    await seen.clock.advance(60_000)
    expect(seen.clipsStarted).toBe(1)
    await ui.unmount()
  })
})
