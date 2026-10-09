import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Complexity, Effort, Job, Pending, Section, Usage, View } from '../types'

import { checkNarration, chunkScript, longSections, rawNarration } from './narration'
import type { Narrated } from './narration'
import { OWN_HEADER, addOffer, checkPage, describeQuestions, isOwnDialog, wantsExplainer } from './page'
import { CLASSIFIER_SYSTEM, NARRATION_FIXTURES, builderBrief, classifierPrompt, narratorBrief } from './prompts'
import {
  aliasRoster,
  applyPricing,
  describeChanges,
  describePrice,
  isStale,
  newestOf,
  parseConfig,
  parseFallback,
  parseModelsResponse,
  parsePricing,
  resolveTier,
  unknownFamilies,
} from './roster'
import type { Config, Roster, RosterModel } from './roster'
import { escalate, parseComplexity, shiftStep, stepFor, tierAt } from './routing'

// lucid: when Claude asks a question, offer an explainer page for it. Nothing
// is spent on the offer; a model is called only after the person accepts.

const PANE = 'lucid'
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000'
const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
const PAGE_LIMIT_BYTES = 15 * 1024 * 1024
const NOTICE = '"Explain this first" builds an explainer page'
/** A rendered clip smaller than this per character of script holds no speech: `say` writes such files where it cannot reach the speech service. */
const MIN_AUDIO_BYTES_PER_CHAR = 40
const EMPTY_CLIP_BYTES = 40_000
const WITHHELD =
  'The user chose "Explain this first": they want an explainer before they answer, so this is not an answer. The lucid mod is building it now. Tell them so in one short line and end your turn. When they say they are ready, ask the same question again with the same options.'
const KEPT = 'lucid read its own subagent report, so it does not start a turn here'

const pending = atom({ plugin: 'lucid', key: 'pending' } as const, null)
const job = atom({ plugin: 'lucid', key: 'job' } as const, null)
const view = atom({ plugin: 'lucid', key: 'view' } as const, { index: 0, playing: null })

type TtsEngine = 'say' | 'kokoro' | 'hosted'

type Settings = {
  tts: TtsEngine
  voice: string
  isHostedAllowed: boolean
  /** Role to family overrides, over the config's own mapping. */
  roles: Record<string, string>
  /** The rung of the narration ladder `/explain-models` last found passing. */
  narrationStep: number
  shouldOffer: boolean
  shouldConfirm: boolean
  shouldAutoOpen: boolean
  shouldPublish: boolean
}

type Finished = { answer: string; reason: string; durationMs: number; usage?: Usage }

type AgentKind = 'explainer' | 'narration-writer'

type WithBrowser = { browser: { open: (input: { url: string }) => Promise<{ ok: boolean; error?: string }> } }

const DEFAULTS: Settings = {
  tts: 'say',
  voice: '',
  isHostedAllowed: false,
  roles: {},
  narrationStep: 0,
  shouldOffer: true,
  shouldConfirm: true,
  shouldAutoOpen: true,
  shouldPublish: true,
}

/** `/explain set <name> on|off`: the switches a person may turn, by the word they type. */
const SWITCHES: Record<string, keyof Settings> = {
  offer: 'shouldOffer',
  confirm: 'shouldConfirm',
  open: 'shouldAutoOpen',
  publish: 'shouldPublish',
}

const AGENT_TOOLS: Record<AgentKind, string[]> = {
  explainer: ['Artifact', 'Skill', 'Read', 'Write', 'Edit'],
  'narration-writer': [],
}
const AGENT_ROLE: Record<AgentKind, string> = {
  explainer: 'Builds one explainer page for the lucid mod. Only lucid starts it.',
  'narration-writer': 'Writes narration scripts for the lucid mod. Only lucid starts it.',
}

// Module state: gone on a hot reload, which only costs a job in flight.
const waiting = new Map<string, (done: Finished) => void>()
const finished = new Map<string, Finished>()
const mine = new Set<string>()
let playback: AbortController | null = null
let cancelled = ''
let config: Config | undefined

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const isLive = (current: Job | null): current is Job =>
  current !== null && current.stage !== 'done' && current.stage !== 'failed' && current.stage !== 'cancelled'

const mimeOf = (file: string): string => (file.endsWith('.mp3') ? 'audio/mpeg' : file.endsWith('.wav') ? 'audio/wav' : 'audio/mp4')

const tokens = (usage: Usage | undefined): string =>
  usage === undefined ? 'not measured' : `${usage.input + usage.cacheRead + usage.cacheWrite} in, ${usage.output} out`

/** Whether a person is at a surface: false under `claude -p`. Asked each time, since /clear resets state. */
async function isInteractive($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces().catch(() => [])).length > 0
}

async function loadConfig($: EngineInterface): Promise<Config> {
  config ??= parseConfig(await $.fs.read(`${$.plugin.root}/lucid.config.json`))

  return config
}

async function loadSettings($: EngineInterface): Promise<Settings> {
  const stored = await $.store.get('settings')

  return { ...DEFAULTS, ...(typeof stored === 'object' && stored !== null ? (stored as Partial<Settings>) : {}) }
}

async function saveSettings($: EngineInterface, change: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings($)), ...change }
  await $.store.set('settings', next)

  return next
}

