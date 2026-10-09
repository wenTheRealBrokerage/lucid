import type { Diagram, Job, Section } from '../types'

// The terminal document: what a builder writes as explainer.json, the checks
// it must pass, and the pure helpers the pane reads it with.

export const CARD_INSET = 6
/** Widest diagram line allowed: the one body width measured so far (63 columns, in Warp at 80) less the section's padding and the card's border and padding. */
export const DIAGRAM_MAX_WIDTH = 63 - CARD_INSET
/** The whole document, as JSON: well under the 100,000 characters one drawing holds. */
export const EXPLAINER_LIMIT_CHARS = 90_000
export const TITLE_MAX_CHARS = 80
export const TAKEAWAY_MAX_CHARS = 240
export const STEPS_MAX = 24

const ASCII_LINE = /^[A-Za-z0-9 +\-|<>^v.,:;()'"_=*#/\\[\]{}!?%&@~`$]*$/
const UNICODE_LINE = /^[\u0020-\u007e\u2500-\u257f\u2190-\u2193]*$/

const WIDE_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  hangulJamo: [0x1100, 0x115f],
  cjkRadicalsToSymbols: [0x2e80, 0x303e],
  kanaToCjkCompatibility: [0x3041, 0x33ff],
  cjkExtensionA: [0x3400, 0x4dbf],
  cjkUnified: [0x4e00, 0x9fff],
  yi: [0xa000, 0xa4cf],
  hangulSyllables: [0xac00, 0xd7a3],
  cjkCompatibilityIdeographs: [0xf900, 0xfaff],
  cjkCompatibilityForms: [0xfe30, 0xfe4f],
  fullwidthForms: [0xff00, 0xff60],
  fullwidthSigns: [0xffe0, 0xffe6],
  emojiPictographs: [0x1f300, 0x1f64f],
  emojiTransport: [0x1f680, 0x1f6ff],
  emojiSupplemental: [0x1f900, 0x1f9ff],
  emojiExtended: [0x1fa70, 0x1faff],
  cjkExtensionBOnward: [0x20000, 0x3fffd],
}
const WIDE_SYMBOLS = new Set('⌚⌛⏩⏪⏫⏬⏰⏳◽◾☔☕♈♉♊♋♌♍♎♏♐♑♒♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓❔❕❗➕➖➗➰➿⬛⬜⭐⭕')
const ZERO_WIDTH_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  combiningDiacriticals: [0x0300, 0x036f],
  combiningExtended: [0x1ab0, 0x1aff],
  combiningSupplement: [0x1dc0, 0x1dff],
  zeroWidthSpaceToJoiner: [0x200b, 0x200d],
  combiningForSymbols: [0x20d0, 0x20ff],
  variationSelectors: [0xfe00, 0xfe0f],
  combiningHalfMarks: [0xfe20, 0xfe2f],
}
const EMOJI_PRESENTATION = '\ufe0f'

const isIn = (code: number, ranges: Readonly<Record<string, readonly [number, number]>>): boolean =>
  Object.values(ranges).some(([from, to]) => code >= from && code <= to)

export function displayWidth(text: string): number {
  const chars = [...text]

  return chars.reduce((width, char, at) => {
    const code = char.codePointAt(0) ?? 0
    if (isIn(code, ZERO_WIDTH_RANGES)) return width

    return width + (isIn(code, WIDE_RANGES) || WIDE_SYMBOLS.has(char) || chars[at + 1] === EMOJI_PRESENTATION ? 2 : 1)
  }, 0)
}

export function fitCells(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text
  if (columns < 1) return ''
  let kept = ''
  for (const char of text) {
    if (displayWidth(kept + char) > columns - 1) break
    kept += char
  }

  return `${kept}…`
}
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** Control characters other than tab and newline: the engine draws none of them (D:5709). */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
const HTML_TAG =
  /<\/?(a|abbr|article|aside|audio|b|blockquote|br|button|canvas|code|details|div|em|embed|figure|footer|form|h[1-6]|header|hr|i|iframe|img|input|kbd|li|main|mark|nav|object|ol|p|pre|script|section|small|span|strong|style|sub|summary|sup|svg|table|tbody|td|th|thead|tr|u|ul|video)(\s[^<>]*)?\/?>/i

export const printable = (text: string): string => text.replace(new RegExp(CONTROL.source, 'g'), ' ')

