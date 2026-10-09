import type { AskedQuestion, Section } from '../types'

// The question dialog's offer, and the checks the opt-in HTML page must pass
// before lucid embeds narration in it.

export const OFFER_LABEL = 'Explain this first'
export const OFFER_DESCRIPTION = 'Build an explainer for this question, shown here in the terminal, before you answer.'
/** The header lucid's own dialogs carry, so its hooks leave them alone. */
export const OWN_HEADER = 'lucid'
export const MAX_OPTIONS = 4

const SCRIPT_HOSTS = [
  'https://cdnjs.cloudflare.com/',
  'https://cdn.jsdelivr.net/npm/',
  'https://unpkg.com/',
  'https://cdn.tailwindcss.com/',
  'https://code.jquery.com/',
]
const STYLE_HOST = /^https:\/\/fonts\.(?:googleapis|gstatic)\.com(?:[/?#]|$)/i
const PAGE_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${SCRIPT_HOSTS.join(' ')}`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export const withPolicy = (html: string): string => `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">\n${html}`

export type PageCheck = { isValid: true; title: string } | { isValid: false; problems: string[] }

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
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\s${name}\\s*=\\s*(?:["']([^"']+)["']|([^\\s>"']+))`, 'gi'))].flatMap(match => match[1] ?? match[2] ?? [])

const isRemote = (url: string): boolean => /^(https?:)?\/\//i.test(url)

const isPinned = (url: string): boolean =>
  /[@/]\d+\.\d+\.\d+([/.-]|$)/.test(url) || (url.startsWith('https://code.jquery.com/') && /-\d+\.\d+\.\d+([/.-]|$)/.test(url))

/**
 * Checks a built page against the Artifact page contract and against the
 * explainer it was built from. A page that fails goes back for one more
 * build, a rung up.
 */
export function checkPage(html: string, sections: readonly Section[]): PageCheck {
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
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html)) problems.push('the page redirects itself with a meta refresh')
  if (/<audio\b/i.test(html) || /new Audio\(|speechSynthesis/.test(scripts)) problems.push('the page has audio code of its own; lucid adds the players')
  if (!/prefers-color-scheme/.test(html) || !/data-theme/.test(html)) problems.push('the page does not style both themes')

  for (const src of attributes(html, 'script', 'src')) {
    if (!SCRIPT_HOSTS.some(host => src.startsWith(host))) problems.push(`script from a host the page may not load: ${src}`)
    else if (!isPinned(src)) problems.push(`script without an exact version: ${src}`)
  }

  for (const href of attributes(html, 'link', 'href')) {
    if (isRemote(href) && !STYLE_HOST.test(href)) problems.push(`stylesheet or link tag from a blocked host: ${href}`)
  }

  for (const src of [...attributes(html, 'img', 'src'), ...attributes(html, 'video', 'src'), ...attributes(html, 'source', 'src')]) {
    if (isRemote(src)) problems.push(`media from another host: ${src}`)
  }

  const marked = new Set(attributes(html, '[a-z0-9]+', 'data-lucid-section'))
  for (const section of sections) {
    if (!marked.has(section.id)) problems.push(`the page has no element with data-lucid-section="${section.id}"`)
  }

  return problems.length > 0 ? { isValid: false, problems } : { isValid: true, title }
}