async function dataDir($: EngineInterface): Promise<string> {
  const base = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`

  return `${base}/plugins/data/lucid`
}

async function loadFallback($: EngineInterface, table: Config): Promise<Roster> {
  return parseFallback(await $.fs.read(`${$.plugin.root}/roster.fallback.json`), table, await $.clock.now())
}

/**
 * Fetches the roster: the models API with the session's own login, else the
 * engine's aliases, else the fallback table. Never throws.
 */
async function refreshRoster($: EngineInterface, isForced: boolean): Promise<{ roster: Roster; changes: string[]; problem: string }> {
  const table = await loadConfig($)
  const roles = { ...table.roles, ...(await loadSettings($)).roles }
  const before = ((await $.store.get('roster')) ?? undefined) as Roster | undefined
  const now = await $.clock.now()

  if (!isForced && before !== undefined && !isStale(before, now, table.rosterMaxAgeHours)) {
    return { roster: before, changes: [], problem: '' }
  }

  const fallback = await loadFallback($, table)
  const forced = await $.env.get('LUCID_ROSTER_SOURCE')
  let roster: Roster | undefined
  let problem = ''

  if (forced === 'fallback') {
    roster = fallback
  } else if (forced !== 'alias') {
    try {
      const held = await $.session.authorize()
      if (held === null) {
        problem = 'this session has no Anthropic login the models API accepts'
      } else {
        const listed = await $.http.fetch(MODELS_URL, { auth: held.handle, headers: { 'anthropic-version': '2023-06-01' } })
        if (listed.ok) roster = parseModelsResponse(listed.text, table, now)
        else problem = `the models API answered ${listed.status}`
      }
    } catch (err) {
      problem = `the models API could not be reached (${words(err)})`
    }

    if (roster !== undefined) {
      const page = await $.http.fetch(PRICING_URL).catch(() => undefined)
      roster = applyPricing(roster, page?.ok === true ? parsePricing(page.text) : [], fallback)
    }
  }

  roster ??= aliasRoster(table, fallback, now)
  await $.store.set('roster', roster)

  return { roster, problem, changes: describeChanges(before, roster, roles) }
}

async function patchJob($: EngineInterface, id: string, change: Partial<Job>): Promise<void> {
  await update($, job, current => (current !== null && current.id === id ? { ...current, ...change } : current))
}

/** Keeps a finished job beside its files, so it outlives /clear and the session. */
async function keepJob($: EngineInterface, id: string): Promise<void> {
  const current = await read($, job)
  if (current === null || current.id !== id) return
  await $.fs.write(`${current.dir}/job.json`, JSON.stringify(current, null, 2))
  await $.store.set('lastJob', `${current.dir}/job.json`)
}

/** The explainer in hand: this session's, else the last one finished, read back from its folder. */
async function recallJob($: EngineInterface): Promise<Job | null> {
  const current = await read($, job)
  if (current !== null) return current

  const file = await $.store.get('lastJob')
  const text = typeof file === 'string' ? await $.fs.read(file).catch(() => undefined) : undefined
  if (text === undefined) return null

  try {
    const kept = JSON.parse(text) as Job
    await update($, job, () => kept)

    return kept
  } catch {
    return null
  }
}

/** The tail of the conversation, bounded: what a builder needs to know what the question is about. */
async function sessionContext($: EngineInterface): Promise<string> {
  const rows = await $.session.messages().catch(() => [])
  const lines: string[] = []
  let room = 6000

  for (const row of [...rows].reverse()) {
    if (row.text.trim() === '' || room <= 0) continue
    const text = row.text.trim().slice(-Math.min(room, 2500))
    lines.unshift(`${row.role}: ${text}`)
    room -= text.length
    if (lines.length >= 8) break
  }

  return lines.join('\n\n') || '(the session has no earlier messages)'
}

function awaitAgent($: EngineInterface, agentId: string, timeoutMs: number): Promise<Finished> {
  const early = finished.get(agentId)
  if (early !== undefined) return Promise.resolve(early)

  return new Promise(resolve => {
    const timer = $.clock.after(timeoutMs, () => {
      waiting.delete(agentId)
      resolve({ answer: '', reason: 'timeout', durationMs: timeoutMs })
    })
    waiting.set(agentId, done => {
      timer.cancel()
      resolve(done)
    })
  })
}

/**
 * Registers one of lucid's two agent types for this run, on this model at
 * this effort, starts it and waits for its answer. A spawn's own `model`
 * takes only the engine's aliases, so the exact id rides the registration.
 */
async function runAgent(
  $: EngineInterface,
  input: {
    kind: AgentKind
    model: RosterModel
    effort: Effort
    fallbackId: string | undefined
    prompt: string
    description: string
    timeoutMs: number
  },
): Promise<Finished & { model: string }> {
  const system = await $.fs.read(`${$.plugin.root}/prompts/${input.kind}.md`)

  // The roster's exact id first, then the family's engine alias, then the fallback table's id.
  for (const model of new Set([input.model.id, input.model.family, input.fallbackId])) {
    if (model === undefined) continue
    const started = await $.agent
      .register({
        name: input.kind,
        description: AGENT_ROLE[input.kind],
        prompt: system,
        tools: AGENT_TOOLS[input.kind],
        model,
        effort: input.effort,
        omitClaudeMd: true,
      })
      .then(() => $.agent.spawn({ subagentType: `lucid:${input.kind}`, prompt: input.prompt, description: input.description }))
      .catch((err: unknown) => ({ deny: words(err), agentId: undefined, model: undefined }))

    if (started.agentId !== undefined) {
      mine.add(started.agentId)
      const done = await awaitAgent($, started.agentId, input.timeoutMs)

      return { ...done, model: started.model ?? model }
    }

    $.ui.log(`${input.kind} did not start on ${model}: ${(started.deny ?? 'no reason given').slice(0, 300)}`, { to: 'debug' })
  }

  return { answer: '', reason: 'not-started', durationMs: 0, model: input.model.id }
}

async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: 'Explainer' }).catch(() => undefined)
  if (opened !== undefined && !opened.isPlaced) $.ui.toast('run /explain view to see the explainer pane')
}

/** Opens the page: in the terminal where a browser mod is loaded, else in Chrome, else the default browser. */
async function openPage($: EngineInterface): Promise<string> {
  const current = await recallJob($)
  const local = current?.file === undefined ? undefined : `file://${current.file}`
  const target = current?.url || local
  if (target === undefined) return 'there is no page to open yet'

  if (local !== undefined) {
    try {
      const inTerminal = await ($ as unknown as WithBrowser).browser.open({ url: local })
      if (inTerminal.ok) return 'opened in the terminal browser'
    } catch {
      // no browser mod is loaded, or it could not draw here: fall through to a real browser
    }
  }

  const chrome = await $.process.run(['open', '-a', 'Google Chrome', target]).catch(() => undefined)
  if (chrome?.exitCode === 0) return `opened in Chrome: ${target}`

  const any = await $.process.run(['open', target]).catch(() => undefined)

  return any?.exitCode === 0 ? `opened in your default browser: ${target}` : `could not open a browser; the page is at ${target}`
}

