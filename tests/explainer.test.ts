import { describe, expect, test } from 'claude-code/testing'

import { DIAGRAM_MAX_WIDTH, EXPLAINER_LIMIT_CHARS, STEPS_MAX, checkExplainer, narratedSections, nextNarrated, pickDiagram, sectionText } from '../hooks/explainer'
import { builderBrief, pageBrief } from '../hooks/prompts'
import type { Section } from '../types'

const DIAGRAM = {
  ascii: ['+--------+     +---------+', '| reader | --> | version |', '+--------+     +---------+'],
  unicode: ['┌────────┐     ┌─────────┐', '│ reader │ ──> │ version │', '└────────┘     └─────────┘'],
  maxWidth: 30,
}

const DOCUMENT = {
  title: 'Optimistic locking',
  sections: [
    { id: 'the-race', heading: 'The race', markdown: 'Two writers read the same row and the **last write wins**.', diagram: DIAGRAM, takeaway: 'Lost updates make no noise.' },
    { id: 'the-fix', heading: 'A version column', markdown: 'Add a `version` integer:\n\n```sql\nUPDATE account SET version = 8 WHERE version = 7;\n```', steps: ['read v7', 'work', 'write if still v7'], narrate: true },
    { id: 'the-table', heading: 'Side by side', markdown: '| Strategy | Blocks? |\n| --- | --- |\n| Optimistic | never |', narrate: false },
  ],
}

const text = (change: (document: typeof DOCUMENT) => unknown = document => document): string => JSON.stringify(change(structuredClone(DOCUMENT)))

const problemsOf = (json: string): string[] => {
  const check = checkExplainer(json)

  return check.isValid ? [] : check.problems
}

describe('checks on a built explainer', () => {
  test('a document that follows the rules passes with its optional fields kept', async () => {
    const check = checkExplainer(text())
    expect(check.isValid).toBe(true)
    if (!check.isValid) return
    expect(check.title).toBe('Optimistic locking')
    expect(check.sections.map(section => section.id)).toEqual(['the-race', 'the-fix', 'the-table'])
    expect(check.sections[0]?.diagram).toEqual(DIAGRAM)
    expect(check.sections[0]?.takeaway).toBe('Lost updates make no noise.')
    expect(check.sections[1]?.steps).toEqual(['read v7', 'work', 'write if still v7'])
    expect(check.sections[1]?.narrate).toBe(true)
    expect(check.sections[2]?.narrate).toBe(false)
  })

  test('not JSON, not an object, no title and no sections fail', async () => {
    expect(problemsOf('nope')).toEqual(['explainer.json is not JSON'])
    expect(problemsOf('[1]')).toEqual(['explainer.json is not a JSON object'])
    expect(problemsOf(text(document => ({ ...document, title: '' })))).toContain('explainer.json has no title')
    expect(problemsOf(text(document => ({ ...document, sections: [] })))).toEqual(['explainer.json lists no sections'])
  })

  test('section ids must be kebab-case and unique, and every section needs its three fields', async () => {
    expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[0], id: 'The Race' }] })))).toEqual(['section id "The Race" is not kebab-case'])
    expect(problemsOf(text(document => ({ ...document, sections: [document.sections[0], document.sections[0]] })))).toEqual(['section id "the-race" is used twice'])
    expect(problemsOf(text(document => ({ ...document, sections: [{ id: 'x' }] })))).toEqual(['section "x" is missing id, heading or markdown'])
  })

  test('raw HTML in markdown fails, but a tag inside code does not', async () => {
    expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'a <b>bold</b> word' }] })))).toEqual(['section "the-table" has raw HTML in its markdown'])
    expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'a `<b>` tag and\n\n```html\n<div>x</div>\n```' }] })))).toEqual([])
    expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'a List<String> of names' }] })))).toEqual([])
  })

  test('a diagram needs ascii lines in the allowed charset, no tabs, and every line within maxWidth', async () => {
    const withDiagram = (diagram: unknown) => text(document => ({ ...document, sections: [{ ...document.sections[2], diagram }] }))
    expect(problemsOf(withDiagram({ ascii: [], maxWidth: 20 }))).toEqual(['section "the-table": diagram.ascii must be a non-empty list of lines'])
    expect(problemsOf(withDiagram({ ascii: ['a\tb'], maxWidth: 20 }))).toEqual(['section "the-table": diagram.ascii line 1 has a tab'])
    expect(problemsOf(withDiagram({ ascii: ['┌──┐'], maxWidth: 20 }))[0]).toContain('outside +-|<>^v')
    expect(problemsOf(withDiagram({ ascii: ['+------+'], maxWidth: 4 }))).toEqual(['section "the-table": diagram.ascii line 1 is wider than maxWidth 4'])
    expect(problemsOf(withDiagram({ ascii: ['+--+'], maxWidth: DIAGRAM_MAX_WIDTH + 1 }))[0]).toContain(`from 1 to ${DIAGRAM_MAX_WIDTH}`)
    expect(problemsOf(withDiagram({ ascii: ['+--+'], unicode: ['┌\t┐'], maxWidth: 10 }))).toEqual(['section "the-table": diagram.unicode line 1 has a tab'])
    expect(problemsOf(withDiagram({ ascii: ['+--+'], unicode: ['┌──────────────┐'], maxWidth: 10 }))).toEqual(['section "the-table": diagram.unicode line 1 is wider than maxWidth 10'])
    expect(problemsOf(withDiagram({ ascii: ['+--+'], unicode: ['┌──┐'], maxWidth: 10 }))).toEqual([])
  })

  test('steps, narrate and takeaway are checked when present', async () => {
    const withField = (field: object) => text(document => ({ ...document, sections: [{ ...document.sections[2], ...field }] }))
    expect(problemsOf(withField({ steps: [] }))).toEqual(['section "the-table": steps must be a non-empty list of non-empty lines'])
    expect(problemsOf(withField({ steps: ['a', ' '] }))).toEqual(['section "the-table": steps must be a non-empty list of non-empty lines'])
    expect(problemsOf(withField({ steps: Array.from({ length: STEPS_MAX + 1 }, () => 'x') }))).toEqual([`section "the-table": more than ${STEPS_MAX} steps`])
    expect(problemsOf(withField({ narrate: 'yes' }))).toEqual(['section "the-table": narrate must be true or false'])
    expect(problemsOf(withField({ takeaway: '' }))).toEqual(['section "the-table": takeaway must be a sentence'])
    expect(problemsOf(withField({ takeaway: 'x'.repeat(300) }))[0]).toContain('takeaway is longer than')
  })

  test('control characters other than tab and newline fail, and so does a document over the size bound', async () => {
    expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'a\u0007b' }] })))).toEqual(['section "the-table" has a control character other than tab or newline'])
    expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'tab\there\nand a line' }] })))).toEqual([])
    const huge = text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'x'.repeat(EXPLAINER_LIMIT_CHARS) }] }))
    expect(problemsOf(huge)[0]).toContain(`the limit is ${EXPLAINER_LIMIT_CHARS}`)
  })
})

