import { describe, expect, test } from 'claude-code/testing'

import {
  CARD_INSET,
  DIAGRAM_MAX_WIDTH,
  EXPLAINER_LIMIT_CHARS,
  STEPS_MAX,
  checkExplainer,
  displayWidth,
  fitCells,
  isKeptJob,
  narratedSections,
  nextNarrated,
  pickDiagram,
  plainCell,
  sectionText,
  splitTables,
  tableWidths,
  widthOf,
} from '../hooks/explainer'
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
    expect(check.sections[0]?.diagram).toEqual({ ...DIAGRAM, maxWidth: 26 })
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
    const withMarkdown = (markdown: string) => problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown }] })))
    expect(withMarkdown('a <b>bold</b> word')).toEqual(['section "the-table" has raw HTML in its markdown: <b>'])
    expect(withMarkdown('a `<b>` tag and\n\n```html\n<div>x</div>\n```')).toEqual([])
    expect(withMarkdown('a List<String> of names')).toEqual([])
    expect(withMarkdown('H<sub>2</sub>O and x<sup>2</sup>')).toEqual(['section "the-table" has raw HTML in its markdown: <sub>'])
    expect(withMarkdown('an upper-case <TABLE> too')).toEqual(['section "the-table" has raw HTML in its markdown: <TABLE>'])
  })

  test('generics and component names that happen to spell a tag are not HTML, nor is a tag in any kind of code', async () => {
    const withMarkdown = (markdown: string) => problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown }] })))
    expect(withMarkdown('a List<Object>, a Component<P> and a Map<A, B>')).toEqual([])
    expect(withMarkdown('render a <Button> inside a <Table>')).toEqual([])
    expect(withMarkdown('fenced with tildes:\n\n~~~html\n<div>x</div>\n~~~\n\nand four backticks:\n\n````\n<p>y</p>\n````')).toEqual([])
    expect(withMarkdown('a span with two backticks: ``<b>`` and an unclosed fence:\n\n```\n<i>z</i>')).toEqual([])
  })

  test('a diagram needs ascii lines in printable ASCII, no tabs, and every line within the limit', async () => {
    const withDiagram = (diagram: unknown) => text(document => ({ ...document, sections: [{ ...document.sections[2], diagram }] }))
    expect(problemsOf(withDiagram({ ascii: [] }))).toEqual(['section "the-table": diagram.ascii must be a non-empty list of lines'])
    expect(problemsOf(withDiagram({ ascii: ['a\tb'] }))).toEqual(['section "the-table": diagram.ascii line 1 has a tab'])
    expect(problemsOf(withDiagram({ ascii: ['┌──┐'] }))).toEqual(['section "the-table": diagram.ascii line 1 has "┌" (U+250C); ascii takes printable ASCII only'])
    expect(problemsOf(withDiagram({ ascii: ['caf\u00e9 -> bar'] }))).toEqual(['section "the-table": diagram.ascii line 1 has "\u00e9" (U+00E9); ascii takes printable ASCII only'])
    expect(problemsOf(withDiagram({ ascii: ['-'.repeat(DIAGRAM_MAX_WIDTH + 1)] }))).toEqual([
      `section "the-table": diagram.ascii line 1 is ${DIAGRAM_MAX_WIDTH + 1} columns wide; the limit is ${DIAGRAM_MAX_WIDTH}`,
    ])
    expect(problemsOf(withDiagram({ ascii: ['-'.repeat(DIAGRAM_MAX_WIDTH)] }))).toEqual([])
    expect(problemsOf(withDiagram({ ascii: ['+--+'], unicode: ['┌\t┐'] }))).toEqual(['section "the-table": diagram.unicode line 1 has a tab'])
    expect(problemsOf(withDiagram({ ascii: ['+--+'], unicode: ['─'.repeat(DIAGRAM_MAX_WIDTH + 1)] }))).toEqual([
      `section "the-table": diagram.unicode line 1 is ${DIAGRAM_MAX_WIDTH + 1} columns wide; the limit is ${DIAGRAM_MAX_WIDTH}`,
    ])
    expect(problemsOf(withDiagram({ ascii: ['+--+'], unicode: ['┌──┐'] }))).toEqual([])
  })

  test('the box-drawing twin takes printable ASCII, box drawing and the four arrows, and nothing wider', async () => {
    const withTwin = (line: string) => problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], diagram: { ascii: ['+--+'], unicode: [line] } }] })))
    expect(withTwin('┌─┐ a ──> b ← ↑ → ↓ ┼')).toEqual([])
    expect(withTwin('┌\u{1f642}┐')).toEqual(['section "the-table": diagram.unicode line 1 has "\u{1f642}" (U+1F642); unicode takes printable ASCII, box drawing and the arrows ← ↑ → ↓ only'])
    expect(withTwin('a ▶ b')[0]).toContain('(U+25B6)')
    expect(withTwin('日本')[0]).toContain('(U+65E5)')
    expect(withTwin('a\u0007b')[0]).toContain('(U+0007)')
  })

  test('the limit is the measured body less the card inset', async () => {
    expect(CARD_INSET).toBe(6)
    expect(DIAGRAM_MAX_WIDTH).toBe(57)
    const widest = { ascii: ['-'.repeat(DIAGRAM_MAX_WIDTH)], maxWidth: DIAGRAM_MAX_WIDTH }
    expect(pickDiagram(widest, { unicodeSafe: false, columns: 63 - CARD_INSET }).isCut).toBe(false)
    expect(pickDiagram({ ascii: ['-'.repeat(58)], maxWidth: 58 }, { unicodeSafe: false, columns: 63 - CARD_INSET }).isCut).toBe(true)
  })

  test('a diagram is judged against the limit, not against a width the builder declares, and keeps the width measured', async () => {
    const withDiagram = (diagram: unknown) => checkExplainer(text(document => ({ ...document, sections: [{ ...document.sections[2], diagram }] })))
    for (const maxWidth of [4, DIAGRAM_MAX_WIDTH + 1, 'wide', undefined]) {
      const check = withDiagram({ ascii: ['+------+'], unicode: ['┌────────┐'], maxWidth })
      expect(check.isValid).toBe(true)
      if (!check.isValid) return
      expect(check.sections[0]?.diagram?.maxWidth).toBe(10)
    }
  })

  test('an optional field written as null is read as left out', async () => {
    const check = checkExplainer(text(document => ({ ...document, sections: [{ ...document.sections[2], diagram: null, steps: null, narrate: null, takeaway: null }] })))
    expect(check.isValid).toBe(true)
    if (!check.isValid) return
    expect(check.sections[0]).toEqual({ id: 'the-table', heading: 'Side by side', markdown: DOCUMENT.sections[2]?.markdown })
    const twin = checkExplainer(text(document => ({ ...document, sections: [{ ...document.sections[2], narrate: undefined, diagram: { ascii: ['+--+'], unicode: null } }] })))
    expect(twin.isValid && twin.sections[0]?.diagram).toEqual({ ascii: ['+--+'], maxWidth: 4 })
  })

  test('steps, narrate and takeaway are checked when present', async () => {
    const withField = (field: object) => text(document => ({ ...document, sections: [{ ...document.sections[2], ...field }] }))
    expect(problemsOf(withField({ steps: [] }))).toEqual(['section "the-table": steps must be a non-empty list of non-empty lines'])
    expect(problemsOf(withField({ steps: ['a', ' '] }))).toEqual(['section "the-table": steps must be a non-empty list of non-empty lines'])
    expect(problemsOf(withField({ steps: Array.from({ length: STEPS_MAX + 1 }, () => 'x') }))).toEqual([`section "the-table": more than ${STEPS_MAX} steps`])
    expect(problemsOf(withField({ narrate: 'yes' }))).toEqual(['section "the-table": narrate must be true or false'])
    expect(problemsOf(withField({ takeaway: '' }))).toEqual(['section "the-table": takeaway must be a sentence'])
    expect(problemsOf(withField({ takeaway: 'x'.repeat(300) }))[0]).toContain('takeaway is longer than')
    expect(problemsOf(withField({ takeaway: 'a\u0008b' }))).toEqual(['section "the-table": takeaway has a control character other than tab or newline'])
    expect(problemsOf(withField({ takeaway: 'a tab\tand a\nline break' }))).toEqual([])
  })

  test('control characters other than tab and newline fail, and so does a document over the size bound', async () => {
    expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'a\u0007b' }] })))).toEqual(['section "the-table" has a control character other than tab or newline'])
    expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'tab\there\nand a line' }] })))).toEqual([])
    for (const c1 of ['\u007f', '\u0085', '\u009b', '\u009f']) {
      expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: `a${c1}b` }] })))).toEqual(['section "the-table" has a control character other than tab or newline'])
      expect(problemsOf(text(document => ({ ...document, title: `a${c1}b` })))).toEqual(['the title has a line break or a control character'])
    }
    expect(problemsOf(text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'a\u00a0b' }] })))).toEqual([])
    const huge = text(document => ({ ...document, sections: [{ ...document.sections[2], markdown: 'x'.repeat(EXPLAINER_LIMIT_CHARS) }] }))
    expect(problemsOf(huge)[0]).toContain(`the limit is ${EXPLAINER_LIMIT_CHARS}`)
  })
})