function stopPlayback(): void {
  playback?.abort()
  playback = null
}

async function playSection($: EngineInterface, id: string): Promise<void> {
  stopPlayback()
  const section = (await read($, job))?.sections.find(one => one.id === id)
  if (section?.audio === undefined) return

  const stop = new AbortController()
  playback = stop
  await update($, view, seen => ({ ...seen, playing: id }))

  try {
    const { base64 } = await $.fs.read(section.audio, { as: 'bytes' })
    await $.audio.play({ base64, mime: mimeOf(section.audio) }, { signal: stop.signal })
  } catch (err) {
    $.ui.toast(`could not play the narration (${words(err)})`)
  }

  if (playback === stop) {
    playback = null
    await update($, view, seen => ({ ...seen, playing: null }))
  }
}

async function compress($: EngineInterface, wav: string, out: string): Promise<string> {
  const viaFfmpeg = await $.process
    .run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-c:a', 'aac', '-b:a', '48k', out], { timeoutMs: 300_000 })
    .catch(() => undefined)
  const viaSystem =
    viaFfmpeg?.exitCode === 0
      ? viaFfmpeg
      : await $.process.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '48000', wav, out], { timeoutMs: 300_000 }).catch(() => undefined)
  if (viaSystem?.exitCode !== 0) return wav

  await $.process.run(['rm', '-f', wav]).catch(() => undefined)

  return out
}

/** Whether a rendered clip is long enough to hold the script it was rendered from. */
async function hasSpeech($: EngineInterface, file: string, script: Narrated): Promise<boolean> {
  const size = (await $.fs.stat(file).catch(() => undefined))?.size ?? 0

  return size > EMPTY_CLIP_BYTES || size > script.script.length * MIN_AUDIO_BYTES_PER_CHAR + EMPTY_CLIP_BYTES / 2
}

/** Renders one section's script to an audio file with the chosen engine; undefined when it cannot. */
async function renderSpeech($: EngineInterface, settings: Settings, dir: string, script: Narrated): Promise<string | undefined> {
  const text = `${dir}/audio/${script.id}.txt`
  await $.fs.write(text, script.chunks.join('\n\n'))

  if (settings.tts === 'kokoro') {
    const home = `${await dataDir($)}/kokoro`
    const wav = `${dir}/audio/${script.id}.wav`
    const ran = await $.process
      .run(['node', `${home}/kokoro.mjs`, text, wav, settings.voice || 'af_heart'], {
        cwd: home,
        timeoutMs: 600_000,
        env: { OFFLINE: (await $.fs.exists(`${home}/hf-cache`)) ? '1' : '0' },
      })
      .catch(() => undefined)
    if (ran?.exitCode === 0 && (await hasSpeech($, wav, script))) return compress($, wav, `${dir}/audio/${script.id}.m4a`)
    $.ui.log('Kokoro could not render; using the system voice for this section', { to: 'debug' })
  }

  if (settings.tts === 'hosted' && settings.isHostedAllowed) {
    const url = await $.env.get('LUCID_TTS_URL')
    const key = await $.env.get('LUCID_TTS_API_KEY')
    const model = (await $.env.get('LUCID_TTS_MODEL')) ?? ''
    const parts: string[] = []

    for (const [index, chunk] of script.chunks.entries()) {
      if (url === undefined || key === undefined) break
      const body = `${dir}/audio/${script.id}.${index}.json`
      const part = `${dir}/audio/${script.id}.${index}.mp3`
      await $.fs.write(body, JSON.stringify({ model, voice: settings.voice || 'alloy', input: chunk, response_format: 'mp3' }))
      // The key goes to curl on stdin, never on its command line.
      const request = [
        `url = "${url}"`,
        'request = "POST"',
        `header = "Authorization: Bearer ${key}"`,
        'header = "Content-Type: application/json"',
        `data-binary = "@${body}"`,
        `output = "${part}"`,
        'fail',
        'silent',
        'show-error',
      ].join('\n')
      const sent = await $.process.run(['curl', '-K', '-'], { stdin: request, timeoutMs: 120_000 }).catch(() => undefined)
      if (sent?.exitCode !== 0) break
      parts.push(part)
    }

    if (parts.length === script.chunks.length && parts.length > 0) {
      const out = `${dir}/audio/${script.id}.mp3`
      const joined = await $.process.run(['/bin/sh', '-c', 'out=$1; shift; cat "$@" > "$out"', 'sh', out, ...parts]).catch(() => undefined)
      if (joined?.exitCode === 0 && (await hasSpeech($, out, script))) return out
    }
    $.ui.log('hosted speech failed; using the system voice for this section', { to: 'debug' })
  }

  const out = `${dir}/audio/${script.id}.m4a`
  const voice = settings.tts === 'say' && settings.voice !== '' ? ['-v', settings.voice] : []
  const said = await $.process.run(['say', ...voice, '-o', out, '--data-format=aac', '-f', text], { timeoutMs: 600_000 }).catch(() => undefined)

  return said?.exitCode === 0 && (await hasSpeech($, out, script)) ? out : undefined
}

