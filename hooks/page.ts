import type { AskedQuestion, Section } from '../types'

// The question dialog's offer, and the checks a built page must pass before
// it is narrated and published.

export const OFFER_LABEL = 'Explain this first'
export const OFFER_DESCRIPTION = 'Build an explainer page for this question before you answer.'
/** The header lucid's own dialogs carry, so its hooks leave them alone. */
export const OWN_HEADER = 'lucid'
export const MAX_OPTIONS = 4

const SCRIPT_HOSTS = [
  'https://cdnjs.cloudflare.com/',
  'https://cdn.jsdelivr.net/npm/',
  'https://unpkg.com/',
  'https://cdn.tailwindcss.com',
  'https://code.jquery.com/',
]
const STYLE_HOSTS = ['https://fonts.googleapis.com/']

export type PageCheck =
  | { isValid: true; title: string; sections: Section[] }
  | { isValid: false; problems: string[] }

export const isOwnDialog = (questions: readonly { header?: string }[]): boolean =>
  questions.length > 0 && questions.every(question => question.header === OWN_HEADER)

/**
 * The questions with the offer added as a last option wherever the dialog
 * has room for one: single-choice questions with fewer than four options.
 */
export function addOffer<Q extends { options: readonly { label: string }[]; multiSelect: boolean }>(
  questions: readonly Q[],
): { questions: Q[]; isOffered: boolean } {
  let isOffered = false

  const offered = questions.map(question => {
    const hasRoom = !question.multiSelect && question.options.length < MAX_OPTIONS
    const hasIt = question.options.some(option => option.label === OFFER_LABEL)
    if (!hasRoom || hasIt) return question

    isOffered = true

    return { ...question, options: [...question.options, { label: OFFER_LABEL, description: OFFER_DESCRIPTION }] }
  })

  return { questions: offered, isOffered }
}

export function wantsExplainer(answers: unknown): boolean {
  if (typeof answers !== 'object' || answers === null) return false

  return Object.values(answers).some(answer => typeof answer === 'string' && answer.split(',').some(part => part.trim() === OFFER_LABEL))
}

/** The question as one block of text: what the classifier and the builder read. */
export function describeQuestions(questions: readonly AskedQuestion[]): string {
  return questions
    .map(question => {
      const options = question.options
        .filter(option => option.label !== OFFER_LABEL)
        .map(option => `- ${option.label}${option.description ? `: ${option.description}` : ''}`)

      return [`Question (${question.header}): ${question.question}`, ...options].join('\n')
    })
    .join('\n\n')
}

const attributes = (html: string, tag: string, name: string): string[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\s${name}\\s*=\\s*["']([^"']+)["']`, 'gi'))].flatMap(match => match[1] ?? [])

const isPinned = (url: string): boolean => /[@/]\d+\.\d+(\.\d+)?([/.-]|$)/.test(url)

/**
 * Checks a built page against the Artifact page contract and against its own
 * sections file. A page that fails goes back for one more build, a rung up.
 */
export function checkPage(html: string, sectionsJson: string): PageCheck {
  const problems: string[] = []

  const title = /<title>([^<]*)<\/title>/i.exec(html.slice(0, 8192))?.[1]?.trim() ?? ''
  const words = title.split(/\s+/).filter(Boolean).length
  if (title === '') problems.push('the page has no <title> in its first 8 KB')
  else if (words < 2 || words > 4 || /[:—-]\s/.test(title)) problems.push(`the title "${title}" is not a plain name of two to four words`)

  // Only what runs is judged: an explainer about code may print `fetch(` in a <pre>.
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1] ?? '').join('\n')

  if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html)) problems.push('the page wraps itself in doctype, html, head or body tags')
  if (/\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(|sendBeacon/.test(scripts)) problems.push('the page makes a network call from script')
  if (/<(iframe|object|embed)\b/i.test(html)) problems.push('the page embeds another document')
  if (/<audio\b/i.test(html) || /new Audio\(|speechSynthesis/.test(scripts)) problems.push('the page has audio code of its own; lucid adds the players')
  if (!/prefers-color-scheme/.test(html) || !/data-theme/.test(html)) problems.push('the page does not style both themes')

  for (const src of attributes(html, 'script', 'src')) {
    if (!SCRIPT_HOSTS.some(host => src.startsWith(host))) problems.push(`script from a host the page may not load: ${src}`)
    else if (!isPinned(src)) problems.push(`script without an exact version: ${src}`)
  }

  for (const href of attributes(html, 'link', 'href')) {
    if (/^https?:/i.test(href) && !STYLE_HOSTS.some(host => href.startsWith(host))) problems.push(`stylesheet or link tag from a blocked host: ${href}`)
  }

  for (const src of [...attributes(html, 'img', 'src'), ...attributes(html, 'video', 'src'), ...attributes(html, 'source', 'src')]) {
    if (/^https?:/i.test(src)) problems.push(`media from another host: ${src}`)
  }

  let sections: Section[] = []
  try {
    const raw = JSON.parse(sectionsJson) as { sections?: unknown }
    const rows = Array.isArray(raw.sections) ? raw.sections : []
    sections = rows.flatMap(row => {
      const one = row as Partial<Section>

      return typeof one.id === 'string' && typeof one.heading === 'string' && typeof one.markdown === 'string'
        ? [{ id: one.id, heading: one.heading, markdown: one.markdown }]
        : []
    })
    if (sections.length === 0) problems.push('sections.json lists no section with id, heading and markdown')
    if (sections.length !== rows.length) problems.push('sections.json has a section missing id, heading or markdown')
  } catch {
    problems.push('sections.json is not JSON')
  }

  const marked = new Set(attributes(html, '[a-z0-9]+', 'data-lucid-section'))
  const seen = new Set<string>()
  for (const section of sections) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(section.id)) problems.push(`section id "${section.id}" is not kebab-case`)
    if (seen.has(section.id)) problems.push(`section id "${section.id}" is used twice`)
    if (!marked.has(section.id)) problems.push(`the page has no element with data-lucid-section="${section.id}"`)
    seen.add(section.id)
  }

  return problems.length > 0 ? { isValid: false, problems } : { isValid: true, title, sections }
}
