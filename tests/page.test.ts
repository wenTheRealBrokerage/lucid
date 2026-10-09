import { describe, expect, test } from 'claude-code/testing'

import { OFFER_LABEL, OWN_HEADER, addOffer, checkPage, describeQuestions, isOwnDialog, wantsExplainer, withPolicy } from '../hooks/page'
import type { Section } from '../types'

const question = (labels: string[], multiSelect = false) => ({
  question: 'Which lock should the ledger use?',
  header: 'Locking',
  multiSelect,
  options: labels.map(label => ({ label, description: `about ${label}` })),
})

const PAGE = [
  '<title>Ledger Lock Choice</title>',
  '<style>:root{--bg:#fff}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#111}}:root[data-theme="dark"]{--bg:#111}body{background:var(--bg)}</style>',
  '<section data-lucid-section="the-decision"><h2>The decision</h2><p>Text.</p><pre>fetch("/x")</pre></section>',
  '<section data-lucid-section="the-options"><h2>The options</h2><p>Text.</p></section>',
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>',
  '<script>document.title</script>',
].join('\n')

const SECTIONS: Section[] = [
  { id: 'the-decision', heading: 'The decision', markdown: 'Text.' },
  { id: 'the-options', heading: 'The options', markdown: 'Text.' },
]

describe('the offer in the question dialog', () => {
  test('a single-choice question with room gains the offer as its last option', async () => {
    const { questions, isOffered } = addOffer([question(['Optimistic', 'Pessimistic'])])
    expect(isOffered).toBe(true)
    expect(questions[0]?.options.map(option => option.label)).toEqual(['Optimistic', 'Pessimistic', OFFER_LABEL])
  })

  test('a full question, a multi-select one and one that has it already are left alone', async () => {
    const full = question(['A', 'B', 'C', 'D'])
    const many = question(['A', 'B'], true)
    const has = question(['A', OFFER_LABEL])
    const { questions, isOffered } = addOffer([full, many, has])
    expect(isOffered).toBe(false)
    expect(questions).toEqual([full, many, has])
  })

  test('only the offer itself, chosen, asks for an explainer', async () => {
    expect(wantsExplainer({ 'Which lock?': OFFER_LABEL })).toBe(true)
    expect(wantsExplainer({ 'Which lock?': `Optimistic, ${OFFER_LABEL}` })).toBe(true)
    expect(wantsExplainer({ 'Which lock?': 'Optimistic' })).toBe(false)
    expect(wantsExplainer({ 'Which lock?': 'please explain this first to me' })).toBe(false)
    expect(wantsExplainer(undefined)).toBe(false)
  })

  test("lucid's own dialogs are told by their header", async () => {
    expect(isOwnDialog([{ header: OWN_HEADER }])).toBe(true)
    expect(isOwnDialog([{ header: 'Locking' }])).toBe(false)
    expect(isOwnDialog([])).toBe(false)
  })

  test('a question is described without the offer', async () => {
    const { questions } = addOffer([question(['Optimistic', 'Pessimistic'])])
    expect(describeQuestions(questions)).toBe('Question (Locking): Which lock should the ledger use?\n- Optimistic: about Optimistic\n- Pessimistic: about Pessimistic')
  })
})