/** Asks the narration ladder, cheapest rung first, for scripts that pass the checks. */
async function writeNarration(
  $: EngineInterface,
  input: { sections: readonly Section[]; from: number; isStrict: boolean; roster: Roster; fallback: Roster; roles: Record<string, string> },
): Promise<{ scripts: Narrated[]; step: number; usage?: Usage; model: string; notes: string[] }> {
  const table = await loadConfig($)
  const notes: string[] = []
  let refusedRole = ''

  for (let step = input.from; step < table.narrationLadder.length; step += 1) {
    const tier = table.narrationLadder[step]
    if (tier === undefined || tier.role === refusedRole) continue
    const pick = resolveTier(tier, input.roster, input.roles, table)
    if (!pick.isResolved) {
      notes.push(pick.error)
      continue
    }

    const done = await runAgent($, {
      kind: 'narration-writer',
      model: pick.model,
      effort: pick.effort,
      fallbackId: newestOf(input.fallback.models, pick.model.family)?.id,
      prompt: narratorBrief(input.sections),
      description: 'Write narration scripts',
      timeoutMs: 5 * 60_000,
    })

    if (done.reason === 'refusal') {
      // A refusal is the model's, not the effort's: go on to another family.
      refusedRole = tier.role
      notes.push(`${done.model} refused`)
      continue
    }

    if (done.reason !== 'answer') {
      notes.push(`${done.model} at ${pick.effort} ended with ${done.reason}`)
      continue
    }

    const check = checkNarration(done.answer, input.sections, input.isStrict)
    if (check.isValid) {
      return { scripts: check.sections, step, model: done.model, notes: [...notes, ...check.repairs], ...(done.usage ? { usage: done.usage } : {}) }
    }
    notes.push(`${done.model} at ${pick.effort}: ${check.problems.join('; ')}`)
  }

  return { scripts: [], step: -1, model: '', notes }
}

/**
 * Renders the scripts to speech, writes the one-file page and publishes it.
 * The last steps of a build, and the whole of `/explain revoice`.
 */
async function voiceAndPublish(
  $: EngineInterface,
  input: {
    id: string
    dir: string
    question: string
    pageBytes: number
    sections: readonly Section[]
    scripts: readonly Narrated[]
    settings: Settings
    caveat: string
    shouldOpen: boolean
  },
): Promise<void> {
  const { id, dir, settings } = input
  const narrated = input.scripts.filter(one => one.narrate)
  let sections: Section[] = input.sections.map(({ id: section, heading, markdown }) => ({ id: section, heading, markdown }))
  const clips: string[] = []
  let room = PAGE_LIMIT_BYTES - input.pageBytes

  if (narrated.length > 0) await patchJob($, id, { stage: 'voicing', note: `rendering speech for ${narrated.length} sections with ${settings.tts}` })

  for (const script of narrated) {
    const audio = await renderSpeech($, settings, dir, script)
    const size = audio === undefined ? 0 : Math.ceil(((await $.fs.stat(audio).catch(() => undefined))?.size ?? 0) * 1.34)
    if (audio === undefined || size === 0 || size > room) continue
    room -= size
    clips.push(script.id, mimeOf(audio), audio)
    sections = sections.map(section => (section.id === script.id ? { ...section, audio } : section))
  }

  // One self-contained file: the page, its audio as data URIs, the player.
  const final = `${dir}/explainer.html`
  const embedded = await $.process
    .run(['/bin/sh', `${$.plugin.root}/scripts/embed.sh`, final, `${dir}/page.html`, `${$.plugin.root}/assets/player.html`, ...clips], { timeoutMs: 120_000 })
    .catch(() => undefined)
  const file = embedded?.exitCode === 0 ? final : `${dir}/page.html`
  await patchJob($, id, { stage: 'publishing', sections, file, note: 'publishing privately' })

  const voiced =
    clips.length > 0
      ? `${clips.length / 3} narrated sections`
      : narrated.length > 0
        ? `the ${settings.tts} speech engine produced no audio here (the macOS system voice cannot speak in some tmux and SSH sessions)`
        : 'no section was long enough to narrate'
  let note = input.caveat === '' ? voiced : `${voiced}; ${input.caveat}`

  // Publish where the session has the Artifact tool; without it the pane and the local file stand.
  let url: string | undefined
  const hasArtifact = (await $.tool.list().catch(() => [])).some(tool => tool.name === 'Artifact')

  if (!settings.shouldPublish) {
    note = `${note}; publishing is off, so the page stays on this machine`
  } else if (hasArtifact) {
    const published = await $.tool
      .call({ tool: 'Artifact', action: 'publish', file_path: file, icon: 'book', description: `Explainer for: ${input.question.slice(0, 120)}` })
      .catch((err: unknown) => ({ deny: words(err) }))
    const result = 'result' in published ? (published.result as { url?: unknown } | undefined) : undefined
    if (typeof result?.url === 'string') url = result.url
    else note = `${note}; not published (${'deny' in published && published.deny ? published.deny : 'the Artifact tool gave no link'})`
  } else {
    note = `${note}; this session has no Artifact tool, so the page stays local`
  }

  await patchJob($, id, { stage: 'done', note, finishedAt: await $.clock.now(), url: url ?? '' })
  await keepJob($, id)
  $.ui.toast('explainer ready: /explain view shows it here, /explain open opens the page', { timeoutMs: 10_000 })
  if (input.shouldOpen) $.ui.log(await openPage($))
}

/** `/explain revoice`: the last explainer's narration again, with the speech engine now chosen. */
async function revoice($: EngineInterface): Promise<void> {
  const current = await recallJob($)
  if (current === null) return

  const scripts: Narrated[] = []
  for (const section of current.sections) {
    const script = (await $.fs.read(`${current.dir}/audio/${section.id}.txt`).catch(() => '')).trim()
    if (script !== '') scripts.push({ id: section.id, narrate: true, script, chunks: chunkScript(script) })
  }

  if (scripts.length === 0) {
    $.ui.toast('this explainer has no narration scripts to voice')

    return
  }

  const page = await $.fs.read(`${current.dir}/page.html`)
  await voiceAndPublish($, {
    scripts,
    id: current.id,
    dir: current.dir,
    question: current.question,
    pageBytes: page.length,
    sections: current.sections,
    settings: await loadSettings($),
    caveat: '',
    shouldOpen: false,
  }).catch((err: unknown) => patchJob($, current.id, { stage: 'failed', note: words(err), error: words(err) }))
}

