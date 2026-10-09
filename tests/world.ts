import { mock } from 'claude-code/testing'

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Job, Pending, View } from '../types'

import { CONFIG_TEXT, FALLBACK_TEXT } from './fixtures'

// The world beneath lucid for a hook test: an interactive session with a
// clock, a store, files and lucid's state in memory, and a record of every
// call that would spend, upload or speak. A file keyed `*/name` answers a
// read of that name under any folder, as the plugin's own files are read.

export const PANE = { plugin: 'lucid', component: 'Pane', requestId: 'lucid' } as const
export const PANE_PROPS = { title: 'Explainer', isFocused: true, bodyColumns: 63, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

export type WorldOptions = {
  store?: Record<string, unknown>
  env?: Record<string, string>
  files?: Record<string, string>
  job?: Job | null
  pending?: Pending | null
  /** What the Artifact tool, a question dialog and `$.ui.ask` answer; each defaults to a refusal or the first option. */
  answers?: { ask?: string[]; dialog?: Record<string, string>; artifactUrl?: string }
  tools?: string[]
  isInteractive?: boolean
  /** How long the rating call, a process (by its argv) and a clip take on the mocked clock; 0 when not given. */
  rateMs?: number
  runMs?: (argv: readonly string[]) => number
  clipMs?: number
  /** The exit code of a process, by its argv; 0 when not given. */
  exitCode?: (argv: readonly string[]) => number
  /** The size `fs.stat` answers for a path; a spoken clip's when not given. */
  bytes?: (path: string) => number
}

export type World = {
  clock: ReturnType<typeof mock.clock>
  files: Map<string, string>
  toasts: string[]
  logs: string[]
  asked: string[]
  dialogs: { tool_use_id: string; labels: string[][] }[]
  modelCalls: string[]
  spawns: string[]
  fetches: string[]
  processes: string[][]
  artifacts: Record<string, unknown>[]
  clipsStarted: number
  clipsEnded: number
  job: () => Job | null
  setJob: (value: Job | null) => void
  view: () => View
  pending: () => Pending | null
}

export function world(on: On, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, options.store ?? {})
  mock.env(on, { HOME: '/home', TMPDIR: '/tmp/', LUCID_ROSTER_SOURCE: 'fallback', ...options.env })

  const files = new Map<string, string>([
    ['*/lucid.config.json', CONFIG_TEXT],
    ['*/roster.fallback.json', FALLBACK_TEXT],
    ['*/prompts/explainer.md', 'explainer rules'],
    ['*/prompts/explainer-page.md', 'page rules'],
    ['*/prompts/narration-writer.md', 'narration rules'],
    ...Object.entries(options.files ?? {}),
  ])
  const cells = new Map<string, { value: unknown; version: number }>([
    ['job', { value: options.job ?? null, version: 1 }],
    ['pending', { value: options.pending ?? null, version: 1 }],
  ])
  const answers = [...(options.answers?.ask ?? [])]
  const seen: World = {
    clock,
    files,
    toasts: [],
    logs: [],
    asked: [],
    dialogs: [],
    modelCalls: [],
    spawns: [],
    fetches: [],
    processes: [],
    artifacts: [],
    clipsStarted: 0,
    clipsEnded: 0,
    job: () => (cells.get('job')?.value ?? null) as Job | null,
    setJob: value => {
      cells.set('job', { value, version: (cells.get('job')?.version ?? 0) + 1 })
    },
    view: () => cells.get('view')?.value as View,
    pending: () => (cells.get('pending')?.value ?? null) as Pending | null,
  }

  on('state.get', { plugin: 'lucid' }, (_$, e) => ({ value: cells.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', { plugin: 'lucid' }, (_$, e) => {
    const held = cells.get(e.key) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false, version: held.version } }
    cells.set(e.key, { value: e.value, version: held.version + 1 })

    return { value: { isSet: true, version: held.version + 1 } }
  })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: options.isInteractive === false ? [] : ['terminal'] }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', (_$, e) => ({ value: { agent: `lucid:${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)

    return { value: undefined }
  })
  on('ui.notice', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path) ?? [...files].find(([path]) => path.startsWith('*') && e.path.endsWith(path.slice(1)))?.[1]
    if (text === undefined) throw new Error(`no file ${e.path}`)

    return { value: e.as === 'bytes' ? { base64: text } : text }
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.stat', (_$, e) => ({ value: { kind: 'file', size: options.bytes?.(e.path) ?? 400_000, mtimeMs: 0, isLink: false } }))
  on('model.complete', async (_$, e) => {
    seen.modelCalls.push(e.prompt ?? '')
    if (options.rateMs !== undefined) await clock.sleep(options.rateMs)

    return { value: { isAnswered: true, text: 'simple', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  // The kit hands a plugin's spawn back without an agent id, so lucid reads it as not started and goes on to
  // the file the subagent would have written: a test seeds that file to stand for the subagent's work.
  on('agent.spawn', (_$, e) => {
    seen.spawns.push((e as { subagent_type?: string }).subagent_type ?? e.subagentType)

    return { model: 'claude-sonnet-5-5' }
  })
  on('http.fetch', (_$, e) => {
    seen.fetches.push(e.url)

    return { value: { ok: false, status: 503, text: '', headers: {} } }
  })
  on('process.run', async (_$, e) => {
    seen.processes.push([...e.argv])
    const ms = options.runMs?.(e.argv) ?? 0
    if (ms > 0) await clock.sleep(ms)

    return { value: { exitCode: options.exitCode?.(e.argv) ?? 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('audio.play', async () => {
    seen.clipsStarted += 1
    if (options.clipMs !== undefined) await clock.sleep(options.clipMs)
    seen.clipsEnded += 1

    return { value: undefined }
  })
  on('tool.list', () => ({ value: (options.tools ?? ['Artifact']).map(name => ({ name, description: name, mcp: false })) }))
  on('tool.call', { tool: 'Artifact' }, (_$, e) => {
    seen.artifacts.push({ ...e })

    return { result: { url: options.answers?.artifactUrl ?? 'https://claude.ai/artifact/a1' } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const [first] = e.questions
    if (first !== undefined && first.header === 'lucid') {
      seen.asked.push(first.question)
      const answer = answers.shift() ?? first.options[0]?.label ?? ''

      return { result: { answers: { [first.question]: answer } } }
    }
    seen.dialogs.push({ tool_use_id: e.tool_use_id, labels: e.questions.map(question => question.options.map(option => option.label)) })

    return { result: { answers: options.answers?.dialog ?? Object.fromEntries(e.questions.map(question => [question.question, question.options[0]?.label ?? ''])) } }
  })

  return seen
}

export const explain = ($: Engine, args: string) => $.command.run({ command: 'explain', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