const codePoint = (char: string): string => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`

export type ExplainerCheck =
  | { isValid: true; title: string; sections: Section[] }
  | { isValid: false; problems: string[] }

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(one => typeof one === 'string')

/** The markdown with its code taken out: where an HTML tag would be drawn as a tag. */
const outsideCode = (markdown: string): string =>
  markdown
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n[ \t]*\2[^\n]*|$)/g, '$1')
    .replace(/(`{2,})[\s\S]*?\1/g, '')
    .replace(/`[^`\n]*`/g, '')

const rawTag = (markdown: string): string | undefined => {
  for (const match of outsideCode(markdown).matchAll(new RegExp(HTML_TAG.source, 'gi'))) {
    const name = match[1] ?? ''
    if (name === name.toLowerCase() || (name.length > 1 && name === name.toUpperCase())) return match[0]
  }

  return undefined
}

function checkDiagram(raw: unknown, where: string, problems: string[]): Diagram | undefined {
  if (typeof raw !== 'object' || raw === null) {
    problems.push(`${where}: diagram is not an object`)

    return undefined
  }

  const one = raw as Partial<Record<keyof Diagram, unknown>>

  if (!isStringList(one.ascii) || one.ascii.length === 0) {
    problems.push(`${where}: diagram.ascii must be a non-empty list of lines`)

    return undefined
  }

  for (const [row, line] of one.ascii.entries()) {
    const odd = [...line].find(char => !ASCII_LINE.test(char))
    if (line.includes('\t')) problems.push(`${where}: diagram.ascii line ${row + 1} has a tab`)
    else if (odd !== undefined) problems.push(`${where}: diagram.ascii line ${row + 1} has "${printable(odd)}" (${codePoint(odd)}); ascii takes printable ASCII only`)
    if (line.length > DIAGRAM_MAX_WIDTH) problems.push(`${where}: diagram.ascii line ${row + 1} is ${line.length} columns wide; the limit is ${DIAGRAM_MAX_WIDTH}`)
  }

  let unicode: string[] | undefined
  if (one.unicode != null) {
    if (!isStringList(one.unicode) || one.unicode.length === 0) {
      problems.push(`${where}: diagram.unicode, when given, must be a non-empty list of lines`)
    } else {
      unicode = one.unicode
      for (const [row, line] of unicode.entries()) {
        const odd = [...line].find(char => !UNICODE_LINE.test(char))
        if (line.includes('\t')) problems.push(`${where}: diagram.unicode line ${row + 1} has a tab`)
        else if (odd !== undefined) {
          problems.push(`${where}: diagram.unicode line ${row + 1} has "${printable(odd)}" (${codePoint(odd)}); unicode takes printable ASCII, box drawing and the arrows ← ↑ → ↓ only`)
        }
        if (displayWidth(line) > DIAGRAM_MAX_WIDTH) problems.push(`${where}: diagram.unicode line ${row + 1} is ${displayWidth(line)} columns wide; the limit is ${DIAGRAM_MAX_WIDTH}`)
      }
    }
  }

  return { ascii: one.ascii, maxWidth: widthOf([...one.ascii, ...(unicode ?? [])]), ...(unicode === undefined ? {} : { unicode }) }
}

/**
 * Checks a built explainer.json: shape, ids, markdown without raw HTML,
 * diagrams that fit, steps, narrate, and the size bound. A document that
 * fails goes back for one more build, a rung up.
 */
export function checkExplainer(text: string): ExplainerCheck {
  const problems: string[] = []

  if (text.length > EXPLAINER_LIMIT_CHARS) problems.push(`explainer.json is ${text.length} characters; the limit is ${EXPLAINER_LIMIT_CHARS}`)

  let raw: { title?: unknown; sections?: unknown }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { isValid: false, problems: [...problems, 'explainer.json is not a JSON object'] }
    raw = parsed as { title?: unknown; sections?: unknown }
  } catch {
    return { isValid: false, problems: [...problems, 'explainer.json is not JSON'] }
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (title === '') problems.push('explainer.json has no title')
  else if (title.length > TITLE_MAX_CHARS) problems.push(`the title is longer than ${TITLE_MAX_CHARS} characters`)
  else if (CONTROL.test(title) || title.includes('\n')) problems.push('the title has a line break or a control character')

  const rows = Array.isArray(raw.sections) ? raw.sections : undefined
  if (rows === undefined || rows.length === 0) return { isValid: false, problems: [...problems, 'explainer.json lists no sections'] }

  const sections: Section[] = []
  const seen = new Set<string>()

  for (const [index, row] of rows.entries()) {
    const one = (typeof row === 'object' && row !== null ? row : {}) as Partial<Record<keyof Section, unknown>>
    const where = typeof one.id === 'string' && one.id !== '' ? `section "${one.id}"` : `section ${index + 1}`

    if (typeof one.id !== 'string' || typeof one.heading !== 'string' || typeof one.markdown !== 'string') {
      problems.push(`${where} is missing id, heading or markdown`)
      continue
    }
    if (!KEBAB.test(one.id)) problems.push(`section id "${one.id}" is not kebab-case`)
    if (seen.has(one.id)) problems.push(`section id "${one.id}" is used twice`)
    seen.add(one.id)
    if (one.heading.trim() === '') problems.push(`${where} has an empty heading`)
    if (one.markdown.trim() === '') problems.push(`${where} has empty markdown`)
    if (CONTROL.test(one.markdown) || CONTROL.test(one.heading)) problems.push(`${where} has a control character other than tab or newline`)
    const tag = rawTag(one.markdown)
    if (tag !== undefined) problems.push(`${where} has raw HTML in its markdown: ${tag}`)

    const section: Section = { id: one.id, heading: one.heading.trim(), markdown: one.markdown }

    if (one.diagram != null) {
      const diagram = checkDiagram(one.diagram, where, problems)
      if (diagram !== undefined) section.diagram = diagram
    }

    if (one.steps != null) {
      if (!isStringList(one.steps) || one.steps.length === 0 || one.steps.some(step => step.trim() === '')) {
        problems.push(`${where}: steps must be a non-empty list of non-empty lines`)
      } else if (one.steps.length > STEPS_MAX) {
        problems.push(`${where}: more than ${STEPS_MAX} steps`)
      } else {
        if (one.steps.some(step => CONTROL.test(step))) problems.push(`${where}: a step has a control character`)
        section.steps = one.steps
      }
    }

    if (one.narrate != null) {
      if (typeof one.narrate !== 'boolean') problems.push(`${where}: narrate must be true or false`)
      else section.narrate = one.narrate
    }

    if (one.takeaway != null) {
      if (typeof one.takeaway !== 'string' || one.takeaway.trim() === '') problems.push(`${where}: takeaway must be a sentence`)
      else if (one.takeaway.length > TAKEAWAY_MAX_CHARS) problems.push(`${where}: takeaway is longer than ${TAKEAWAY_MAX_CHARS} characters`)
      else if (CONTROL.test(one.takeaway)) problems.push(`${where}: takeaway has a control character other than tab or newline`)
      else section.takeaway = one.takeaway.trim()
    }

    sections.push(section)
  }

  return problems.length > 0 ? { isValid: false, problems } : { isValid: true, title, sections }
}

const isSectionRow = (value: unknown): boolean => {
  const one = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof Section, unknown>>

  return typeof one.id === 'string' && typeof one.heading === 'string' && typeof one.markdown === 'string'
}

export function isKeptJob(value: unknown): value is Job {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const one = value as Partial<Record<keyof Job, unknown>>

  return (
    typeof one.id === 'string' &&
    (one.origin === 'option' || one.origin === 'button' || one.origin === 'command') &&
    typeof one.question === 'string' &&
    one.stage === 'done' &&
    typeof one.note === 'string' &&
    typeof one.dir === 'string' &&
    typeof one.startedAt === 'number' &&
    Array.isArray(one.sections) &&
    one.sections.every(isSectionRow)
  )
}

/** The sections to narrate: the long ones, with each section's own `narrate` as the override. */
export function narratedSections(sections: readonly Section[], long: readonly Section[]): Section[] {
  const longIds = new Set(long.map(section => section.id))

  return sections.filter(section => (section.narrate === undefined ? longIds.has(section.id) : section.narrate))
}

/** The index of the next section after `from` that has a clip, or undefined. */
export function nextNarrated(sections: readonly Section[], from: number): number | undefined {
  const at = sections.findIndex((section, index) => index > from && section.audio !== undefined)

  return at < 0 ? undefined : at
}

/** The widest line of a diagram, in cells. */
export const widthOf = (lines: readonly string[]): number => lines.reduce((widest, line) => Math.max(widest, displayWidth(line)), 0)

/**
 * The lines the pane draws for a diagram: the box-drawing twin where the
 * terminal is known to draw it and it fits, else the ASCII one.
 */
export function pickDiagram(diagram: Diagram, input: { unicodeSafe: boolean; columns: number }): { lines: string[]; isCut: boolean } {
  const lines = input.unicodeSafe && diagram.unicode !== undefined && widthOf(diagram.unicode) <= input.columns ? diagram.unicode : diagram.ascii

  return { lines, isCut: widthOf(lines) > input.columns }
}

/** One section as transcript text: the fallback when no pane can be placed. */
export function sectionText(title: string, sections: readonly Section[], index: number, unicodeSafe: boolean): string {
  const section = sections[index]
  if (section === undefined) return `${title}: no sections yet`
  const parts = [`${title} (${index + 1}/${sections.length}): ${section.heading}`, '', section.markdown]
  if (section.diagram !== undefined) parts.push('', '```text', ...pickDiagram(section.diagram, { unicodeSafe, columns: Number.MAX_SAFE_INTEGER }).lines, '```')
  if (section.steps !== undefined) parts.push('', ...section.steps.map((step, at) => `${at + 1}. ${step}`))
  if (section.takeaway !== undefined) parts.push('', `Takeaway: ${section.takeaway}`)

  return parts.join('\n')
}

/** A pipe table lifted out of the markdown, so the pane can draw it at full strength. */
export type TableBlock = { kind: 'table'; header: string[]; rows: string[][]; raw: string[] }
export type MarkdownBlock = { kind: 'markdown'; text: string }

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'))

const isSeparator = (line: string): boolean => line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)

const fenceOf = (line: string): { char: string; length: number; isBare: boolean } | undefined => {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line.trim())
  const run = match?.[1]

  return run === undefined ? undefined : { char: run.charAt(0), length: run.length, isBare: (match?.[2] ?? '').trim() === '' }
}

const ESCAPED_STAR = '\u0000'

const withoutEmphasis = (text: string): string =>
  text
    .replace(/\\\*/g, ESCAPED_STAR)
    .replace(/(?<![\w*])\*\*(?![\s*])(.+?)(?<![\s*])\*\*(?![\w*])/g, '$1')
    .replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, '$1')
    .replaceAll(ESCAPED_STAR, '*')

/** Inline markdown reduced to its words: what a table cell is drawn as. A code span's content is kept as written. */
export const plainCell = (cell: string): string =>
  cell
    .split(/`([^`]*)`/)
    .map((part, at) => (at % 2 === 1 ? part : withoutEmphasis(part)))
    .join('')

/**
 * The markdown split into prose blocks and the pipe tables between them,
 * in order. Everything that is not a table stays markdown as written.
 */
export function splitTables(markdown: string): (MarkdownBlock | TableBlock)[] {
  const lines = markdown.split('\n')
  const blocks: (MarkdownBlock | TableBlock)[] = []
  let prose: string[] = []
  let fence: { char: string; length: number } | undefined

  const flush = () => {
    const text = prose.join('\n').trim()
    if (text !== '') blocks.push({ kind: 'markdown', text })
    prose = []
  }

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? ''
    const mark = fenceOf(line)
    if (fence === undefined) fence = mark
    else if (mark !== undefined && mark.isBare && mark.char === fence.char && mark.length >= fence.length) fence = undefined
    const next = lines[at + 1]
    const header = splitRow(line)
    if (fence === undefined && line.trim().startsWith('|') && next !== undefined && isSeparator(next) && splitRow(next).length === header.length) {
      flush()
      const rows: string[][] = []
      const from = at
      at += 2
      while (at < lines.length && (lines[at] ?? '').trim().startsWith('|')) {
        rows.push(splitRow(lines[at] ?? ''))
        at += 1
      }
      blocks.push({ kind: 'table', header, rows, raw: lines.slice(from, at) })
      at -= 1
      continue
    }
    prose.push(line)
  }
  flush()

  return blocks
}

/** Column widths for a table drawn in `columns` cells with `gap` between columns, shrinking the widest columns first; undefined when it cannot fit. */
export function tableWidths(table: TableBlock, columns: number, gap: number): number[] | undefined {
  const count = table.header.length
  const widths = table.header.map((cell, i) => Math.max(displayWidth(plainCell(cell)), ...table.rows.map(row => displayWidth(plainCell(row[i] ?? ''))), 1))
  const room = columns - gap * Math.max(0, count - 1)
  if (count === 0 || room < widths.reduce((sum, w) => sum + Math.min(w, 3), 0)) return undefined

  while (widths.reduce((sum, w) => sum + w, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest] = (widths[widest] ?? 0) - 1
  }

  return widths
}