/** The whole job, start to finish. Runs off any hook's dispatch: started from a timer. */
async function runJob($: EngineInterface, origin: Job['origin'], question: string, isDialogOpen: boolean): Promise<void> {
  const now = await $.clock.now()
  const id = `j${now.toString(36)}`
  const dir = `${await dataDir($)}/jobs/${id}`
  const work = `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')}/lucid-${id}`

  const fresh: Job = { id, origin, question, dir, stage: 'classifying', note: 'rating the question', startedAt: now, sections: [] }
  await update($, job, () => fresh)
  await update($, view, () => ({ index: 0, playing: null }))
  await openPane($)

  const fail = async (error: string) => {
    await patchJob($, id, { stage: 'failed', error, note: error, finishedAt: await $.clock.now() })
    $.ui.toast(`no explainer. ${error}`, { timeoutMs: 10_000 })
  }

  try {
    const table = await loadConfig($)
    const settings = await loadSettings($)
    const roles = { ...table.roles, ...settings.roles }
    const { roster } = await refreshRoster($, false)
    const fallback = await loadFallback($, table)
    const context = await sessionContext($)

    // 1. Complexity: one cheap call, and only now that the person asked.
    const rater = resolveTier(table.classifier, roster, roles, table)
    let complexity: Complexity = 'moderate'
    if (rater.isResolved) {
      const rated = await $.model
        .complete({
          model: rater.model.id,
          effort: rater.effort,
          system: CLASSIFIER_SYSTEM,
          prompt: classifierPrompt(question, context),
          maxTokens: 64,
          timeoutMs: 20_000,
        })
        .catch(() => undefined)
      complexity = parseComplexity(rated?.isAnswered === true ? rated.text : undefined)
    }
    let step = stepFor(complexity, table)

    // 2. The choice, shown before anything larger is spent.
    for (let turn = 0; turn < 8; turn += 1) {
      const pick = resolveTier(tierAt(step, table), roster, roles, table)
      if (!pick.isResolved) return await fail(pick.error)
      const choice = `${pick.model.id} at ${pick.effort} effort`
      await patchJob($, id, { stage: 'confirming', complexity, step, model: pick.model.id, effort: pick.effort, note: `chose ${choice}` })

      if (!settings.shouldConfirm || isDialogOpen) {
        $.ui.toast(`building with ${choice} (rated ${complexity})`, { timeoutMs: 8000 })
        break
      }

      const answer = await $.ui
        .ask(`lucid rated this question ${complexity}. Build the explainer with ${choice} (${describePrice(pick.model)})?`, {
          header: OWN_HEADER,
          options: ['Build it', 'One step cheaper', 'One step stronger', 'Cancel'],
        })
        .catch(() => 'Cancel')

      if (answer === 'Build it') break
      if (answer === 'One step cheaper') step = shiftStep(step, -1, table)
      else if (answer === 'One step stronger') step = shiftStep(step, 1, table)
      else {
        await patchJob($, id, { stage: 'cancelled', note: 'cancelled before building', finishedAt: await $.clock.now() })

        return
      }
    }

    // 3. Build, and once more a rung up if the page fails its checks.
    let page: { title: string; sections: Section[]; html: string } | undefined
    let problems: string[] = []
    let builderUsage: Usage | undefined

    for (let attempt = 0; attempt < 2 && page === undefined; attempt += 1) {
      if (cancelled === id) return
      const pick = resolveTier(tierAt(step, table), roster, roles, table)
      if (!pick.isResolved) return await fail(pick.error)
      await patchJob($, id, {
        stage: 'building',
        step,
        model: pick.model.id,
        effort: pick.effort,
        note: attempt === 0 ? 'the builder is writing the page' : 'the first page failed its checks; rebuilding one step up',
      })

      const built = await runAgent($, {
        kind: 'explainer',
        model: pick.model,
        effort: pick.effort,
        fallbackId: newestOf(fallback.models, pick.model.family)?.id,
        prompt: builderBrief({ question, context, dir: work, problems }),
        description: 'Build explainer page',
        timeoutMs: 20 * 60_000,
      })
      builderUsage = built.usage ?? builderUsage
      await patchJob($, id, { model: built.model, ...(builderUsage ? { builderUsage } : {}) })

      const html = await $.fs.read(`${work}/page.html`).catch(() => undefined)
      const listed = await $.fs.read(`${work}/sections.json`).catch(() => undefined)

      if (html === undefined || listed === undefined) {
        problems = [`the builder ended with "${built.reason}" and did not write page.html and sections.json`]
      } else {
        const check = checkPage(html, listed)
        if (check.isValid) page = { title: check.title, sections: check.sections, html }
        else problems = check.problems
      }

      if (page === undefined) {
        const up = escalate(step, table)
        if (up === undefined) break
        step = up
      }
    }

    if (page === undefined) return await fail(`the page failed its checks: ${problems.slice(0, 3).join('; ')}`)
    if (cancelled === id) return

    await $.fs.write(`${dir}/page.html`, page.html)
    await $.fs.write(`${dir}/sections.json`, JSON.stringify({ title: page.title, sections: page.sections }, null, 2))
    await patchJob($, id, { stage: 'narrating', title: page.title, sections: page.sections, file: `${dir}/page.html`, note: 'writing narration for the long sections' })

    // 4. Narration scripts for the long sections; speech is rendered from them on this machine.
    const long = longSections(page.sections, table.narrationMinChars)
    let scripts: Narrated[] = []
    let caveat = ''

    if (long.length > 0) {
      const written = await writeNarration($, { sections: long, from: settings.narrationStep, isStrict: false, roster, fallback, roles })
      if (written.usage) await patchJob($, id, { narratorUsage: written.usage })
      if (written.notes.length > 0) $.ui.log(`narration notes: ${written.notes.join(' | ')}`, { to: 'debug' })
      if (written.scripts.length === 0) caveat = 'no narration writer passed its checks, so the narration reads the sections as written'
      scripts = written.scripts.length > 0 ? written.scripts : rawNarration(long)
      if (cancelled === id) return
    }

    await voiceAndPublish($, { id, dir, question, scripts, settings, caveat, pageBytes: page.html.length, sections: page.sections, shouldOpen: settings.shouldAutoOpen })
  } catch (err) {
    await fail(words(err))
  }
}

