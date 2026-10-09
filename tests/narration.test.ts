import { describe, expect, test } from 'claude-code/testing'

import { CHUNK_LIMIT, checkNarration, chunkScript, extractJson, keepPromised, longSections, namesIn, numbersIn, rawNarration, speechUrlProblem, withoutTables } from '../hooks/narration'
import { FIXTURES_TO_NARRATE, NARRATION_FIXTURES, narratorBrief } from '../hooks/prompts'

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
    expect(check.isValid).toBe(true)
    if (!check.isValid) return
    expect(check.sections[0]).toEqual({ id: 'split', narrate: false, script: '', chunks: [] })
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

  test('a figure counts as kept only where it stands as itself', async () => {
    const section = [{ id: 'odds', heading: 'Odds', markdown: 'It failed 3 times in 8 runs, about 1,204 ms each.' }]
    const reply = (script: string) => JSON.stringify({ sections: [{ id: 'odds', narrate: true, script }] })
    const dropped = checkNarration(reply('It failed 30 times in 80 runs, about 11,204 ms each, or 3.5 and 8,000.'), section)
    expect(!dropped.isValid && dropped.problems).toEqual(['"odds" drops or rewrites 3, 8, 1,204'])
    expect(checkNarration(reply('It failed 3 times in 8 runs, about 1,204 ms each.'), section).isValid).toBe(true)
    expect(checkNarration(reply('A 3-second wait, 8/80 of the runs, 1,204ms each (3).'), section).isValid).toBe(true)
  })

  test('numbers in a table and in a heading line need not be said; numbers in the prose still must', async () => {
    const section = [{ id: 'cost', heading: 'Cost', markdown: '## The 4 plans\n\nEach plan has 2 tiers.\n\n| Plan | Price |\n| --- | --- |\n| Basic | 19 |\n| Team | 49 |\n| Scale | 199 |' }]
    const reply = (script: string) => JSON.stringify({ sections: [{ id: 'cost', narrate: true, script }] })
    expect(checkNarration(reply('Each plan has 2 tiers. A table lists what each plan costs.'), section).isValid).toBe(true)
    const dropped = checkNarration(reply('Each plan has tiers. A table lists what each plan costs.'), section)
    expect(!dropped.isValid && dropped.problems).toEqual(['"cost" drops or rewrites 2'])
    expect(withoutTables(section[0]?.markdown ?? '')).toBe('## The 4 plans\n\nEach plan has 2 tiers.')
  })

  test('a reply that narrates nothing fails only where a section had to be narrated', async () => {
    const nothing = JSON.stringify({ sections: [{ id: 'split', narrate: false, script: '' }] })
    expect(checkNarration(nothing, SECTIONS).isValid).toBe(true)
    expect(checkNarration('{"sections":[]}', SECTIONS, true).isValid).toBe(true)
    const required = checkNarration('{"sections":[]}', SECTIONS, true, ['split'])
    expect(!required.isValid && required.problems).toEqual(['"split" was not narrated'])
    expect(checkNarration(nothing, SECTIONS, false, ['split']).isValid).toBe(false)
    const narrated = JSON.stringify({ sections: [{ id: 'split', narrate: true, script: GOOD }] })
    expect(checkNarration(narrated, SECTIONS, true, ['split']).isValid).toBe(true)
    expect(FIXTURES_TO_NARRATE).toEqual(longSections(NARRATION_FIXTURES, 120).map(section => section.id))
  })

  test('a section flagged narrate: true is narrated from its own words when the writer declines it', async () => {
    const sections = [
      { id: 'short', heading: 'Short', markdown: 'A **short** note worth hearing.', narrate: true },
      { id: 'long', heading: 'Long', markdown: 'A long section.' },
      { id: 'said', heading: 'Said', markdown: 'Another flagged one.', narrate: true },
    ]
    const declined = { narrate: false, script: '', chunks: [] }
    const said = { id: 'said', narrate: true, script: 'As the writer put it.', chunks: ['As the writer put it.'] }
    expect(keepPromised([{ id: 'short', ...declined }, { id: 'long', ...declined }, said], sections)).toEqual([
      { id: 'short', narrate: true, script: 'A short note worth hearing.', chunks: ['A short note worth hearing.'] },
      { id: 'long', ...declined },
      said,
    ])
    const brief = narratorBrief(sections)
    expect(brief.match(/"mustNarrate": true/g)).toHaveLength(2)
    expect(JSON.parse(brief.slice(brief.indexOf('{', brief.indexOf('\n\n')))).sections[1]).toEqual({ id: 'long', heading: 'Long', markdown: 'A long section.' })
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

describe('the hosted speech address', () => {
  test('https anywhere and http on this machine are taken', async () => {
    for (const url of ['https://api.example.com/v1/audio/speech', 'HTTPS://api.example.com', 'http://localhost:8880/v1/audio/speech', 'http://127.0.0.1/v1', 'http://[::1]:9000']) {
      expect(speechUrlProblem(url)).toBeUndefined()
    }
  })

  test('http elsewhere, another scheme, and a quote, backslash or space are refused', async () => {
    for (const url of ['http://api.example.com/v1', 'http://localhost.evil.example/v1', 'file:///etc/passwd', 'ftp://x', 'https://', '']) {
      expect(speechUrlProblem(url)).toBe('LUCID_TTS_URL must be an https address, or http on localhost')
    }
    for (const url of ['https://a.example/"\nheader = "X: 1', "https://a.example/'x", 'https://a.example/a\\b', 'https://a.example/a b', 'https://a.example/\tx']) {
      expect(speechUrlProblem(url)).toBe('LUCID_TTS_URL holds a quote, a backslash or a space')
    }
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
    const tabled = rawNarration([{ id: 'b', heading: 'B', markdown: 'Two plans.\n\n| Plan | Price |\n| --- | --- |\n| Basic | 19 |\n\nPick one.' }])
    expect(tabled[0]?.script).toBe('Two plans. Pick one.')
  })

  test('extractJson gives undefined for text with no JSON', async () => {
    expect(extractJson('nothing here')).toBeUndefined()
    expect(extractJson('{"a": [1, 2,],}')).toEqual({ a: [1, 2] })
  })
})