describe('widths in terminal cells', () => {
  test('CJK and emoji take two cells, combining marks and joiners none, box drawing and the rest one', async () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('日本語')).toBe(6)
    expect(displayWidth('한글 ｆｕｌｌ')).toBe(13)
    expect(displayWidth('\u{1f44d}')).toBe(2)
    expect(displayWidth('✅ ok')).toBe(5)
    expect(displayWidth('☀\ufe0f')).toBe(2)
    expect(displayWidth('e\u0301')).toBe(1)
    expect(displayWidth('a\u200db')).toBe(2)
    expect(displayWidth('┌─┐│▸●◉━✓→')).toBe(10)
  })

  test('a text is cut to a number of cells with an ellipsis, never past it', async () => {
    expect(fitCells('hello', 10)).toBe('hello')
    expect(fitCells('hello world', 8)).toBe('hello w…')
    expect(fitCells('日本語の本', 6)).toBe('日本…')
    expect(fitCells('abc', 1)).toBe('…')
    expect(fitCells('abc', 0)).toBe('')
    for (const columns of [1, 2, 3, 7, 12]) expect(displayWidth(fitCells('日本語 and more text', columns))).toBeLessThanOrEqual(columns)
  })

  test('a diagram and a table are measured in cells', async () => {
    expect(widthOf(['ab', '日本語'])).toBe(6)
    expect(tableWidths({ kind: 'table', header: ['名前', '値'], rows: [['日本語', '1']], raw: [] }, 60, 2)).toEqual([6, 2])
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

  test('a kept job is a finished job with its fields and sections; anything else read from job.json is not', async () => {
    const job = { id: 'j1', origin: 'command', question: 'q', stage: 'done', note: 'n', dir: '/d', startedAt: 0, sections: [{ id: 'a', heading: 'A', markdown: 'm' }] }
    expect(isKeptJob(job)).toBe(true)
    expect(isKeptJob({ ...job, sections: [] })).toBe(true)
    expect(isKeptJob({ hello: 1 })).toBe(false)
    expect(isKeptJob(null)).toBe(false)
    expect(isKeptJob([job])).toBe(false)
    expect(isKeptJob({ ...job, stage: undefined })).toBe(false)
    expect(isKeptJob({ ...job, stage: 'building' })).toBe(false)
    expect(isKeptJob({ ...job, origin: 'elsewhere' })).toBe(false)
    expect(isKeptJob({ ...job, sections: 'none' })).toBe(false)
    expect(isKeptJob({ ...job, sections: [{ id: 'a' }] })).toBe(false)
    expect(isKeptJob({ ...job, startedAt: '0' })).toBe(false)
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

  test('pipe tables are lifted out of the markdown in order, fences left alone, and sized to the pane', async () => {
    const markdown = 'Intro.\n\n| Option | Meaning |\n| --- | --- |\n| **Approve** | diff `fixes` it |\n| Request changes | a \\| in a cell |\n\nAfter.\n\n```text\n| not | a table |\n| --- | --- |\n```'
    const blocks = splitTables(markdown)
    expect(blocks.map(block => block.kind)).toEqual(['markdown', 'table', 'markdown'])
    const table = blocks[1]
    if (table?.kind !== 'table') throw new Error('expected a table')
    expect(table.header).toEqual(['Option', 'Meaning'])
    expect(table.rows).toEqual([['**Approve**', 'diff `fixes` it'], ['Request changes', 'a | in a cell']])
    expect(table.raw).toEqual(['| Option | Meaning |', '| --- | --- |', '| **Approve** | diff `fixes` it |', '| Request changes | a \\| in a cell |'])
    expect(plainCell('**Approve** `x`')).toBe('Approve x')
    expect(tableWidths(table, 60, 2)).toEqual([15, 13])
    expect(tableWidths(table, 20, 2)).toEqual([9, 9])
    expect(tableWidths(table, 7, 2)).toBeUndefined()
    expect(blocks[2]?.kind === 'markdown' && blocks[2].text).toContain('| not | a table |')
  })

  test('a cell keeps asterisks that are not emphasis, and a code span as written', async () => {
    expect(plainCell('`*args` and `**kwargs`')).toBe('*args and **kwargs')
    expect(plainCell('`*.ts` and `*.tsx`')).toBe('*.ts and *.tsx')
    expect(plainCell('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(plainCell('2*3*4')).toBe('2*3*4')
    expect(plainCell('a \\* b \\* c')).toBe('a * b * c')
    expect(plainCell('**bold** and *it* and `**code**`')).toBe('bold and it and **code**')
    expect(plainCell('*one* then *two*')).toBe('one then two')
  })

  test('many narrow columns fit when their own widths fit, whatever three cells each would take', async () => {
    const header = Array.from({ length: 13 }, (_, at) => `c${at}`)
    const narrow = { kind: 'table' as const, header, rows: [], raw: [] }
    expect(tableWidths(narrow, 59, 2)).toEqual(header.map(cell => cell.length))
    expect(tableWidths(narrow, 49, 2)).toBeUndefined()
    const wide = { kind: 'table' as const, header: ['a', 'a long header cell'], rows: [], raw: [] }
    expect(tableWidths(wide, 8, 2)).toEqual([1, 5])
    expect(tableWidths(wide, 5, 2)).toBeUndefined()
  })

  test('a table inside a tilde fence or a longer backtick fence stays code', async () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(splitTables(`~~~\n${table}\n~~~`).map(block => block.kind)).toEqual(['markdown'])
    expect(splitTables('````\n```\n' + table + '\n```\n````').map(block => block.kind)).toEqual(['markdown'])
    expect(splitTables('```\n~~~\n' + table + '\n```').map(block => block.kind)).toEqual(['markdown'])
    expect(splitTables('```text\ncode\n```\n\n' + table).map(block => block.kind)).toEqual(['markdown', 'table'])
  })

  test('a header needs a separator with a pipe and as many cells; a trailing escaped pipe stays in its cell', async () => {
    expect(splitTables('| a line that starts with a pipe\n---\nthen a rule').map(block => block.kind)).toEqual(['markdown'])
    expect(splitTables('| a | b |\n| --- |\n| 1 | 2 |').map(block => block.kind)).toEqual(['markdown'])
    const [escaped] = splitTables('| a | b |\n| --- | --- |\n| x | y \\||')
    expect(escaped?.kind === 'table' && escaped.rows).toEqual([['x', 'y |']])
    const [bare] = splitTables('| a | b |\n| --- | --- |\n| x | y \\|')
    expect(bare?.kind === 'table' && bare.rows).toEqual([['x', 'y |']])
  })
})