/** Starts a job off the calling dispatch. Says why not when one cannot start. */
async function startJob($: EngineInterface, origin: Job['origin'], question: string, isDialogOpen: boolean): Promise<string> {
  if (!(await isInteractive($))) return 'explainers need an interactive session'
  if (isLive(await read($, job))) return 'an explainer is already being built; /explain status shows where it is'
  if (question.trim() === '') return 'there is no question to explain yet. Run /explain after Claude asks one, or /explain about <text>.'

  $.clock.after(1, () => {
    void runJob($, origin, question, isDialogOpen)
  })

  return 'rating the question, then it shows the model and effort it would use'
}

function describeJob(current: Job | null): string {
  if (current === null) return 'no explainer yet'
  const choice = current.model === undefined ? '' : ` | ${current.model} at ${current.effort ?? '?'} effort (rated ${current.complexity ?? '?'})`
  const spent = current.builderUsage === undefined ? '' : ` | builder tokens ${tokens(current.builderUsage)}; narration tokens ${tokens(current.narratorUsage)}`
  const took = current.finishedAt === undefined ? '' : ` | ${Math.round((current.finishedAt - current.startedAt) / 1000)} s`
  const where = current.url || current.file || ''

  return `${current.stage}: ${current.note}${choice}${spent}${took}${where ? ` | ${where}` : ''}`
}

/** `/explain-models`: refresh, report, and try the narration ladder on the fixtures. */
async function reviewModels($: EngineInterface): Promise<void> {
  const table = await loadConfig($)
  const settings = await loadSettings($)
  const roles = { ...table.roles, ...settings.roles }
  const { roster, changes, problem } = await refreshRoster($, true)
  const fallback = await loadFallback($, table)
  const lines = [`models, from the ${roster.source}${problem ? ` (${problem})` : ''}:`]

  for (const [role, family] of Object.entries(roles)) {
    const model = newestOf(roster.models, family)
    lines.push(
      model === undefined
        ? `  ${role}: no "${family}" model in the roster`
        : `  ${role}: ${model.id} (${family}); effort ${model.efforts.join(', ') || 'not adjustable'}; ${describePrice(model)}${model.note ? `; ${model.note}` : ''}`,
    )
  }

  const unknown = unknownFamilies(roster, roles)
  if (unknown.length > 0) lines.push(`  not used, yours to decide (/explain-models use <role> <family>): ${unknown.join(', ')}`)
  lines.push(
    roster.audioCapabilities.length > 0
      ? `  possible audio capability, check it: ${roster.audioCapabilities.join(', ')}`
      : roster.source === 'api'
        ? '  no model lists an audio capability: narration audio still needs a speech engine'
        : '  audio capabilities are only visible from the models API',
  )
  lines.push(changes.length > 0 ? `  changed: ${changes.join('; ')}` : '  nothing changed since the last refresh')
  // One log line each: a transcript notice is a single line.
  for (const line of lines) $.ui.log(line)

  const tried = await writeNarration($, { sections: NARRATION_FIXTURES, from: 0, isStrict: true, roster, fallback, roles })
  if (tried.step < 0) {
    $.ui.log(`narration writer: no rung passed the fixtures (${tried.notes.join(' | ') || 'no detail'}); keeping rung ${settings.narrationStep + 1}`)

    return
  }

  const tier = table.narrationLadder[tried.step]
  const was = settings.narrationStep
  await saveSettings($, { narrationStep: tried.step })
  $.ui.log(
    `narration writer: ${tried.model} at ${tier?.effort ?? '?'} effort is the cheapest rung that passed the fixtures (${tokens(tried.usage)} tokens)` +
      (was === tried.step ? '; unchanged' : `; was rung ${was + 1}, now rung ${tried.step + 1}`) +
      (tried.notes.length > 0 ? `; notes: ${tried.notes.join(' | ')}` : ''),
  )
}

/** Installs kokoro-js beside lucid's data and renders one line, which also fetches the voice model. */
async function setUpKokoro($: EngineInterface): Promise<void> {
  const home = `${await dataDir($)}/kokoro`
  await $.fs.write(`${home}/package.json`, '{ "name": "lucid-kokoro", "private": true, "type": "module" }\n')
  await $.fs.write(`${home}/kokoro.mjs`, await $.fs.read(`${$.plugin.root}/scripts/kokoro.mjs`))
  await $.fs.write(`${home}/warmup.txt`, 'Kokoro is ready.')

  const installed = await $.process.run(['npm', 'install', 'kokoro-js', '--no-audit', '--no-fund'], { cwd: home, timeoutMs: 600_000 }).catch(() => undefined)
  if (installed?.exitCode !== 0) {
    $.ui.log(`could not install kokoro-js (needs Node and npm): ${installed?.stderr.slice(-300) ?? 'npm did not start'}`)

    return
  }

  const warm = await $.process
    .run(['node', `${home}/kokoro.mjs`, `${home}/warmup.txt`, `${home}/warmup.wav`], { cwd: home, timeoutMs: 600_000 })
    .catch(() => undefined)
  if (warm?.exitCode !== 0) {
    $.ui.log(`kokoro-js installed but could not render: ${warm?.stderr.slice(-300) ?? 'node did not start'}`)

    return
  }

  await saveSettings($, { tts: 'kokoro', voice: '' })
  $.ui.log('Kokoro is set up and is now the narration voice. /explain tts say switches back.')
}

