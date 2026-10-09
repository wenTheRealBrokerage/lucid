import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Complexity, Effort, Job, Pending, Section, Stage, Usage, View } from '../types'

import {
  CARD_INSET,
  checkExplainer,
  displayWidth,
  fitCells,
  isKeptJob,
  narratedSections,
  nextNarrated,
  pickDiagram,
  plainCell,
  printable,
  sectionText,
  splitTables,
  tableWidths,
  widthOf,
} from './explainer'
import { checkNarration, chunkScript, longSections, rawNarration } from './narration'
import type { Narrated } from './narration'
import { OWN_HEADER, addOffer, checkPage, describeQuestions, isOwnDialog, wantsExplainer } from './page'
import { CLASSIFIER_SYSTEM, NARRATION_FIXTURES, builderBrief, classifierPrompt, narratorBrief, pageBrief } from './prompts'
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
import { addUsage, escalate, parseComplexity, shiftStep, stepFor, tierAt } from './routing'
import { probeTerminal } from './terminal'
import type { Terminal } from './terminal'

// lucid: when Claude asks a question, offer an explainer for it, read in a
// pane of the terminal. Nothing is spent on the offer; a model is called only
// after the person accepts.

const PANE = 'lucid'
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000'
const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
const NOTICE = '"Explain this first" builds an explainer in the terminal'
/** How long each frame shows while auto-advance runs. */
const FRAME_MS = 2500
/** A rendered clip smaller than this per character of script holds no speech: `say` writes such files where it cannot reach the speech service. */
const MIN_AUDIO_BYTES_PER_CHAR = 40
const EMPTY_CLIP_BYTES = 40_000
const TABLE_CELLS_MAX = 2000
const WITHHELD =
  'The user chose "Explain this first": they want an explainer before they answer, so this is not an answer. The lucid mod is building it now. Tell them so in one short line and end your turn. When they say they are ready, ask the same question again with the same options.'
const KEPT = 'lucid read its own subagent report, so it does not start a turn here'
const INTERRUPTED = 'a reload of lucid interrupted this build; run /explain again'
const USAGE = '[view | status | stop | cancel | revoice | page | open | publish | tts | set | about <text>]'

const notStarted = (reason: string): string =>
  `The user chose "Explain this first", but the lucid mod did not start an explainer for this question (${reason}), so this is not an answer. Tell them so in one short line and end your turn. When they say they are ready, ask the same question again with the same options.`

const pending = atom({ plugin: 'lucid', key: 'pending' } as const, null)
const job = atom({ plugin: 'lucid', key: 'job' } as const, null)
const view = atom({ plugin: 'lucid', key: 'view' } as const, { index: 0, step: 0, isToc: false, isAuto: false, playing: null })
const FRESH_VIEW: View = { index: 0, step: 0, isToc: false, isAuto: false, playing: null }

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
  /** Open the HTML page in a browser as soon as `/explain page` has built it. */
  shouldAutoOpen: boolean
  /** Arms `/explain publish`; nothing publishes by itself. */
  shouldPublish: boolean
  /** Whether `g` may auto-advance a section's frames. */
  shouldAnimate: boolean
}

type Finished = { answer: string; reason: string; durationMs: number; usage?: Usage }

type Asked = { origin: Job['origin']; question: string; isDialogOpen: boolean; dialogId?: string }

type Start = { kind: 'started' | 'same-question' | 'refused'; text: string }

type AgentKind = 'explainer' | 'explainer-page' | 'narration-writer'

type WithBrowser = { browser: { open: (input: { url: string }) => Promise<{ ok: boolean; error?: string }> } }

const DEFAULTS: Settings = {
  tts: 'say',
  voice: '',
  isHostedAllowed: false,
  roles: {},
  narrationStep: 0,
  shouldOffer: true,
  shouldConfirm: false,
  shouldAutoOpen: true,
  shouldPublish: false,
  shouldAnimate: true,
}

/** `/explain set <name> on|off`: the switches a person may turn, by the word they type. */
const SWITCHES: Record<string, keyof Settings> = {
  offer: 'shouldOffer',
  confirm: 'shouldConfirm',
  open: 'shouldAutoOpen',
  publish: 'shouldPublish',
  animate: 'shouldAnimate',
}

const AGENT_TOOLS: Record<AgentKind, string[]> = {
  explainer: ['Write'],
  'explainer-page': ['Read', 'Write', 'Edit', 'Skill'],
  'narration-writer': [],
}
const AGENT_ROLE: Record<AgentKind, string> = {
  explainer: 'Builds one terminal explainer for the lucid mod. Only lucid starts it.',
  'explainer-page': 'Builds the opt-in HTML page of a lucid explainer. Only lucid starts it.',
  'narration-writer': 'Writes narration scripts for the lucid mod. Only lucid starts it.',
}

// Module state: gone on a hot reload. A job in flight then has no one running it, and session.start settles it.
const waiting = new Map<string, (done: Finished) => void>()
const finished = new Map<string, Finished>()
const mine = new Set<string>()
let playback: AbortController | null = null
let autoTimer: { cancel: () => void } | null = null
let config: Config | undefined
let terminal: Terminal | undefined

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
  const stored = await $.store.get('settings').catch(() => undefined)

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
  await update($, job, current => (current !== null && current.id === id && current.stage !== 'cancelled' ? { ...current, ...change } : current))
}

async function isAt($: EngineInterface, id: string, stage?: Stage): Promise<boolean> {
  const current = await read($, job)

  return current !== null && current.id === id && (stage === undefined ? isLive(current) : current.stage === stage)
}

/** Keeps a finished job beside its files, so it outlives /clear and the session. */
async function keepJob($: EngineInterface, id: string): Promise<void> {
  const current = await read($, job)
  if (current === null || current.id !== id) return
  await $.fs.write(`${current.dir}/job.json`, JSON.stringify(current, null, 2))
  await $.store.set('lastJob', `${current.dir}/job.json`)
}

