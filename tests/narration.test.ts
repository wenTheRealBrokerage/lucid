import { describe, expect, test } from 'claude-code/testing'

import { CHUNK_LIMIT, checkNarration, chunkScript, extractJson, longSections, namesIn, numbersIn, rawNarration } from '../hooks/narration'
import { NARRATION_FIXTURES } from '../hooks/prompts'

const SECTIONS = [
  { id: 'split', heading: 'The split', markdown: 'Ticket RV2-81342 moves the split from 85% to 80% for 1,204 agents managed by Priya Raman.' },
  { id: 'note', heading: 'A note', markdown: 'Short.' },
]
const GOOD = 'Ticket R V 2 dash 8 1 3 4 2 moves the split from 85% to 80% for 1,204 agents managed by Priya Raman.'

describe('narration JSON repair', () => {
  test('clean JSON passes with nothing repaired', async () => {
    const reply = JSON.stringify({ sections: [{ id: 'split', narrate: true, script: GOOD }, { id: 'note', narrate: false, script: '' }] })
    const check = checkNarration(reply, SECTIONS)
    expect(check.isValid).toBe(true)
    expect(check.repairs).toEqual([])
    expect(check.isValid && check.sections.map(one => one.narrate)).toEqual([true, false])
  })

  test('JSON inside prose and a code fence is taken out', async () => {
    const reply = `Here you go:\n\`\`\`json\n{"sections":[{"id":"split","narrate":true,"script":"${GOOD}"}]}\n\`\`\`\nHope that helps.`
    const check = checkNarration(reply, SECTIONS)
    expect(check.isValid).toBe(true)
    expect(check.repairs).toContain('took the JSON out of surrounding text')
    expect(check.repairs).toContain('added "note" as not narrated')
  })

  test('trailing commas, a bare list and string flags are repaired', async () => {
    const reply = `[{"id":"split","narrate":"true","script":"${GOOD}",},{"id":"note","narrate":"no","script":"ignored",},]`
    const check = checkNarration(reply, SECTIONS)
    expect(check.isValid).toBe(true)
    expect(check.repairs).toContain('wrapped a bare list as "sections"')
    expect(check.isValid && check.sections.find(one => one.id === 'note')).toEqual({ id: 'note', narrate: false, script: '', chunks: [] })
  })

  test('unknown, repeated and id-less rows are dropped', async () => {
    const reply = JSON.stringify({
      sections: [{ id: 'split', narrate: true, script: GOOD }, { id: 'split', narrate: true, script: 'again' }, { id: 'ghost', narrate: true, script: 'x' }, { narrate: true }],
    })
    const check = checkNarration(reply, SECTIONS)
    expect(check.isValid).toBe(true)
    expect(check.repairs).toEqual(['dropped a second "split"', 'dropped unknown section "ghost"', 'dropped a row with no id', 'added "note" as not narrated'])
  })

  test('a narrated row with an empty script is not narrated', async () => {
    const check = checkNarration('{"sections":[{"id":"split","narrate":true,"script":"  "}]}', SECTIONS)
    expect(check.isValid && check.sections[0]?.narrate).toBe(false)
  })

  test('a reply with no JSON, or no sections, fails', async () => {
    expect(checkNarration('I cannot do that.', SECTIONS)).toEqual({ isValid: false, problems: ['the reply holds no JSON'], repairs: [] })
    expect(checkNarration('{"scripts":[]}', SECTIONS).isValid).toBe(false)
  })

  test('a script that rewrites a number fails, naming it', async () => {
    const reply = JSON.stringify({ sections: [{ id: 'split', narrate: true, script: GOOD.replace('1,204', 'twelve hundred and four').replace('85%', '85 percent') }] })
    // "85 percent" still carries the figure 85; "twelve hundred and four" does not carry 1,204
    const check = checkNarration(reply, SECTIONS)
    expect(check.isValid).toBe(false)
    expect(!check.isValid && check.problems).toEqual(['"split" drops or rewrites 1,204'])
  })

  test('a dropped name fails only the strict check', async () => {
    const reply = JSON.stringify({ sections: [{ id: 'split', narrate: true, script: GOOD.replace('Priya Raman', 'their manager') }] })
    expect(checkNarration(reply, SECTIONS).isValid).toBe(true)
    const strict = checkNarration(reply, SECTIONS, true)
    expect(!strict.isValid && strict.problems).toEqual(['"split" drops the name Priya Raman'])
  })
})

describe('what counts as a number or a name', () => {
  test('standalone numbers count; digits inside ids, paths and dates do not', async () => {
    expect(numbersIn('RV2-81342 moves 85% to 80% for 1,204 agents, cap $12,000, by 2026-11-01 in v2.1 at /tmp/9/x, 3 of 10,000.')).toEqual([
      '85',
      '80',
      '1,204',
      '12,000',
      '3',
      '10,000',
    ])
  })

  test('the markers of a numbered list are not numbers to keep', async () => {
    const steps = [{ id: 'steps', heading: 'Steps', markdown: '1. Read version 7 of the row.\n2. Write it back.\n3) Retry up to 5 times.' }]
    const reply = JSON.stringify({ sections: [{ id: 'steps', narrate: true, script: 'First, read version 7 of the row. Then write it back. Last, retry up to 5 times.' }] })
    expect(checkNarration(reply, steps).isValid).toBe(true)
  })

  test('capitalised words inside a sentence are names', async () => {
    expect(namesIn('The job is run by Marcus Oyelaran on the Summit plan. Then it stops.')).toEqual(['Marcus Oyelaran', 'Summit'])
  })

  test('every fixture has numbers or names for a writer to keep, or is too short to narrate', async () => {
    const long = longSections(NARRATION_FIXTURES, 120)
    expect(long.map(section => section.id)).toEqual(['split-change', 'lock-choice'])
    for (const section of long) expect(numbersIn(section.markdown).length).toBeGreaterThan(2)
  })
})

describe('chunks for a speech engine', () => {
  test('a short script is one chunk', async () => {
    expect(chunkScript('One sentence. Two sentences.')).toEqual(['One sentence. Two sentences.'])
  })

  test('a long script is cut at sentence ends, every chunk within the limit, nothing lost', async () => {
    const sentence = 'The settlement job reads the row and writes it back only when the version still matches. '
    const script = sentence.repeat(120)
    const chunks = chunkScript(script)
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_LIMIT)
      expect(chunk.endsWith('matches.')).toBe(true)
    }
    expect(chunks.join(' ')).toBe(script.trim())
  })

  test('one sentence longer than the limit is cut at a space', async () => {
    const chunks = chunkScript('word '.repeat(2000))
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_LIMIT)
    expect(chunks.join(' ').split(' ').length).toBe(2000)
  })

  test('raw narration reads a section as written, without its markup', async () => {
    const raw = rawNarration([{ id: 'a', heading: 'A', markdown: '## A\n\nThe **split** is `x.y()` now 80%.\n\n```ts\ncode\n```' }])
    expect(raw[0]?.script).toBe('A The split is now 80%.')
    expect(raw[0]?.narrate).toBe(true)
  })

  test('extractJson gives undefined for text with no JSON', async () => {
    expect(extractJson('nothing here')).toBeUndefined()
    expect(extractJson('{"a": [1, 2,],}')).toEqual({ a: [1, 2] })
  })
})
