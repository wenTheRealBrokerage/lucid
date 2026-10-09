import { describe, expect, test } from 'claude-code/testing'

import { OFFER_LABEL, OWN_HEADER, addOffer, checkPage, describeQuestions, isOwnDialog, wantsExplainer } from '../hooks/page'

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

const SECTIONS = JSON.stringify({
  title: 'Ledger Lock Choice',
  sections: [
    { id: 'the-decision', heading: 'The decision', markdown: 'Text.' },
    { id: 'the-options', heading: 'The options', markdown: 'Text.' },
  ],
})

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

describe('checks on a built page', () => {
  test('a page that follows the contract passes, code samples and all', async () => {
    const check = checkPage(PAGE, SECTIONS)
    expect(check).toEqual({
      isValid: true,
      title: 'Ledger Lock Choice',
      sections: [
        { id: 'the-decision', heading: 'The decision', markdown: 'Text.' },
        { id: 'the-options', heading: 'The options', markdown: 'Text.' },
      ],
    })
  })

  const problemsOf = (html: string, sections = SECTIONS): string[] => {
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

  test('wrappers, embedded documents, audio code and a single theme fail', async () => {
    expect(problemsOf(`<!doctype html>\n${PAGE}`)[0]).toContain('wraps itself')
    expect(problemsOf(`${PAGE}\n<iframe src="x"></iframe>`)[0]).toContain('embeds another document')
    expect(problemsOf(`${PAGE}\n<audio src="x.mp3"></audio>`)[0]).toContain('audio code of its own')
    expect(problemsOf(PAGE.replace(':root[data-theme="dark"]{--bg:#111}', '').replace(':not([data-theme="light"])', ''))[0]).toContain('both themes')
  })

  test('sections that do not match the page fail', async () => {
    expect(problemsOf(PAGE, 'not json')).toEqual(['sections.json is not JSON'])
    expect(problemsOf(PAGE, '{"sections":[]}')).toEqual(['sections.json lists no section with id, heading and markdown'])
    expect(problemsOf(PAGE, SECTIONS.replace('the-options', 'The Options'))).toEqual([
      'section id "The Options" is not kebab-case',
      'the page has no element with data-lucid-section="The Options"',
    ])
    expect(problemsOf(PAGE, SECTIONS.replace('the-options', 'the-decision'))).toEqual(['section id "the-decision" is used twice'])
  })
})
