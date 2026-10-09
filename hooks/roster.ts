import type { Effort, Tier } from '../types'

// The roster: which models exist, which family each belongs to and what each
// supports. Nothing here names a model or a family; both arrive as data, from
// the models API, the engine's aliases or roster.fallback.json.

export type Config = {
  roles: Record<string, string>
  excludeIdPrefixes: string[]
  efforts: Effort[]
  ladder: Tier[]
  routing: Record<string, number>
  classifier: Tier
  narrationLadder: Tier[]
  narrationMinChars: number
  rosterMaxAgeHours: number
}

export type RosterModel = {
  id: string
  family: string
  name: string
  createdAt: string
  efforts: Effort[]
  inputPerMTok?: number
  outputPerMTok?: number
  note?: string
}

export type RosterSource = 'api' | 'alias' | 'fallback'

export type Roster = {
  source: RosterSource
  fetchedAt: number
  models: RosterModel[]
  /** `<model id>: <capability key>` for every capability that reads like audio. */
  audioCapabilities: string[]
  asOf?: string
}

export type Price = { name: string; inputPerMTok: number; outputPerMTok: number; note?: string }

export type Resolved =
  | { isResolved: true; model: RosterModel; effort: Effort; wasClamped: boolean }
  | { isResolved: false; error: string }

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const isTier = (value: unknown): value is Tier =>
  isRecord(value) && typeof value.role === 'string' && typeof value.effort === 'string'

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []

export function parseConfig(text: string): Config {
  const raw: unknown = JSON.parse(text)

  if (!isRecord(raw) || !isRecord(raw.roles) || !isRecord(raw.routing)) {
    throw new Error('lucid.config.json needs "roles" and "routing" objects')
  }

  const ladder = Array.isArray(raw.ladder) ? raw.ladder.filter(isTier) : []
  const narrationLadder = Array.isArray(raw.narrationLadder) ? raw.narrationLadder.filter(isTier) : []

  if (ladder.length === 0 || narrationLadder.length === 0 || !isTier(raw.classifier)) {
    throw new Error('lucid.config.json needs "ladder", "narrationLadder" and "classifier" tiers')
  }

  const roles: Record<string, string> = {}
  for (const [role, family] of Object.entries(raw.roles)) {
    if (typeof family === 'string') roles[role] = family
  }

  const routing: Record<string, number> = {}
  for (const [complexity, step] of Object.entries(raw.routing)) {
    if (typeof step === 'number') routing[complexity] = step
  }

  return {
    roles,
    routing,
    ladder,
    narrationLadder,
    classifier: raw.classifier,
    excludeIdPrefixes: strings(raw.excludeIdPrefixes),
    efforts: strings(raw.efforts) as Effort[],
    narrationMinChars: typeof raw.narrationMinChars === 'number' ? raw.narrationMinChars : 600,
    rosterMaxAgeHours: typeof raw.rosterMaxAgeHours === 'number' ? raw.rosterMaxAgeHours : 24,
  }
}

/** `claude-<family>-<version>`: the family is the word after the vendor prefix. */
export function familyFromId(id: string): string | undefined {
  return /^[a-z]+-([a-z]+)-\d/.exec(id)?.[1]
}

const versionOf = (id: string): number[] => (id.match(/\d+/g) ?? []).map(Number)

/** Newest first: by creation date, then by the version numbers in the id. */
export function compareNewest(a: RosterModel, b: RosterModel): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1

  const left = versionOf(a.id)
  const right = versionOf(b.id)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)
    if (diff !== 0) return diff
  }

  return 0
}

export function newestOf(models: readonly RosterModel[], family: string): RosterModel | undefined {
  return models.filter(model => model.family === family).sort(compareNewest)[0]
}