async function keptJob($: EngineInterface): Promise<Job | null> {
  const file = await $.store.get('lastJob').catch(() => undefined)
  const text = typeof file === 'string' ? await $.fs.read(file).catch(() => undefined) : undefined
  if (text === undefined) return null

  try {
    const kept: unknown = JSON.parse(text)

    return isKeptJob(kept) ? kept : null
  } catch {
    return null
  }
}

/** The explainer in hand: this session's unless it failed or was cancelled, else the last one finished, read back from its folder. */
async function recallJob($: EngineInterface): Promise<Job | null> {
  const current = await read($, job)
  if (current !== null && current.stage !== 'failed' && current.stage !== 'cancelled') return current

  const kept = await keptJob($)
  if (kept === null) return current
  await update($, job, now => (isLive(now) ? now : kept))

  return read($, job)
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

/** The terminal probe, read once per load from literal names (D:3588-3609); unknown where the environment cannot be read. */
async function probe($: EngineInterface): Promise<Terminal> {
  if (terminal === undefined) {
    const get = (name: Promise<string | undefined>) => name.catch(() => undefined)
    terminal = probeTerminal({
      TERMINAL_EMULATOR: await get($.env.get('TERMINAL_EMULATOR')),
      TERM_PROGRAM: await get($.env.get('TERM_PROGRAM')),
      TERM: await get($.env.get('TERM')),
      COLORTERM: await get($.env.get('COLORTERM')),
      TMUX: await get($.env.get('TMUX')),
      WT_SESSION: await get($.env.get('WT_SESSION')),
    })
  }

  return terminal
}

/**
 * Opens the pane. From an asked context (a command, a press) it seats at any
 * width; `focus` is asked for only while no dialog holds the keys (D:7406).
 */
async function openPane($: EngineInterface, isFocus: boolean): Promise<boolean> {
  const opened = await $.ui.open(isFocus ? { id: PANE, title: 'Explainer', focus: true } : { id: PANE, title: 'Explainer' }).catch(() => undefined)
  if (opened !== undefined && !opened.isPlaced) $.ui.toast('the explainer pane needs a wider terminal; /explain view prints the section here instead')

  return opened?.isPlaced === true
}

function stopAuto(): void {
  autoTimer?.cancel()
  autoTimer = null
}

/** One tick of auto-advance: the next frame, or the end of it at the last frame. */
async function tickAuto($: EngineInterface): Promise<void> {
  const current = await read($, job)
  const seen = await read($, view)
  const steps = current?.sections[seen.index]?.steps ?? []
  const isOn = seen.isAuto && (await loadSettings($)).shouldAnimate && seen.step < steps.length - 1

  if (!isOn) {
    stopAuto()
    if (seen.isAuto) await update($, view, shown => ({ ...shown, isAuto: false }))

    return
  }

  await update($, view, shown => ({ ...shown, step: shown.step + 1 }))
}

/** Arms the frame timer; the `view` atom carries `isAuto`, so a reload re-arms it from session.start. */
function startAuto($: EngineInterface): void {
  stopAuto()
  autoTimer = $.clock.every(FRAME_MS, () => {
    void tickAuto($)
  })
}

/** Opens the page: in the terminal where a browser mod is loaded, else in Chrome, else the default browser. */
async function openPage($: EngineInterface): Promise<string> {
  const current = await recallJob($)
  const local = current?.file === undefined ? undefined : `file://${current.file}`
  const published = current?.url || undefined
  const target = current?.isUrlStale === true ? (local ?? published) : (published ?? local)
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
  const played = await read($, job)
  const section = played?.sections.find(one => one.id === id)
  if (played === null || section?.audio === undefined) return

  const stop = new AbortController()
  playback = stop
  await update($, view, seen => ({ ...seen, playing: id }))
  let isEnded = false

  try {
    const { base64 } = await $.fs.read(section.audio, { as: 'bytes' })
    await $.audio.play({ base64, mime: mimeOf(section.audio) }, { signal: stop.signal })
    isEnded = true
  } catch (err) {
    $.ui.toast(`could not play the narration (${words(err)})`)
  }

  // Not aborted by Stop or by another Play: the clip ran out, so the next narrated section follows.
  if (playback === stop) {
    playback = null
    await update($, view, seen => ({ ...seen, playing: null }))
    const now = isEnded ? await read($, job) : null
    const current = now?.id === played.id ? now : null
    const at = current?.sections.findIndex(one => one.id === id) ?? -1
    const following = current === null || at < 0 ? undefined : nextNarrated(current.sections, at)
    const next = following === undefined ? undefined : current?.sections[following]
    if (following !== undefined && next !== undefined) {
      await update($, view, seen => ({ ...seen, index: following, step: 0, isToc: false }))
      await playSection($, next.id)
    }
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

async function keepIfSpoken($: EngineInterface, fresh: string, out: string, script: Narrated): Promise<string | undefined> {
  if (await hasSpeech($, fresh, script)) {
    const moved = await $.process.run(['mv', '-f', fresh, out]).catch(() => undefined)
    if (moved?.exitCode === 0) return out
  }
  await $.process.run(['rm', '-f', fresh]).catch(() => undefined)

  return undefined
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
      const fresh = `${dir}/audio/${script.id}.new.mp3`
      const joined = await $.process.run(['/bin/sh', '-c', 'out=$1; shift; cat "$@" > "$out"', 'sh', fresh, ...parts]).catch(() => undefined)
      const kept = joined?.exitCode === 0 ? await keepIfSpoken($, fresh, `${dir}/audio/${script.id}.mp3`, script) : undefined
      if (kept !== undefined) return kept
    }
    $.ui.log('hosted speech failed; using the system voice for this section', { to: 'debug' })
  }

  const fresh = `${dir}/audio/${script.id}.new.m4a`
  const voice = settings.tts === 'say' && settings.voice !== '' ? ['-v', settings.voice] : []
  const said = await $.process.run(['say', ...voice, '-o', fresh, '--data-format=aac', '-f', text], { timeoutMs: 600_000 }).catch(() => undefined)

  return said?.exitCode === 0 ? keepIfSpoken($, fresh, `${dir}/audio/${script.id}.m4a`, script) : undefined
}

/** Asks the narration ladder, cheapest rung first, for scripts that pass the checks. */
async function writeNarration(
  $: EngineInterface,
  input: { sections: readonly Section[]; from: number; isStrict: boolean; roster: Roster; fallback: Roster; roles: Record<string, string> },
): Promise<{ scripts: Narrated[]; step: number; usage?: Usage; model: string; notes: string[] }> {
  const table = await loadConfig($)
  const notes: string[] = []
  let refusedRole = ''
  let usage: Usage | undefined

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
    usage = addUsage(usage, done.usage)

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
      return { scripts: check.sections, step, model: done.model, notes: [...notes, ...check.repairs], ...(usage ? { usage } : {}) }
    }
    notes.push(`${done.model} at ${pick.effort}: ${check.problems.join('; ')}`)
  }

  return { scripts: [], step: -1, model: '', notes, ...(usage ? { usage } : {}) }
}

