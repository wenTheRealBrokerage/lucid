import { describe, expect, test } from 'claude-code/testing'

import { parseConfig } from '../hooks/roster'
import { escalate, parseComplexity, shiftStep, stepFor, tierAt } from '../hooks/routing'

import { CONFIG_TEXT } from './fixtures'

const config = parseConfig(CONFIG_TEXT)

describe('complexity to tier', () => {
  test('a reply naming one label is that label', async () => {
    expect(parseComplexity('simple')).toBe('simple')
    expect(parseComplexity('Complex.')).toBe('complex')
    expect(parseComplexity('I would rate this as moderate')).toBe('moderate')
  })

  test('an unparseable, ambiguous or missing reply is moderate', async () => {
    expect(parseComplexity(undefined)).toBe('moderate')
    expect(parseComplexity('')).toBe('moderate')
    expect(parseComplexity('I cannot help with that')).toBe('moderate')
    expect(parseComplexity('somewhere between simple and complex')).toBe('moderate')
    expect(parseComplexity('simplest')).toBe('moderate')
  })

  test('each label starts on its rung of the ladder', async () => {
    expect(tierAt(stepFor('simple', config), config)).toEqual({ role: 'balanced', effort: 'medium' })
    expect(tierAt(stepFor('moderate', config), config)).toEqual({ role: 'balanced', effort: 'high' })
    expect(tierAt(stepFor('complex', config), config)).toEqual({ role: 'strong', effort: 'high' })
  })

  test('a failed build goes up one rung, and stops at the top', async () => {
    expect(tierAt(escalate(stepFor('moderate', config), config) ?? -1, config)).toEqual({ role: 'strong', effort: 'medium' })
    expect(tierAt(escalate(stepFor('complex', config), config) ?? -1, config)).toEqual({ role: 'strong', effort: 'xhigh' })
    expect(escalate(config.ladder.length - 1, config)).toBeUndefined()
  })

  test('cheaper and stronger stay on the ladder', async () => {
    expect(shiftStep(0, -1, config)).toBe(0)
    expect(shiftStep(0, 1, config)).toBe(1)
    expect(shiftStep(config.ladder.length - 1, 1, config)).toBe(config.ladder.length - 1)
  })

  test('a routing table that names a rung off the ladder is clamped onto it', async () => {
    const odd = { ...config, routing: { simple: -3, moderate: 99 } }
    expect(stepFor('simple', odd)).toBe(0)
    expect(stepFor('moderate', odd)).toBe(odd.ladder.length - 1)
    expect(stepFor('complex', odd)).toBe(odd.ladder.length - 1)
  })
})