export function parseModelsResponse(text: string, config: Config, now: number): Roster {
  const body: unknown = JSON.parse(text)

  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error('the models response has no "data" list')
  }

  const models: RosterModel[] = []
  const audioCapabilities: string[] = []

  for (const row of body.data) {
    if (!isRecord(row) || typeof row.id !== 'string') continue
    const id = row.id
    if (config.excludeIdPrefixes.some(prefix => id.startsWith(prefix))) continue
    if (typeof row.lifecycle === 'string' && row.lifecycle !== 'active') continue

    const family = typeof row.line === 'string' && row.line !== '' ? row.line : familyFromId(id)
    if (family === undefined) continue

    const capabilities = isRecord(row.capabilities) ? row.capabilities : {}
    const effort = isRecord(capabilities.effort) ? capabilities.effort : {}
    const efforts =
      effort.supported === true
        ? config.efforts.filter(level => {
            const flag = effort[level]

            return isRecord(flag) && flag.supported === true
          })
        : []

    for (const [key, flag] of Object.entries(capabilities)) {
      const isOn = !isRecord(flag) || flag.supported !== false
      if (isOn && /audio|speech|voice/i.test(key)) audioCapabilities.push(`${id}: ${key}`)
    }

    models.push({
      id,
      family,
      efforts,
      name: typeof row.display_name === 'string' ? row.display_name : id,
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    })
  }

  if (models.length === 0) throw new Error('the models response lists no usable model')

  return { source: 'api', fetchedAt: now, models, audioCapabilities }
}

export function parseFallback(text: string, config: Config, now: number): Roster {
  const raw: unknown = JSON.parse(text)

  if (!isRecord(raw) || !Array.isArray(raw.models)) {
    throw new Error('roster.fallback.json has no "models" list')
  }

  const models: RosterModel[] = []
  for (const row of raw.models) {
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.family !== 'string') continue
    models.push({
      id: row.id,
      family: row.family,
      name: typeof row.name === 'string' ? row.name : row.id,
      createdAt: '',
      efforts: config.efforts.filter(level => strings(row.efforts).includes(level)),
      ...(typeof row.inputPerMTok === 'number' ? { inputPerMTok: row.inputPerMTok } : {}),
      ...(typeof row.outputPerMTok === 'number' ? { outputPerMTok: row.outputPerMTok } : {}),
      ...(typeof row.note === 'string' ? { note: row.note } : {}),
    })
  }

  return {
    source: 'fallback',
    fetchedAt: now,
    models,
    audioCapabilities: [],
    ...(typeof raw.asOf === 'string' ? { asOf: raw.asOf } : {}),
  }
}

/**
 * The roster when the API cannot be reached: each mapped family under the
 * engine's own alias for it (the family's name), which the engine resolves.
 */
export function aliasRoster(config: Config, fallback: Roster, now: number): Roster {
  const families = [...new Set(Object.values(config.roles))]

  return {
    source: 'alias',
    fetchedAt: now,
    audioCapabilities: [],
    models: families.map(family => {
      const known = newestOf(fallback.models, family)

      return {
        id: family,
        family,
        name: `${family} (engine alias)`,
        createdAt: '',
        efforts: known?.efforts ?? config.efforts,
        ...(known?.inputPerMTok !== undefined ? { inputPerMTok: known.inputPerMTok } : {}),
        ...(known?.outputPerMTok !== undefined ? { outputPerMTok: known.outputPerMTok } : {}),
      }
    }),
  }
}

const dollars = (cell: string): number | undefined => {
  const match = /\$\s*([\d,]+(?:\.\d+)?)/.exec(cell)

  return match?.[1] === undefined ? undefined : Number(match[1].replaceAll(',', ''))
}

/**
 * Reads the first price table of the pricing page: one row per model, its
 * base input and output price per million tokens. A model listed in two
 * tiers keeps its first row and notes the second.
 */
export function parsePricing(markdown: string): Price[] {
  const prices: Price[] = []
  let input = -1
  let output = -1

  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) {
      if (prices.length > 0) break
      input = -1
      continue
    }

    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())

    if (input < 0) {
      input = cells.findIndex(cell => /input/i.test(cell))
      output = cells.findIndex(cell => /output/i.test(cell))
      if (output < 0) input = -1
      continue
    }

    const first = (cells[0] ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')
    const name = first.replace(/\s*\(.*$/, '').trim()
    const tier = /\(([^)]*)\)/.exec(first)?.[1]
    const inputPerMTok = dollars(cells[input] ?? '')
    const outputPerMTok = dollars(cells[output] ?? '')
    if (name === '' || inputPerMTok === undefined || outputPerMTok === undefined) continue

    const seen = prices.find(price => price.name === name)
    if (seen === undefined) {
      prices.push({ name, inputPerMTok, outputPerMTok, ...(tier !== undefined ? { note: tier } : {}) })
    } else {
      seen.note = `${seen.note ?? 'first tier'}; ${tier ?? 'next tier'}: $${inputPerMTok} in / $${outputPerMTok} out`
    }
  }

  return prices
}