/**
 * Renders the scripts to speech and finishes the job. The last step of a
 * build, and the whole of `/explain revoice`.
 */
async function voice(
  $: EngineInterface,
  input: {
    id: string
    dir: string
    sections: readonly Section[]
    scripts: readonly Narrated[]
    settings: Settings
    caveat: string
    isWanted: () => Promise<boolean>
    finishedAt?: number
  },
): Promise<void> {
  const { id, dir, settings } = input
  const narrated = input.scripts.filter(one => one.narrate)
  let sections: Section[] = input.sections.map(section => ({ ...section }))
  let clips = 0

  if (narrated.length > 0) await patchJob($, id, { stage: 'voicing', note: `rendering speech for ${narrated.length} sections with ${settings.tts}` })

  for (const script of narrated) {
    if (!(await input.isWanted())) break
    const audio = await renderSpeech($, settings, dir, script)
    if (audio === undefined) continue
    clips += 1
    sections = sections.map(section => (section.id === script.id ? { ...section, audio } : section))
  }

  if (!(await input.isWanted())) {
    if (clips > 0) {
      await patchJob($, id, { sections })
      if (await isAt($, id, 'done')) await keepJob($, id)
    }

    return
  }

  const hasEarlier = sections.some(section => section.audio !== undefined)
  const voiced =
    clips > 0
      ? `${clips} narrated sections`
      : narrated.length > 0
        ? `the ${settings.tts} speech engine produced no audio here (the macOS system voice cannot speak in some tmux and SSH sessions)${hasEarlier ? '; the earlier clips are kept' : ''}`
        : 'no section was long enough to narrate'
  const note = input.caveat === '' ? voiced : `${voiced}; ${input.caveat}`

  await patchJob($, id, { stage: 'done', sections, note, finishedAt: input.finishedAt ?? (await $.clock.now()) })
  await keepJob($, id)
  $.ui.toast('explainer ready: ctrl+x tab reads it in the pane; /explain view brings it back', { timeoutMs: 10_000 })
}

/**
 * `/explain page`: the opt-in HTML page, built by a second subagent from the
 * finished explainer, with the narration embedded. Nothing is uploaded.
 */
async function buildPage($: EngineInterface): Promise<void> {
  const current = await recallJob($)
  if (current === null || current.stage !== 'done') return
  const { id, dir } = current
  const title = current.title ?? 'Explainer'
  const work = `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')}/lucid-${id}-page`
  await patchJob($, id, { stage: 'paging', note: 'a builder is writing the page' })

  try {
    const table = await loadConfig($)
    const settings = await loadSettings($)
    const roles = { ...table.roles, ...settings.roles }
    const { roster } = await refreshRoster($, false)
    const fallback = await loadFallback($, table)
    let step = current.step ?? stepFor(current.complexity ?? 'moderate', table)
    let html: string | undefined
    let problems: string[] = []

    for (let attempt = 0; attempt < 2 && html === undefined; attempt += 1) {
      const pick = resolveTier(tierAt(step, table), roster, roles, table)
      if (!pick.isResolved) throw new Error(pick.error)
      if (!(await isAt($, id, 'paging'))) return
      if (attempt > 0) await patchJob($, id, { note: 'the first page failed its checks; rebuilding one step up' })

      const built = await runAgent($, {
        kind: 'explainer-page',
        model: pick.model,
        effort: pick.effort,
        fallbackId: newestOf(fallback.models, pick.model.family)?.id,
        prompt: pageBrief({ title, sections: current.sections, dir: work, problems }),
        description: 'Build explainer page',
        timeoutMs: 20 * 60_000,
      })

      const written = await $.fs.read(`${work}/page.html`).catch(() => undefined)
      if (written === undefined) {
        problems = [`the builder ended with "${built.reason}" and did not write page.html`]
      } else {
        const check = checkPage(written, current.sections)
        if (check.isValid) html = written
        else problems = check.problems
      }

      if (html === undefined) {
        const up = escalate(step, table)
        if (up === undefined) break
        step = up
      }
    }

    if (!(await isAt($, id, 'paging'))) return
    if (html === undefined) throw new Error(`the page failed its checks: ${problems.slice(0, 3).join('; ')}`)

    await $.fs.write(`${dir}/page.html`, html)
    // One self-contained file: the page, its audio as data URIs, the player.
    const clips = current.sections.flatMap(section => (section.audio === undefined ? [] : [section.id, mimeOf(section.audio), section.audio]))
    const final = `${dir}/explainer.html`
    const embedded = await $.process
      .run(['/bin/sh', `${$.plugin.root}/scripts/embed.sh`, final, `${dir}/page.html`, `${$.plugin.root}/assets/player.html`, ...clips], { timeoutMs: 120_000 })
      .catch(() => undefined)
    const file = embedded?.exitCode === 0 ? final : `${dir}/page.html`

    if (!(await isAt($, id, 'paging'))) return
    await patchJob($, id, { stage: 'done', file, note: `page written: ${file}`, ...(current.url ? { isUrlStale: true } : {}) })
    await keepJob($, id)
    $.ui.toast('page ready: /explain open opens it; /explain publish uploads it', { timeoutMs: 8000 })
    if (settings.shouldAutoOpen) $.ui.log(await openPage($))
  } catch (err) {
    if (!(await isAt($, id, 'paging'))) return
    await patchJob($, id, { stage: 'done', note: `page not built: ${words(err)}` })
    $.ui.toast(`no page. ${words(err)}`, { timeoutMs: 10_000 })
  }
}

