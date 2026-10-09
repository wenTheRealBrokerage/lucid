import type { Diagram, Section } from '../types'

// The terminal document: what a builder writes as explainer.json, the checks
// it must pass, and the pure helpers the pane reads it with.

/** Widest diagram line allowed: a docked pane at 80 columns has 63 body columns, less the card's frame. */
export const DIAGRAM_MAX_WIDTH = 60
/** The whole document, as JSON: well under the 100,000 characters one drawing holds. */
export const EXPLAINER_LIMIT_CHARS = 90_000
export const TITLE_MAX_CHARS = 80
export const TAKEAWAY_MAX_CHARS = 240
export const STEPS_MAX = 24

const ASCII_LINE = /^[A-Za-z0-9 +\-|<>^v.,:;()'"_=*#/\\[\]{}!?%&@~`$]*$/
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** Control characters other than tab and newline: the engine draws none of them (D:5709). */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/
const HTML_TAG =
  /<\/?(a|abbr|article|aside|audio|b|blockquote|br|button|canvas|code|details|div|em|embed|figure|footer|form|h[1-6]|header|hr|i|iframe|img|input|kbd|li|main|mark|nav|object|ol|p|pre|script|section|small|span|strong|style|sub|summary|sup|svg|table|tbody|td|th|thead|tr|u|ul|video)(\s[^<>]*)?\/?>/i

export type ExplainerCheck =
  | { isValid: true; title: string; sections: Section[] }
  | { isValid: false; problems: string[] }

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(one => typeof one === 'string')

/** The markdown with its code taken out: where an HTML tag would be drawn as a tag. */
const outsideCode = (markdown: string): string => markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

function checkDiagram(raw: unknown, where: string, problems: string[]): Diagram | undefined {
  if (typeof raw !== 'object' || raw === null) {
    problems.push(`${where}: diagram is not an object`)

    return undefined
  }

  const one = raw as Partial<Record<keyof Diagram, unknown>>
  const maxWidth = typeof one.maxWidth === 'number' && Number.isInteger(one.maxWidth) ? one.maxWidth : undefined
  if (maxWidth === undefined || maxWidth < 1 || maxWidth > DIAGRAM_MAX_WIDTH) {
    problems.push(`${where}: diagram.maxWidth must be a whole number from 1 to ${DIAGRAM_MAX_WIDTH}`)
  }

  if (!isStringList(one.ascii) || one.ascii.length === 0) {
    problems.push(`${where}: diagram.ascii must be a non-empty list of lines`)

    return undefined
  }

  for (const [row, line] of one.ascii.entries()) {
    if (line.includes('\t')) problems.push(`${where}: diagram.ascii line ${row + 1} has a tab`)
    else if (!ASCII_LINE.test(line)) problems.push(`${where}: diagram.ascii line ${row + 1} uses characters outside +-|<>^v, letters, digits and punctuation`)
    if (maxWidth !== undefined && line.length > maxWidth) problems.push(`${where}: diagram.ascii line ${row + 1} is wider than maxWidth ${maxWidth}`)
  }

  let unicode: string[] | undefined
  if (one.unicode !== undefined) {
    if (!isStringList(one.unicode) || one.unicode.length === 0) {
      problems.push(`${where}: diagram.unicode, when given, must be a non-empty list of lines`)
    } else {
      unicode = one.unicode
      for (const [row, line] of unicode.entries()) {
        if (line.includes('\t')) problems.push(`${where}: diagram.unicode line ${row + 1} has a tab`)
        if (CONTROL.test(line)) problems.push(`${where}: diagram.unicode line ${row + 1} has a control character`)
        if (maxWidth !== undefined && [...line].length > maxWidth) problems.push(`${where}: diagram.unicode line ${row + 1} is wider than maxWidth ${maxWidth}`)
      }
    }
  }

  return { ascii: one.ascii, maxWidth: maxWidth ?? DIAGRAM_MAX_WIDTH, ...(unicode === undefined ? {} : { unicode }) }
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
    if (HTML_TAG.test(outsideCode(one.markdown))) problems.push(`${where} has raw HTML in its markdown`)

    const section: Section = { id: one.id, heading: one.heading.trim(), markdown: one.markdown }

    if (one.diagram !== undefined) {
      const diagram = checkDiagram(one.diagram, where, problems)
      if (diagram !== undefined) section.diagram = diagram
    }

    if (one.steps !== undefined) {
      if (!isStringList(one.steps) || one.steps.length === 0 || one.steps.some(step => step.trim() === '')) {
        problems.push(`${where}: steps must be a non-empty list of non-empty lines`)
      } else if (one.steps.length > STEPS_MAX) {
        problems.push(`${where}: more than ${STEPS_MAX} steps`)
      } else {
        if (one.steps.some(step => CONTROL.test(step))) problems.push(`${where}: a step has a control character`)
        section.steps = one.steps
      }
    }

    if (one.narrate !== undefined) {
      if (typeof one.narrate !== 'boolean') problems.push(`${where}: narrate must be true or false`)
      else section.narrate = one.narrate
    }

    if (one.takeaway !== undefined) {
      if (typeof one.takeaway !== 'string' || one.takeaway.trim() === '') problems.push(`${where}: takeaway must be a sentence`)
      else if (one.takeaway.length > TAKEAWAY_MAX_CHARS) problems.push(`${where}: takeaway is longer than ${TAKEAWAY_MAX_CHARS} characters`)
      else section.takeaway = one.takeaway.trim()
    }

    sections.push(section)
  }

  return problems.length > 0 ? { isValid: false, problems } : { isValid: true, title, sections }
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
export const widthOf = (lines: readonly string[]): number => lines.reduce((widest, line) => Math.max(widest, [...line].length), 0)

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
export type TableBlock = { kind: 'table'; header: string[]; rows: string[][] }
export type MarkdownBlock = { kind: 'markdown'; text: string }

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'))

const isSeparator = (line: string): boolean => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)

/** Inline markdown reduced to its words: what a table cell is drawn as. */
export const plainCell = (cell: string): string => cell.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')

/**
 * The markdown split into prose blocks and the pipe tables between them,
 * in order. Everything that is not a table stays markdown as written.
 */
export function splitTables(markdown: string): (MarkdownBlock | TableBlock)[] {
  const lines = markdown.split('\n')
  const blocks: (MarkdownBlock | TableBlock)[] = []
  let prose: string[] = []
  let inFence = false

  const flush = () => {
    const text = prose.join('\n').trim()
    if (text !== '') blocks.push({ kind: 'markdown', text })
    prose = []
  }

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? ''
    if (line.trim().startsWith('```')) inFence = !inFence
    const next = lines[at + 1]
    if (!inFence && line.trim().startsWith('|') && next !== undefined && isSeparator(next)) {
      flush()
      const header = splitRow(line)
      const rows: string[][] = []
      at += 2
      while (at < lines.length && (lines[at] ?? '').trim().startsWith('|')) {
        rows.push(splitRow(lines[at] ?? ''))
        at += 1
      }
      at -= 1
      blocks.push({ kind: 'table', header, rows })
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
  const widths = table.header.map((cell, i) => Math.max([...plainCell(cell)].length, ...table.rows.map(row => [...plainCell(row[i] ?? '')].length), 1))
  const room = columns - gap * Math.max(0, count - 1)
  if (count === 0 || room < count * 3) return undefined

  while (widths.reduce((sum, w) => sum + w, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths))
    if ((widths[widest] ?? 0) <= 3) return undefined
    widths[widest] = (widths[widest] ?? 0) - 1
  }

  return widths
}