describe('what the pane reads from a document', () => {
  const sections: Section[] = [
    { id: 'a', heading: 'A', markdown: 'short', narrate: true },
    { id: 'b', heading: 'B', markdown: 'long', audio: '/tmp/b.m4a' },
    { id: 'c', heading: 'C', markdown: 'long', narrate: false },
    { id: 'd', heading: 'D', markdown: 'long', audio: '/tmp/d.m4a' },
  ]

  test('narrate overrides the length rule both ways', async () => {
    const long = sections.filter(section => section.markdown === 'long')
    expect(narratedSections(sections, long).map(section => section.id)).toEqual(['a', 'b', 'd'])
  })

  test('after a clip ends, the next section with a clip follows; none after the last', async () => {
    expect(nextNarrated(sections, 0)).toBe(1)
    expect(nextNarrated(sections, 1)).toBe(3)
    expect(nextNarrated(sections, 3)).toBeUndefined()
  })

  test('the box-drawing twin is drawn only where the terminal is known safe and it fits; a wide one is marked cut, never wrapped', async () => {
    expect(pickDiagram(DIAGRAM, { unicodeSafe: true, columns: 60 })).toEqual({ lines: DIAGRAM.unicode, isCut: false })
    expect(pickDiagram(DIAGRAM, { unicodeSafe: false, columns: 60 })).toEqual({ lines: DIAGRAM.ascii, isCut: false })
    expect(pickDiagram(DIAGRAM, { unicodeSafe: true, columns: 20 })).toEqual({ lines: DIAGRAM.ascii, isCut: true })
  })

  test('the transcript fallback prints one section whole', async () => {
    const check = checkExplainer(text())
    if (!check.isValid) throw new Error('fixture must pass')
    const printed = sectionText(check.title, check.sections, 1, false)
    expect(printed).toContain('Optimistic locking (2/3): A version column')
    expect(printed).toContain('1. read v7')
    const first = sectionText(check.title, check.sections, 0, true)
    expect(first).toContain('┌────────┐')
    expect(first).toContain('Takeaway: Lost updates make no noise.')
  })
})

describe('the briefs', () => {
  test('the terminal builder is asked for one explainer.json and never a page', async () => {
    const brief = builderBrief({ question: 'Which lock?', context: 'ctx', dir: '/work', problems: ['section id "X" is not kebab-case'] })
    expect(brief).toContain('/work/explainer.json')
    expect(brief).not.toContain('page.html')
    expect(brief).not.toContain('sections.json')
    expect(brief).toContain('- section id "X" is not kebab-case')
    expect(builderBrief({ question: 'q', context: 'c', dir: '/w' })).not.toContain('rejected')
  })

  test('the page builder is asked for page.html with the explainer inline, audio paths left out', async () => {
    const brief = pageBrief({ title: 'T', sections: [{ id: 'a', heading: 'A', markdown: 'm', audio: '/tmp/a.m4a' }], dir: '/work' })
    expect(brief).toContain('/work/page.html')
    expect(brief).toContain('data-lucid-section')
    expect(brief).not.toContain('/tmp/a.m4a')
  })
})
