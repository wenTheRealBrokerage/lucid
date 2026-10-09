import type { Section } from '../types'

// Narration scripts: what the writer returns, repaired into shape, checked
// against the text it narrates and cut into chunks a speech engine takes.

export const CHUNK_LIMIT = 4096

export type Narrated = { id: string; narrate: boolean; script: string; chunks: string[] }

export type NarrationCheck =
  | { isValid: true; sections: Narrated[]; repairs: string[] }
  | { isValid: false; problems: string[]; repairs: string[] }

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The JSON value in a reply that may wrap it in prose or a code fence. */
export function extractJson(reply: string): unknown {
  const unfenced = reply.replace(/```[a-z]*\n?/gi, '').trim()
  const open = unfenced.search(/[{[]/)
  const close = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'))
  if (open < 0 || close <= open) return undefined

  const body = unfenced.slice(open, close + 1)
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // the next candidate is the same text with its trailing commas removed
    }
  }

  return undefined
}

/** Plain text of a section's markdown: what a listener would hear it describe. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Numbers standing alone in prose: not part of an identifier, a path or a
 * ticket id. Just the figure, so `$12,000` and `85%` read as `12,000` and
 * `85`: a script may say "12,000 dollars" or "85 percent".
 */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/(?<![\w./#-])\$?(\d(?:[\d,]*\d)?(?:\.\d+)?)%?(?![\w/-]|\.\d)/g)].flatMap(match => match[1] ?? [])
}

/** Capitalised words inside a sentence: names of people, products and places. */
export function namesIn(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/(?<=[a-z,;:)]\s)([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*)/g)) {
    if (match[1] !== undefined) names.add(match[1])
  }

  return [...names]
}

/** A script in pieces no longer than `limit`, cut at sentence ends where it can. */
export function chunkScript(script: string, limit: number = CHUNK_LIMIT): string[] {
  const chunks: string[] = []
  let current = ''

  const push = (piece: string) => {
    if (piece.trim() !== '') chunks.push(piece.trim())
  }

  for (const sentence of script.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? []) {
    if ((current + sentence).length <= limit) {
      current += sentence
      continue
    }

    push(current)
    current = sentence

    while (current.length > limit) {
      const cut = current.lastIndexOf(' ', limit)
      const at = cut > 0 ? cut : limit
      push(current.slice(0, at))
      current = current.slice(at)
    }
  }

  push(current)

  return chunks
}

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'yes') return true
  if (value === 'false' || value === 'no') return false

  return undefined
}

/**
 * Brings a writer's reply into `{ sections: [{ id, narrate, script }] }` and
 * checks it: every narrated script keeps the section's standalone numbers
 * word for word (and its names, when `isStrict`), and no chunk is too long.
 */
export function checkNarration(reply: string, sections: readonly Section[], isStrict = false): NarrationCheck {
  const repairs: string[] = []
  const parsed = extractJson(reply)

  if (parsed === undefined) return { isValid: false, problems: ['the reply holds no JSON'], repairs }
  if (!/^\s*[{[]/.test(reply)) repairs.push('took the JSON out of surrounding text')

  const rows = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.sections) ? parsed.sections : undefined
  if (rows === undefined) return { isValid: false, problems: ['the JSON has no "sections" list'], repairs }
  if (Array.isArray(parsed)) repairs.push('wrapped a bare list as "sections"')

  const known = new Map(sections.map(section => [section.id, section]))
  const narrated: Narrated[] = []
  const problems: string[] = []

  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string') {
      repairs.push('dropped a row with no id')
      continue
    }

    const section = known.get(row.id)
    if (section === undefined) {
      repairs.push(`dropped unknown section "${row.id}"`)
      continue
    }

    if (narrated.some(one => one.id === row.id)) {
      repairs.push(`dropped a second "${row.id}"`)
      continue
    }

    const script = typeof row.script === 'string' ? row.script.trim() : ''
    const flag = asBoolean(row.narrate)
    if (typeof row.narrate !== 'boolean') repairs.push(`read "narrate" of "${row.id}" as ${String(flag ?? script !== '')}`)
    const narrate = (flag ?? script !== '') && script !== ''

    if (narrate) {
      const source = plainText(section.markdown)
      const missingNumbers = numbersIn(source).filter(number => !script.includes(number))
      if (missingNumbers.length > 0) problems.push(`"${row.id}" drops or rewrites ${missingNumbers.join(', ')}`)

      const said = script.toLowerCase()
      const missingNames = isStrict ? namesIn(source).filter(name => !said.includes(name.toLowerCase())) : []
      if (missingNames.length > 0) problems.push(`"${row.id}" drops the name ${missingNames.join(', ')}`)
    }

    const chunks = narrate ? chunkScript(script) : []
    if (chunks.some(chunk => chunk.length > CHUNK_LIMIT)) problems.push(`"${row.id}" has a chunk over ${CHUNK_LIMIT} characters`)

    narrated.push({ id: row.id, narrate, script: narrate ? script : '', chunks })
  }

  for (const section of sections) {
    if (!narrated.some(one => one.id === section.id)) {
      repairs.push(`added "${section.id}" as not narrated`)
      narrated.push({ id: section.id, narrate: false, script: '', chunks: [] })
    }
  }

  return problems.length > 0 ? { isValid: false, problems, repairs } : { isValid: true, sections: narrated, repairs }
}

/** The sections long enough to be worth a narration at all. */
export function longSections(sections: readonly Section[], minChars: number): Section[] {
  return sections.filter(section => plainText(section.markdown).length >= minChars)
}

/** The last resort when no writer passes: the section's own words, read as they stand. */
export function rawNarration(sections: readonly Section[]): Narrated[] {
  return sections.map(section => {
    const script = plainText(section.markdown)

    return { id: section.id, narrate: script !== '', script, chunks: chunkScript(script) }
  })
}