/** Why `/explain publish` cannot run now, or undefined when it can. */
async function publishBlocker($: EngineInterface): Promise<string | undefined> {
  const current = await recallJob($)
  if (current === null || current.file === undefined) return 'there is no page to publish; /explain page builds one'
  if (!(await loadSettings($)).shouldPublish) return 'publishing is off; /explain set publish on arms this command'
  if (!(await $.tool.list().catch(() => [])).some(tool => tool.name === 'Artifact')) return 'this session has no Artifact tool, so the page stays local'

  return undefined
}

/**
 * `/explain publish`: uploads the page as a private artifact, after one
 * confirmation. The only place lucid calls the Artifact tool.
 */
async function publishPage($: EngineInterface): Promise<void> {
  const current = await recallJob($)
  if (current === null || current.file === undefined) return

  const answer = await $.ui
    .ask('Publishing uploads the page, written from your session text, to claude.ai as a private artifact that only you can delete. Publish it?', {
      header: OWN_HEADER,
      options: ['Publish', 'Keep it local'],
    })
    .catch(() => 'Keep it local')
  if (answer !== 'Publish') {
    $.ui.log('not published; the page stays on this machine')

    return
  }

  await patchJob($, current.id, { stage: 'publishing', note: 'publishing privately' })
  const published = await $.tool
    .call({ tool: 'Artifact', action: 'publish', file_path: current.file, icon: 'book', description: `Explainer for: ${current.question.slice(0, 120)}` })
    .catch((err: unknown) => ({ deny: words(err) }))
  const result = 'result' in published ? (published.result as { url?: unknown } | undefined) : undefined
  const url = typeof result?.url === 'string' ? result.url : undefined

  await patchJob($, current.id, {
    ...((await isAt($, current.id, 'publishing')) ? { stage: 'done', note: url === undefined ? 'not published' : 'published privately' } : {}),
    ...(url === undefined ? {} : { url, isUrlStale: false }),
  })
  await keepJob($, current.id)
  $.ui.log(url === undefined ? `not published (${'deny' in published && published.deny ? published.deny : 'the Artifact tool gave no link'})` : `published privately: ${url}`)
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

  const { id } = current
  await voice($, {
    scripts,
    id,
    dir: current.dir,
    sections: current.sections,
    settings: await loadSettings($),
    caveat: '',
    isWanted: () => isAt($, id, 'voicing'),
    ...(current.finishedAt === undefined ? {} : { finishedAt: current.finishedAt }),
  }).catch(async (err: unknown) => {
    if (await isAt($, id, 'voicing')) await patchJob($, id, { stage: 'done', note: `the narration was not rendered again: ${words(err)}` })
  })
}

/** The whole job, start to finish. Runs off any hook's dispatch: started from a timer, the pane already open. */
async function runJob($: EngineInterface, fresh: Job, isDialogOpen: boolean): Promise<void> {
  const { id, dir, question } = fresh
  const isWanted = () => isAt($, id)

  const fail = async (error: string) => {
    if (!(await isWanted())) return
    await patchJob($, id, { stage: 'failed', error, note: error, finishedAt: await $.clock.now() })
    $.ui.toast(`no explainer. ${error}`, { timeoutMs: 10_000 })
  }

  try {
    const work = `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')}/lucid-${id}`
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
      if (!(await isWanted())) return
      const pick = resolveTier(tierAt(step, table), roster, roles, table)
      if (!pick.isResolved) return await fail(pick.error)
      const choice = `${pick.model.id} at ${pick.effort} effort`
      await patchJob($, id, { stage: 'confirming', complexity, step, model: pick.model.id, effort: pick.effort, note: 'asking before building' })

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

    // 3. Build, and once more a rung up if the document fails its checks.
    let document: { title: string; sections: Section[] } | undefined
    let problems: string[] = []
    let builderUsage: Usage | undefined

    for (let attempt = 0; attempt < 2 && document === undefined; attempt += 1) {
      if (!(await isWanted())) return
      const pick = resolveTier(tierAt(step, table), roster, roles, table)
      if (!pick.isResolved) return await fail(pick.error)
      await patchJob($, id, {
        stage: 'building',
        step,
        model: pick.model.id,
        effort: pick.effort,
        note: attempt === 0 ? 'the builder is writing the explainer' : 'the first explainer failed its checks; rebuilding one step up',
      })

      const built = await runAgent($, {
        kind: 'explainer',
        model: pick.model,
        effort: pick.effort,
        fallbackId: newestOf(fallback.models, pick.model.family)?.id,
        prompt: builderBrief({ question, context, dir: work, problems }),
        description: 'Build explainer',
        timeoutMs: 20 * 60_000,
      })
      builderUsage = addUsage(builderUsage, built.usage)
      await patchJob($, id, { model: built.model, ...(builderUsage ? { builderUsage } : {}) })

      const written = await $.fs.read(`${work}/explainer.json`).catch(() => undefined)

      if (written === undefined) {
        problems = [`the builder ended with "${built.reason}" and did not write explainer.json`]
      } else {
        const check = checkExplainer(written)
        if (check.isValid) document = { title: check.title, sections: check.sections }
        else problems = check.problems
      }

      if (document === undefined) {
        const up = escalate(step, table)
        if (up === undefined) break
        step = up
      }
    }

    if (!(await isWanted())) return
    if (document === undefined) return await fail(`the explainer failed its checks: ${problems.slice(0, 3).join('; ')}`)

    await $.fs.write(`${dir}/explainer.json`, JSON.stringify(document, null, 2))
    await patchJob($, id, { stage: 'narrating', title: document.title, sections: document.sections, note: 'writing narration for the long sections' })

    // 4. Narration scripts for the long sections (each section's `narrate` overrides); speech is rendered from them here.
    const long = narratedSections(document.sections, longSections(document.sections, table.narrationMinChars))
    let scripts: Narrated[] = []
    let caveat = ''

    if (long.length > 0) {
      const written = await writeNarration($, { sections: long, from: settings.narrationStep, isStrict: false, roster, fallback, roles })
      if (written.usage) await patchJob($, id, { narratorUsage: written.usage })
      if (written.notes.length > 0) $.ui.log(`narration notes: ${written.notes.join(' | ')}`, { to: 'debug' })
      if (written.scripts.length === 0) caveat = 'no narration writer passed its checks, so the narration reads the sections as written'
      scripts = written.scripts.length > 0 ? written.scripts : rawNarration(long)
      if (!(await isWanted())) return
    }

    await voice($, { id, dir, scripts, settings, caveat, isWanted, sections: document.sections })
  } catch (err) {
    await fail(words(err))
  }
}