export function applyPricing(roster: Roster, prices: readonly Price[], fallback: Roster): Roster {
  return {
    ...roster,
    models: roster.models.map(model => {
      const listed = prices.find(price => price.name === model.name)
      const known = fallback.models.find(row => row.id === model.id)
      const inputPerMTok = listed?.inputPerMTok ?? known?.inputPerMTok
      const outputPerMTok = listed?.outputPerMTok ?? known?.outputPerMTok
      const note = listed?.note ?? known?.note

      return {
        ...model,
        ...(inputPerMTok !== undefined ? { inputPerMTok } : {}),
        ...(outputPerMTok !== undefined ? { outputPerMTok } : {}),
        ...(note !== undefined ? { note } : {}),
      }
    }),
  }
}

/** The nearest supported level at or below the one asked for, else the nearest above. */
export function clampEffort(wanted: Effort, supported: readonly Effort[], order: readonly Effort[]): Effort {
  if (supported.length === 0 || supported.includes(wanted)) return wanted

  const at = order.indexOf(wanted)
  const below = order.slice(0, Math.max(at, 0)).reverse().find(level => supported.includes(level))

  return below ?? order.find(level => supported.includes(level)) ?? wanted
}

export function resolveTier(tier: Tier, roster: Roster, roles: Record<string, string>, config: Config): Resolved {
  const family = roles[tier.role]
  if (family === undefined) return { isResolved: false, error: `no model family is mapped to the "${tier.role}" role` }

  const model = newestOf(roster.models, family)
  if (model === undefined) return { isResolved: false, error: `the roster has no "${family}" model` }

  const effort = clampEffort(tier.effort, model.efforts, config.efforts)

  return { isResolved: true, model, effort, wasClamped: effort !== tier.effort }
}

/** Families the roster lists that no role uses: never picked without a decision. */
export function unknownFamilies(roster: Roster, roles: Record<string, string>): string[] {
  const mapped = new Set(Object.values(roles))

  return [...new Set(roster.models.map(model => model.family))].filter(family => !mapped.has(family)).sort()
}

export function isStale(roster: Roster | undefined, now: number, maxAgeHours: number): boolean {
  return roster === undefined || now - roster.fetchedAt > maxAgeHours * 3_600_000
}

/** What a refresh changed, one line per change; empty when nothing did. */
export function describeChanges(before: Roster | undefined, after: Roster, roles: Record<string, string>): string[] {
  const lines: string[] = []

  if (before === undefined) return [`first roster, from the ${after.source}: ${after.models.length} models`]
  if (before.source !== after.source) lines.push(`source: ${before.source} -> ${after.source}`)

  for (const [role, family] of Object.entries(roles)) {
    const was = newestOf(before.models, family)?.id
    const now = newestOf(after.models, family)?.id
    if (was !== now) lines.push(`${role} (${family}): ${was ?? 'none'} -> ${now ?? 'none'}`)
  }

  const known = new Set(unknownFamilies(before, roles))
  for (const family of unknownFamilies(after, roles)) {
    if (!known.has(family)) lines.push(`new family "${family}": not used until you map it to a role`)
  }

  const heard = new Set(before.audioCapabilities)
  for (const capability of after.audioCapabilities) {
    if (!heard.has(capability)) lines.push(`possible audio capability: ${capability}`)
  }

  return lines
}

export function describePrice(model: RosterModel): string {
  if (model.inputPerMTok === undefined || model.outputPerMTok === undefined) return 'price unknown'

  return `$${model.inputPerMTok} in / $${model.outputPerMTok} out per MTok`
}