async function ttsCommand($: EngineInterface, rest: string[]): Promise<string> {
  const settings = await loadSettings($)
  const [engine, ...voice] = rest

  if (engine === undefined) {
    const ffmpeg = await $.process.run(['/bin/sh', '-c', 'command -v ffmpeg']).catch(() => undefined)

    return `speech: ${settings.tts}${settings.voice ? ` (${settings.voice})` : ''}; ffmpeg ${ffmpeg?.exitCode === 0 ? 'found' : 'not found (not needed for the system voice)'}. Engines: say [voice], kokoro, hosted.`
  }

  if (engine === 'say') {
    await saveSettings($, { tts: 'say', voice: voice.join(' ') })

    return `speech: the macOS system voice${voice.length > 0 ? ` "${voice.join(' ')}"` : ''}, on this machine`
  }

  if (engine === 'kokoro') {
    $.clock.after(1, () => {
      void setUpKokoro($)
    })

    return 'setting up Kokoro on this machine (an npm install and a model of about 100 MB); a line follows when it is ready'
  }

  if (engine === 'hosted') {
    const url = await $.env.get('LUCID_TTS_URL')
    if (url === undefined || (await $.env.get('LUCID_TTS_API_KEY')) === undefined) {
      return 'hosted speech needs LUCID_TTS_URL and LUCID_TTS_API_KEY in the environment (and optionally LUCID_TTS_MODEL)'
    }

    const answer = await $.ui
      .ask(`Hosted speech sends the narration text of every explainer to ${url}, outside this machine. Turn it on?`, {
        header: OWN_HEADER,
        options: ['Keep speech local', 'Send text to the hosted service'],
      })
      .catch(() => 'Keep speech local')
    if (answer !== 'Send text to the hosted service') return 'speech: unchanged, still local'
    await saveSettings($, { tts: 'hosted', isHostedAllowed: true, voice: voice.join(' ') })

    return `speech: hosted, through ${url}. /explain tts say switches back.`
  }

  return 'speech engines are say [voice], kokoro and hosted'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'explain',
      description: 'Build an explainer page for the last question Claude asked',
      argumentHint: '[view | open | stop | status | cancel | revoice | tts | set | about <text>]',
    })
    await $.command.register({
      name: 'explain-models',
      description: 'Refresh the model roster lucid picks from and re-check its narration writer',
      argumentHint: '[use <role> <family>]',
    })

    if (e.isInteractive) {
      // The roster is refreshed off the start path, and at most once a day.
      $.clock.after(5000, () => {
        void refreshRoster($, false)
      })
      $.clock.every(3_600_000, () => {
        void refreshRoster($, false)
      })
    }

    return next(e)
  })

  // lucid's agent types are its own to start: the model is never offered them.
  on('agent.offer', ($, e, next) => (e.agent.startsWith('lucid:') ? { isOffered: false } : next(e))).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) {
      const done: Finished = {
        answer: e.answer,
        reason: e.reason,
        durationMs: e.durationMs,
        ...(e.usage
          ? {
              usage: {
                input: e.usage.input_tokens,
                output: e.usage.output_tokens,
                cacheRead: e.usage.cache_read_input_tokens,
                cacheWrite: e.usage.cache_creation_input_tokens,
              },
            }
          : {}),
      }
      const resolve = waiting.get(e.agentId)
      waiting.delete(e.agentId)
      if (resolve) resolve(done)
      else finished.set(e.agentId, done)
      if (finished.size > 20) finished.delete(finished.keys().next().value ?? '')
    }

    return next(e)
  })

  // A subagent's report comes back as a prompt of its own; lucid's are read
  // from turn.complete, so here they are kept out of the main conversation.
  on('prompt.submit', ($, e, next) => {
    const from = e.origin.kind === 'peer' ? /^<agent-message from="([^"]+)">/.exec(e.text)?.[1] : undefined

    return from !== undefined && mine.has(from) ? { drop: KEPT } : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined || isOwnDialog(e.questions)) return next(e)

    const settings = await loadSettings($)
    const offered = settings.shouldOffer && (await isInteractive($)) ? addOffer(e.questions) : { questions: [...e.questions], isOffered: false }
    const asked = e.questions.map(({ question, header, options, multiSelect }) => ({
      question,
      header,
      multiSelect,
      options: options.map(({ label, description }) => ({ label, description })),
    }))
    const held: Pending = { id: e.tool_use_id, questions: asked, at: await $.clock.now(), isOpen: true }
    await update($, pending, () => held)
    if (settings.shouldOffer) $.ui.notice(e.tool_use_id, NOTICE)

    const ran = await next({ ...e, questions: offered.questions })
    await update($, pending, () => ({ ...held, isOpen: false }))

    if (ran.deny !== undefined || ran.isError === true || !wantsExplainer((ran.result as { answers?: unknown }).answers)) return ran

    await startJob($, 'option', describeQuestions(asked), false)

    return { deny: WITHHELD }
  }).catch(($, e, next) => next(e))

  // A button above the dialog: one click starts the explainer and the dialog stays open.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const held = await read($, pending)
    if (held === null || !held.isOpen || isOwnDialog(e.props.questions as { header?: string }[])) return next(e)

    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Button
          key="lucid-explain"
          label="Explain this first"
          onPress={async () => {
            $.ui.toast(await startJob($, 'button', describeQuestions(held.questions), true), { timeoutMs: 6000 })
          }}
        />
        {await next(e)}
      </Box>
    )
  })

  on('command.run', { command: 'explain' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const isAboutLast = ['view', 'open', 'status', 'revoice'].includes(verb)
    const current = isAboutLast ? await recallJob($) : await read($, job)

    if (verb === 'view') {
      await $.ui.open({ id: PANE, title: 'Explainer' })

      return { text: describeJob(current) }
    }

    if (verb === 'open') return { text: `${await openPage($)}` }
    if (verb === 'status') return { text: describeJob(current) }
    if (verb === 'tts') return { text: await ttsCommand($, rest) }

    if (verb === 'revoice') {
      if (current === null || current.stage !== 'done') return { text: 'there is no finished explainer to voice again' }
      $.clock.after(1, () => {
        void revoice($)
      })

      return { text: `rendering the narration again with the ${(await loadSettings($)).tts} speech engine` }
    }

    if (verb === 'set') {
      const [name = '', value = ''] = rest
      const key = SWITCHES[name]
      if (key === undefined || (value !== 'on' && value !== 'off')) {
        const settings = await loadSettings($)
        const now = Object.entries(SWITCHES).map(([word, field]) => `${word} ${settings[field] === true ? 'on' : 'off'}`)

        return { text: `switches: ${now.join(', ')}. Change one with /explain set <${Object.keys(SWITCHES).join(' | ')}> <on | off>.` }
      }
      await saveSettings($, { [key]: value === 'on' })

      return { text: `${name} is ${value}` }
    }

    if (verb === 'stop') {
      stopPlayback()
      await update($, view, seen => ({ ...seen, playing: null }))

      return { text: 'narration stopped' }
    }

    if (verb === 'cancel') {
      if (!isLive(current)) return { text: 'nothing is being built' }
      cancelled = current.id
      await patchJob($, current.id, { stage: 'cancelled', note: 'cancelled; a subagent already running finishes on its own', finishedAt: await $.clock.now() })

      return { text: 'cancelled' }
    }

    const held = await read($, pending)
    const question = verb === 'about' ? rest.join(' ') : verb === '' ? (held === null ? '' : describeQuestions(held.questions)) : e.args.trim()

    return { text: await startJob($, 'command', question, false) }
  })

  on('command.run', { command: 'explain-models' }, async ($, e) => {
    const [verb, role, family] = e.args.trim().split(/\s+/)

    if (verb === 'use' && role !== undefined && family !== undefined) {
      const settings = await loadSettings($)
      await saveSettings($, { roles: { ...settings.roles, [role]: family } })

      return { text: `the "${role}" role now uses the "${family}" family` }
    }

    if (!(await isInteractive($))) {
      const { roster, problem } = await refreshRoster($, true)

      return { text: `models, from the ${roster.source}${problem ? ` (${problem})` : ''}: ${roster.models.map(model => model.id).join(', ')}` }
    }

    $.clock.after(1, () => {
      void reviewModels($).catch((err: unknown) => $.ui.log(`the model review failed: ${words(err)}`))
    })

    return { text: 'refreshing the roster and trying the narration writer on its fixtures; the results follow' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
    const current = await read($, job)
    const seen: View = await read($, view)

    if (current === null) {
      return (
        <Box flexDirection="column">
          <Text>No explainer in this session yet.</Text>
          <Text dimColor>When Claude asks a question, pick "Explain this first", or run /explain afterwards.</Text>
          <Text dimColor>/explain view brings back the last one you built.</Text>
        </Box>
      )
    }

    const choice = current.model === undefined ? '' : `${current.model} at ${current.effort ?? '?'} effort, rated ${current.complexity ?? '?'}`
    const count = current.sections.length
    const index = Math.min(seen.index, Math.max(count - 1, 0))
    const section = current.sections[index]
    const isPlaying = section !== undefined && seen.playing === section.id
    const step = (by: number) => () => update($, view, shown => ({ ...shown, index: Math.min(Math.max(index + by, 0), Math.max(count - 1, 0)) }))

    return (
      <Box flexDirection="column">
        <Text bold>{current.title ?? 'Explainer'}</Text>
        <Text dimColor>
          {current.stage}: {current.note}
        </Text>
        {choice !== '' && <Text dimColor>{choice}</Text>}
        {current.builderUsage !== undefined && (
          <Text dimColor>
            measured tokens: builder {tokens(current.builderUsage)}; narration {tokens(current.narratorUsage)}
          </Text>
        )}
        {section !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              {index + 1}/{count} {section.heading}
            </Text>
            <Markdown text={section.markdown} />
          </Box>
        )}
        <Box marginTop={1} columnGap={1} flexWrap="wrap">
          {count > 1 && <Button key="prev" label="Prev" hotkey="p" onPress={step(-1)} />}
          {count > 1 && <Button key="next" label="Next" hotkey="n" onPress={step(1)} />}
          {section?.audio !== undefined && !isPlaying && (
            <Button
              key="play"
              label="Play"
              hotkey="l"
              onPress={() => {
                void playSection($, section.id)
              }}
            />
          )}
          {seen.playing !== null && (
            <Button
              key="stop"
              label="Stop"
              hotkey="s"
              onPress={async () => {
                stopPlayback()
                await update($, view, shown => ({ ...shown, playing: null }))
              }}
            />
          )}
          {(current.file !== undefined || Boolean(current.url)) && (
            <Button
              key="open"
              label="Open page"
              hotkey="o"
              variant="primary"
              onPress={async () => {
                $.ui.toast(`${await openPage($)}`, { timeoutMs: 6000 })
              }}
            />
          )}
          {current.origin === 'option' && current.stage === 'done' && (
            <Button
              key="again"
              label="Ask me again"
              hotkey="a"
              onPress={() => {
                void $.prompt.submit({ text: 'I have read the explainer. Ask me that question again.' })
              }}
            />
          )}
        </Box>
        {current.url !== undefined && current.url !== '' && <Link href={current.url} label={current.url} />}
      </Box>
    )
  })
}