/** Starts a job off the calling dispatch. Says why not when one cannot start. */
async function startJob($: EngineInterface, asked: Asked): Promise<Start> {
  if (!(await isInteractive($))) return { kind: 'refused', text: 'explainers need an interactive session' }
  if (asked.question.trim() === '') {
    return { kind: 'refused', text: 'there is no question to explain yet. Run /explain after Claude asks one, or /explain about <text>.' }
  }

  const now = await $.clock.now()
  const id = `j${now.toString(36)}`
  const fresh: Job = {
    id,
    origin: asked.origin,
    question: asked.question,
    dir: `${await dataDir($)}/jobs/${id}`,
    stage: 'classifying',
    note: 'rating the question',
    startedAt: now,
    sections: [],
    ...(asked.dialogId === undefined ? {} : { dialogId: asked.dialogId }),
  }
  let running: Job | null = null
  await update($, job, current => {
    running = isLive(current) ? current : null

    return running === null ? fresh : current
  })
  const live = running as Job | null
  if (live !== null) {
    return { kind: live.question === asked.question ? 'same-question' : 'refused', text: 'an explainer is already being built; /explain status shows where it is' }
  }

  // Opened here, inside the command or the press that asked, so it seats at any width; the build itself runs off this dispatch.
  stopAuto()
  stopPlayback()
  await update($, view, () => FRESH_VIEW)
  await openPane($, !asked.isDialogOpen)
  $.clock.after(1, () => {
    void runJob($, fresh, asked.isDialogOpen)
  })

  return { kind: 'started', text: 'rating the question, then it shows the model and effort it would use' }
}