describe('checks on the opt-in page', () => {
  test('a page that follows the contract passes, code samples and all', async () => {
    expect(checkPage(PAGE, SECTIONS)).toEqual({ isValid: true, title: 'Ledger Lock Choice' })
  })

  const problemsOf = (html: string, sections: readonly Section[] = SECTIONS): string[] => {
    const check = checkPage(html, sections)

    return check.isValid ? [] : check.problems
  }

  test('a title that is missing, too long or carries an explanation fails', async () => {
    expect(problemsOf(PAGE.replace('<title>Ledger Lock Choice</title>', ''))).toEqual(['the page has no <title> in its first 8 KB'])
    expect(problemsOf(PAGE.replace('Ledger Lock Choice', 'Locks: how the ledger picks one'))[0]).toContain('not a plain name')
    expect(problemsOf(PAGE.replace('Ledger Lock Choice', 'Locks'))[0]).toContain('not a plain name')
  })

  test('blocked loads fail: a network call, an unlisted script host, an unpinned script, outside media', async () => {
    expect(problemsOf(PAGE.replace('document.title', 'fetch("/api")'))).toEqual(['the page makes a network call from script'])
    expect(problemsOf(PAGE.replace('https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js', 'https://esm.sh/d3'))[0]).toContain('may not load')
    expect(problemsOf(PAGE.replace('d3/7.9.0/', 'd3/latest/'))[0]).toContain('without an exact version')
    expect(problemsOf(`${PAGE}\n<img src="https://example.com/a.png">`)[0]).toContain('media from another host')
    expect(problemsOf(`${PAGE}\n<link rel="stylesheet" href="https://example.com/a.css">`)[0]).toContain('blocked host')
    expect(problemsOf(`${PAGE}\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">`)).toEqual([])
  })

  const D3 = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'
  const withScript = (src: string) => problemsOf(PAGE.replace(D3, src))

  test("the standard Google Fonts snippet passes, preconnect links and all; a host that only starts like Google's does not", async () => {
    const snippet = [
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">',
    ].join('\n')
    expect(problemsOf(`${PAGE}\n${snippet}`)).toEqual([])
    expect(problemsOf(`${PAGE}\n<link rel="preconnect" href="https://fonts.googleapis.com.evil.com">`)).toEqual(['stylesheet or link tag from a blocked host: https://fonts.googleapis.com.evil.com'])
    expect(problemsOf(`${PAGE}\n<link rel="stylesheet" href="https://fonts.gstatic.com.evil.example/a.css">`)[0]).toContain('blocked host')
    expect(problemsOf(`${PAGE}\n<link rel="icon" href="http://fonts.googleapis.com/x">`)[0]).toContain('blocked host')
  })

  test('a script is pinned by three version parts, with the hyphen form on code.jquery.com alone', async () => {
    expect(withScript('https://code.jquery.com/jquery-3.7.1.min.js')).toEqual([])
    expect(withScript('https://code.jquery.com/jquery-3.7.1.slim.min.js')).toEqual([])
    expect(withScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js')).toEqual([])
    expect(withScript('https://unpkg.com/lodash@4.17.21/lodash.min.js')).toEqual([])
    expect(withScript('https://cdn.tailwindcss.com/3.4.16')).toEqual([])
    expect(withScript('https://cdn.jsdelivr.net/npm/chart.js@4.4')[0]).toContain('without an exact version')
    expect(withScript('https://cdn.jsdelivr.net/npm/some-lib/dist/lib-1.2.3.min.js')[0]).toContain('without an exact version')
    expect(withScript('https://code.jquery.com/jquery-latest.min.js')[0]).toContain('without an exact version')
    expect(withScript('https://cdn.tailwindcss.com')[0]).toContain('may not load')
  })

  test('a host that only starts like an allowed one, an unquoted attribute and a scheme-relative url are judged as what they are', async () => {
    expect(withScript('https://cdn.tailwindcss.com.evil.example/3.4.16')[0]).toContain('may not load')
    expect(problemsOf(`${PAGE}\n<script src=https://evil.example/x.js></script>`)).toEqual(['script from a host the page may not load: https://evil.example/x.js'])
    expect(problemsOf(`${PAGE}\n<script src=//evil.example/1.2.3/x.js></script>`)[0]).toContain('may not load')
    expect(problemsOf(`${PAGE}\n<img src=https://example.com/a.png>`)).toEqual(['media from another host: https://example.com/a.png'])
    expect(problemsOf(`${PAGE}\n<img src="//example.com/a.png">`)).toEqual(['media from another host: //example.com/a.png'])
    expect(problemsOf(`${PAGE}\n<link rel=stylesheet href=//example.com/a.css>`)).toEqual(['stylesheet or link tag from a blocked host: //example.com/a.css'])
    expect(problemsOf(`${PAGE}\n<img src="data:image/png;base64,AAAA"><link rel="stylesheet" href="local.css">`)).toEqual([])
  })

  test('every other way out fails by name: a meta refresh, each embed, each kind of audio code, each kind of media, each theme half', async () => {
    expect(problemsOf(`${PAGE}\n<meta http-equiv="refresh" content="0;url=https://example.com/?q=1">`)).toEqual(['the page redirects itself with a meta refresh'])
    expect(problemsOf(`${PAGE}\n<meta http-equiv=refresh content="0;url=//example.com">`)).toEqual(['the page redirects itself with a meta refresh'])
    for (const tag of ['object', 'embed']) expect(problemsOf(`${PAGE}\n<${tag} data="x"></${tag}>`)).toEqual(['the page embeds another document'])
    for (const code of ['new Audio("x.mp3").play()', 'speechSynthesis.speak(u)']) expect(problemsOf(PAGE.replace('document.title', code))).toEqual(['the page has audio code of its own; lucid adds the players'])
    for (const call of ['new XMLHttpRequest()', 'new WebSocket("wss://x")', 'new EventSource("/x")', 'navigator.sendBeacon("/x")']) {
      expect(problemsOf(PAGE.replace('document.title', call))).toEqual(['the page makes a network call from script'])
    }
    for (const call of ['new RTCPeerConnection({ iceServers: [] })', 'link.rel = "dns-prefetch"']) {
      expect(problemsOf(PAGE.replace('document.title', call))).toEqual(['the page makes a network call from script'])
    }
    for (const leave of ['window.open("https://example.com/?" + data)', 'location.href = "https://example.com/?" + data', 'location = url', 'document.location="//example.com"', 'window.location.assign(url)', 'location.replace(url)']) {
      expect(problemsOf(PAGE.replace('document.title', leave))).toEqual(['the page sends the reader to another address from script'])
    }
    for (const stay of ['location.hash = "#the-options"', 'if (location == other || location.href === other) done()', 'const reopen = () => panel.open()']) {
      expect(problemsOf(PAGE.replace('document.title', stay))).toEqual([])
    }
    for (const tag of ['video', 'source']) expect(problemsOf(`${PAGE}\n<${tag} src="https://example.com/a.mp4">`)).toEqual(['media from another host: https://example.com/a.mp4'])
    expect(problemsOf(PAGE.replace(':root[data-theme="dark"]{--bg:#111}', '').replace(':not([data-theme="light"])', ''))).toEqual(['the page does not style both themes'])
    expect(problemsOf(PAGE.replace('@media (prefers-color-scheme: dark)', '@media (min-width: 1px)'))).toEqual(['the page does not style both themes'])
    for (const wrapper of ['<html lang="en">', '<head>', '<body class="x">']) expect(problemsOf(`${wrapper}\n${PAGE}`)).toEqual(['the page wraps itself in doctype, html, head or body tags'])
  })

  test('the policy lucid writes ahead of a page closes it to every host but the listed ones', async () => {
    const written = withPolicy(PAGE)
    const [first = '', second = ''] = written.split('\n')
    expect(written.slice(first.length + second.length + 2)).toBe(PAGE)
    expect(first.startsWith('<meta http-equiv="Content-Security-Policy" content="')).toBe(true)
    expect(second).toBe('<meta http-equiv="x-dns-prefetch-control" content="off">')
    for (const directive of [
      "default-src 'none'",
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com/ https://cdn.jsdelivr.net/npm/ https://unpkg.com/ https://cdn.tailwindcss.com/ https://code.jquery.com/",
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com data:',
      'img-src data: blob:',
      'media-src data: blob:',
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "webrtc 'block'",
    ]) {
      expect(first).toContain(directive)
    }
    expect(checkPage(written, SECTIONS)).toEqual({ isValid: true, title: 'Ledger Lock Choice' })
  })

  test('wrappers, embedded documents, audio code and a single theme fail', async () => {
    expect(problemsOf(`<!doctype html>\n${PAGE}`)[0]).toContain('wraps itself')
    expect(problemsOf(`${PAGE}\n<iframe src="x"></iframe>`)[0]).toContain('embeds another document')
    expect(problemsOf(`${PAGE}\n<audio src="x.mp3"></audio>`)[0]).toContain('audio code of its own')
    expect(problemsOf(PAGE.replace(':root[data-theme="dark"]{--bg:#111}', '').replace(':not([data-theme="light"])', ''))[0]).toContain('both themes')
  })

  test('a section the page does not carry fails', async () => {
    expect(problemsOf(PAGE, [...SECTIONS, { id: 'the-cost', heading: 'The cost', markdown: 'Text.' }])).toEqual(['the page has no element with data-lucid-section="the-cost"'])
  })
})