function describeJob(current: Job | null): string {
  if (current === null) return 'no explainer yet'
  const choice = current.model === undefined ? '' : ` | ${current.model} at ${current.effort ?? '?'} effort (rated ${current.complexity ?? '?'})`
  const spent = current.builderUsage === undefined ? '' : ` | builder tokens ${tokens(current.builderUsage)}; narration tokens ${tokens(current.narratorUsage)}`
  const took = current.finishedAt === undefined ? '' : ` | ${Math.round((current.finishedAt - current.startedAt) / 1000)} s`
  const where = (current.isUrlStale === true ? current.file || current.url : current.url || current.file) || ''

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
    `narration writer: ${tried.model} at ${tier?.effort ?? '?'} effort is the cheapest rung that passed the fixtures (${tokens(tried.usage)} tokens over the rungs tried)` +
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

async function settleOrphan($: EngineInterface): Promise<void> {
  const orphan = await read($, job)

  if (isLive(orphan)) {
    const now = await $.clock.now()
    if (orphan.sections.length === 0) {
      await patchJob($, orphan.id, { stage: 'failed', note: INTERRUPTED, error: INTERRUPTED, finishedAt: now })
    } else {
      await patchJob($, orphan.id, { stage: 'done', note: 'a reload of lucid interrupted the last step; the explainer is as it stood', finishedAt: orphan.finishedAt ?? now })
      await keepJob($, orphan.id)
    }
  }

  if ((await read($, view)).playing !== null) await update($, view, seen => ({ ...seen, playing: null }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'explain',
      description: 'Build an explainer for the last question Claude asked, read in a pane of the terminal',
      argumentHint: USAGE,
    })
    await $.command.register({
      name: 'explain-models',
      description: 'Refresh the model roster lucid picks from and re-check its narration writer',
      argumentHint: '[use <role> <family>]',
    })

    await settleOrphan($).catch(() => undefined)

    // A reload drops the frame timer; the view atom still says whether it ran.
    if ((await read($, view)).isAuto) startAuto($)

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
    if (e.agentId !== undefined || next.origin.plugin !== 'engine' || isOwnDialog(e.questions)) return next(e)

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

    const started = await startJob($, { origin: 'option', question: describeQuestions(asked), isDialogOpen: false, dialogId: e.tool_use_id })
    if (started.kind !== 'refused') return { deny: WITHHELD }
    $.ui.toast(`no explainer for this question: ${started.text}`, { timeoutMs: 8000 })

    return { deny: notStarted(started.text) }
  }).catch(($, e, next) => next(e))

  // A button above the dialog: one click starts the explainer and the dialog stays open.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const held = await read($, pending)
    if (held === null || !held.isOpen || held.id !== e.requestId || isOwnDialog(e.props.questions as { header?: string }[])) return next(e)
    if (!(await loadSettings($)).shouldOffer) return next(e)

    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Button
          key="lucid-explain"
          label="Explain this first"
          onPress={async () => {
            const started = await startJob($, { origin: 'button', question: describeQuestions(held.questions), isDialogOpen: true, dialogId: held.id })
            $.ui.toast(started.text, { timeoutMs: 6000 })
          }}
        />
        {await next(e)}
      </Box>
    )
  })

  on('command.run', { command: 'explain' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const isAboutLast = ['view', 'open', 'revoice', 'page', 'publish'].includes(verb)
    const current = isAboutLast ? await recallJob($) : await read($, job)

    if (verb === 'view') {
      // A command is an asked open, so the pane seats at any width; where it still cannot, the section prints here.
      const isPlaced = await openPane($, true)
      if (isPlaced || current === null || current.sections.length === 0) return { text: describeJob(current) }
      const seen = await read($, view)

      return { text: sectionText(current.title ?? 'Explainer', current.sections, seen.index, (await probe($)).unicodeSafe) }
    }

    if (verb === 'open') return { text: `${await openPage($)}` }

    if (verb === 'page') {
      if (current === null || current.stage !== 'done' || current.sections.length === 0) return { text: 'there is no finished explainer to build a page from' }
      $.clock.after(1, () => {
        void buildPage($)
      })

      return { text: 'a second subagent is writing the HTML page; a line follows when it is ready. Nothing is uploaded.' }
    }

    if (verb === 'publish') {
      const blocker = await publishBlocker($)
      if (blocker !== undefined) return { text: blocker }
      $.clock.after(1, () => {
        void publishPage($)
      })

      return { text: 'asking before anything is uploaded' }
    }
    if (verb === 'status') return { text: describeJob(current ?? (await recallJob($))) }
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
      if (current.finishedAt !== undefined) {
        const what = current.stage === 'paging' ? 'the page build' : current.stage === 'publishing' ? 'publishing' : 'the new narration'
        await patchJob($, current.id, { stage: 'done', note: `${what} was cancelled; the explainer is as it stood` })

        return { text: `cancelled ${what}; the explainer is kept` }
      }
      await patchJob($, current.id, { stage: 'cancelled', note: 'cancelled; a subagent already running finishes on its own', finishedAt: await $.clock.now() })

      return { text: 'cancelled' }
    }

    if (verb !== '' && verb !== 'about') return { text: `/explain has no "${verb}". Usage: /explain ${USAGE}` }

    const held = await read($, pending)
    const question = verb === 'about' ? rest.join(' ') : held === null ? '' : describeQuestions(held.questions)

    return { text: (await startJob($, { origin: 'command', question, isDialogOpen: false })).text }
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
    // Code is on every table (D:3802-3869); the card it sits in is a terminal design, so elsewhere the diagram is a fence.
    const Code = e.surface === 'terminal' ? $.ui.resolve(e).Code : undefined
    const current = await read($, job)
    const seen: View = await read($, view)
    const held = await read($, pending)
    const settings = await loadSettings($)
    const { unicodeSafe } = await probe($)
    const width = Math.max(1, e.props.bodyColumns)
    const cells = displayWidth

    // A full-width strip in the accent: the title at the left, cut to leave a gap, and a counter at the right.
    const strip = (left: string, right: string) => {
      const fitted = fitCells(left, Math.max(0, width - cells(right) - 3))
      const room = Math.max(1, width - cells(fitted) - cells(right) - 2)

      return (
        <Text backgroundColor="claude" color="inverseText" bold wrap="truncate-end">
          {` ${fitted}${' '.repeat(room)}${right} `}
        </Text>
      )
    }
    const keysLine = (keys: string) => (
      <Box paddingX={1} columnGap={2}>
        <Text dimColor>{keys}</Text>
        {!e.props.isFocused && (
          <Text dimColor italic>
            ctrl+x tab to take the keys
          </Text>
        )}
      </Box>
    )

    if (current === null) {
      return (
        <Box flexDirection="column">
          {strip('lucid', 'explainer')}
          <Box flexDirection="column" paddingX={1} paddingY={1}>
            <Text>No explainer in this session yet.</Text>
            <Text color="text">When Claude asks a question, pick "Explain this first", or run /explain afterwards.</Text>
            <Text color="text">/explain view brings back the last one you built.</Text>
          </Box>
        </Box>
      )
    }

    const title = current.title ?? 'Explainer'
    const count = current.sections.length
    const index = Math.min(seen.index, Math.max(count - 1, 0))
    const section = current.sections[index]
    const steps = section?.steps ?? []
    const step = Math.min(seen.step, Math.max(steps.length - 1, 0))
    const isPlaying = section !== undefined && seen.playing === section.id
    const isSettled = current.stage === 'done' || current.stage === 'failed' || current.stage === 'cancelled'
    const canAskAgain = current.origin === 'option' && current.stage === 'done' && current.dialogId !== undefined && held?.id === current.dialogId
    const clamp = (at: number) => Math.min(Math.max(at, 0), Math.max(count - 1, 0))
    const goSection = (to: number) => update($, view, shown => ({ ...shown, index: clamp(to), step: 0, isToc: false }))
    const stepSection = (by: number) => update($, view, shown => ({ ...shown, index: clamp(clamp(shown.index) + by), step: 0, isToc: false }))
    const lastStep = Math.max(steps.length - 1, 0)
    const hasFrames = steps.length > 1
    const canPlay = section?.audio !== undefined && !isPlaying
    const canStop = seen.playing !== null
    const hasPage = current.file !== undefined || Boolean(current.url)
    const digits = Math.min(count, 9)
    const goStep = (by: number) => update($, view, shown => ({ ...shown, step: Math.min(Math.max(Math.min(shown.step, lastStep) + by, 0), lastStep) }))

    // A thin reading-progress bar across the whole width, in eighths.
    const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
    const ratio = count === 0 ? 0 : (index + 1) / count
    const full = Math.floor(ratio * width)
    const part = Math.floor((ratio * width - full) * 8)
    const bar = '█'.repeat(full) + (EIGHTHS[part] ?? '')
    const rest = '░'.repeat(Math.max(0, width - cells(bar)))

    // The build as a pipeline while it runs, or the reason it stopped.
    const STAGES: { stage: Stage; label: string }[] = [
      { stage: 'classifying', label: 'rated' },
      { stage: 'confirming', label: 'chosen' },
      { stage: 'building', label: 'building' },
      { stage: 'narrating', label: 'narrating' },
      { stage: 'voicing', label: 'voicing' },
    ]
    const at = STAGES.findIndex(one => one.stage === current.stage)
    const pipeline = (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        {current.stage === 'failed' || current.stage === 'cancelled' ? (
          <Text>
            <Text color={current.stage === 'failed' ? 'error' : 'warning'}>{current.stage === 'failed' ? '✗ ' : '■ '}</Text>
            <Text>{printable(current.note)}</Text>
          </Text>
        ) : (
          <Box flexDirection="column">
            {at < 0 ? (
              <Text color="claude" bold>
                ◐ {current.stage === 'publishing' ? 'publishing' : 'building the page'}
              </Text>
            ) : (
              <Box key="stages" columnGap={2} flexWrap="wrap">
                {STAGES.map((one, i) => (
                  <Box key={`stage-${i}`} flexShrink={0}>
                    {i < at && <Text color="success">✓ {one.label}</Text>}
                    {i === at && (
                      <Text color="claude" bold>
                        ◐ {one.label}
                      </Text>
                    )}
                    {i > at && <Text dimColor>○ {one.label}</Text>}
                  </Box>
                ))}
              </Box>
            )}
            <Text color="text">
              {printable(current.note)}
              {current.model === undefined ? '' : ` · ${current.model}, ${current.effort ?? '?'} effort, rated ${current.complexity ?? '?'}`}
            </Text>
          </Box>
        )}
      </Box>
    )

    // Section tabs when they fit on one row: click one, or press its digit while the contents list is up.
    const tabLabels = current.sections.map(one => one.heading)
    const tabsWidth = tabLabels.reduce((sum, label) => sum + cells(label) + 2, 0) + Math.max(0, count - 1) * 3 + 2
    const tabs =
      count > 1 && tabsWidth <= width ? (
        <Box paddingX={1} columnGap={3}>
          {current.sections.map((one, i) => (
            <Button key={`tab-${i}`} plain onPress={() => goSection(i)}>
              {i === index ? (
                <Text color="claude" bold>
                  ▸ {one.heading}
                </Text>
              ) : (
                <Text color="text">{`  ${one.heading}`}</Text>
              )}
            </Button>
          ))}
        </Box>
      ) : count > 1 ? (
        <Box paddingX={1}>
          <Text color="claude">{index + 1}</Text>
          <Text color="text"> of {count} · </Text>
          <Text color="text" bold>
            {section?.heading ?? ''}
          </Text>
        </Box>
      ) : undefined

    const diagram =
      section?.diagram === undefined
        ? undefined
        : (() => {
            const picked = pickDiagram(section.diagram, { unicodeSafe, columns: Math.max(1, width - CARD_INSET) })
            const drawn = picked.lines.join('\n')
            const cut = picked.isCut && (
              <Text color="text">
                {`diagram is ${widthOf(picked.lines)} columns wide${e.props.placement === 'dock' && e.props.isFocused ? '; ctrl+x then ← widens the pane' : ''}`}
              </Text>
            )

            return Code === undefined ? (
              <Box flexDirection="column" marginTop={1}>
                <Markdown text={'```text\n' + drawn + '\n```'} />
                {cut}
              </Box>
            ) : (
              <Box flexDirection="column" marginTop={1}>
                <Box borderStyle="round" borderDimColor paddingX={1}>
                  <Code source={drawn} language="text" wrap="truncate-end" />
                </Box>
                {cut}
              </Box>
            )
          })()

    // Frames: a timeline of dots, the revealed frames under it, the current one marked.
    const dots = steps.map((_, i) => (i < step ? '●' : i === step ? '◉' : '○'))
    const counter = `  ${step + 1}/${steps.length}${seen.isAuto ? ' · auto' : ''}`
    const timeline = [dots.join('━'), dots.join('')].find(drawn => cells(drawn) + cells(counter) <= width - 2) ?? '◉'
    const frames = steps.length > 0 && (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color="claude">{timeline}</Text>
          <Text dimColor>{counter}</Text>
        </Text>
        {steps.slice(0, step + 1).map((line, i) => (
          <Box key={`step-${i}`} paddingLeft={1}>
            {i === step ? (
              <Text color="text" bold>
                <Text color="claude">▶ </Text>
                {line}
              </Text>
            ) : (
              <Text color="text">
                <Text color="success">✓ </Text>
                {line}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )

    const blocks = section === undefined ? [] : splitTables(section.markdown)
    const tableCells = blocks.reduce((sum, block) => sum + (block.kind === 'table' ? (block.rows.length + 1) * block.header.length : 0), 0)

    const body = seen.isToc ? (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text dimColor>CONTENTS</Text>
        {current.sections.map((one, i) => (
          <Box key={`toc-${i}`} columnGap={1}>
            <Text color="claude">{i === index ? '●' : '○'}</Text>
            {i < 9 ? (
              <Button key={`toc-go-${i}`} label={one.heading} hotkey={String(i + 1)} plain onPress={() => goSection(i)} />
            ) : (
              <Button key={`toc-go-${i}`} label={one.heading} plain onPress={() => goSection(i)} />
            )}
          </Box>
        ))}
      </Box>
    ) : section === undefined ? (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>{isSettled ? 'this explainer has no sections' : 'the sections appear here as soon as the builder is done'}</Text>
      </Box>
    ) : (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color="claude" bold>
          {section.heading}
        </Text>
        {blocks.map((block, i) =>
          block.kind === 'markdown' ? (
            <Box key={`block-${i}`} marginTop={1}>
              <Markdown text={block.text} />
            </Box>
          ) : (
            (() => {
              // The engine draws table cells dim; lucid draws its own at full strength, the header in the accent.
              const widths = tableCells > TABLE_CELLS_MAX ? undefined : tableWidths(block, Math.max(1, width - CARD_INSET), 2)
              if (widths === undefined) {
                return (
                  <Box key={`block-${i}`} marginTop={1}>
                    <Markdown text={block.raw.join('\n')} />
                  </Box>
                )
              }
              const inner = widths.reduce((sum, w) => sum + w, 0) + 2 * Math.max(0, widths.length - 1)

              return (
                <Box key={`block-${i}`} flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
                  <Box columnGap={2}>
                    {block.header.map((cell, c) => (
                      <Box key={`h-${i}-${c}`} width={widths[c]}>
                        <Text color="claude" bold wrap="wrap">
                          {plainCell(cell)}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                  <Text dimColor>{'─'.repeat(inner)}</Text>
                  {block.rows.map((row, r) => (
                    <Box key={`r-${i}-${r}`} columnGap={2}>
                      {widths.map((w, c) => (
                        <Box key={`c-${i}-${r}-${c}`} width={w}>
                          <Text color="text" wrap="wrap">
                            {plainCell(row[c] ?? '')}
                          </Text>
                        </Box>
                      ))}
                    </Box>
                  ))}
                </Box>
              )
            })()
          ),
        )}
        {diagram}
        {frames}
        {section.takeaway !== undefined && (
          <Box marginTop={1} borderStyle="quote" borderColor="claude" paddingX={1}>
            <Text color="text">
              <Text color="claude">✦ </Text>
              {section.takeaway}
            </Text>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {strip(title, count > 0 ? `${index + 1} / ${count}` : current.stage)}
        <Text>
          <Text color="claude">{bar}</Text>
          <Text dimColor>{rest}</Text>
        </Text>
        {!isSettled || current.stage !== 'done' ? pipeline : undefined}
        {count > 0 && !seen.isToc && <Box paddingTop={1}>{tabs}</Box>}
        {body}
        <Box columnGap={1} paddingX={1} flexWrap="wrap">
          {count > 1 && <Button key="prev" label="◀ Prev" hotkey="p" onPress={() => stepSection(-1)} />}
          {count > 1 && <Button key="next" label="Next ▶" hotkey="n" variant="primary" onPress={() => stepSection(1)} />}
          {hasFrames && <Button key="frame-back" label="‹ Frame" hotkey="b" onPress={() => goStep(-1)} />}
          {hasFrames && <Button key="frame" label="Frame ›" hotkey="f" onPress={() => goStep(1)} />}
          {hasFrames && settings.shouldAnimate && (
            <Button
              key="auto"
              label={seen.isAuto ? '⟳ Pause' : '⟳ Auto'}
              hotkey="g"
              onPress={async () => {
                await update($, view, shown => ({ ...shown, isAuto: !shown.isAuto, step: !shown.isAuto && shown.step >= lastStep ? 0 : shown.step }))
                if ((await read($, view)).isAuto) startAuto($)
                else stopAuto()
              }}
            />
          )}
          {canPlay && section !== undefined && (
            <Button
              key="play"
              label="▶ Play"
              hotkey="l"
              onPress={() => {
                void playSection($, section.id)
              }}
            />
          )}
          {canStop && (
            <Button
              key="stop"
              label="■ Stop"
              hotkey="s"
              onPress={async () => {
                stopPlayback()
                await update($, view, shown => ({ ...shown, playing: null }))
              }}
            />
          )}
          {count > 0 && <Button key="toc" label={seen.isToc ? '≡ Close' : '≡ Contents'} hotkey="t" onPress={() => update($, view, shown => ({ ...shown, isToc: !shown.isToc }))} />}
          {hasPage && (
            <Button
              key="open"
              label="⤴ Page"
              hotkey="o"
              onPress={async () => {
                $.ui.toast(`${await openPage($)}`, { timeoutMs: 6000 })
              }}
            />
          )}
          {canAskAgain && (
            <Button
              key="again"
              label="↺ Ask me again"
              hotkey="a"
              onPress={() => {
                void $.prompt.submit({ text: 'I have read the explainer. Ask me that question again.' })
              }}
            />
          )}
        </Box>
        {keysLine(
          [
            count > 1 ? 'p n' : '',
            count === 0 ? '' : !seen.isToc ? 't' : digits > 1 ? `t 1-${digits}` : 't 1',
            hasFrames ? (settings.shouldAnimate ? 'f b g' : 'f b') : '',
            [canPlay ? 'l' : '', canStop ? 's' : ''].filter(Boolean).join(' '),
            hasPage ? 'o' : '',
            canAskAgain ? 'a' : '',
          ]
            .filter(Boolean)
            .join(' · '),
        )}
        {current.url !== undefined && current.url !== '' && (
          <Box paddingX={1}>
            <Link href={current.url} label={current.isUrlStale === true ? `${current.url} (older than the local page; /explain publish uploads the new one)` : current.url} />
          </Box>
        )}
      </Box>
    )
  })
}
