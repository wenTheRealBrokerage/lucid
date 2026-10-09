import { describe, expect, test } from 'claude-code/testing'

import {
  aliasRoster,
  applyPricing,
  clampEffort,
  describeChanges,
  familyFromId,
  isStale,
  newestOf,
  parseConfig,
  parseFallback,
  parseModelsResponse,
  parsePricing,
  resolveTier,
  unknownFamilies,
} from '../hooks/roster'

import { CONFIG_TEXT, FALLBACK_TEXT, MODELS_TEXT, PRICING_TEXT } from './fixtures'

const config = parseConfig(CONFIG_TEXT)
const NOW = 1_791_500_000_000

describe('roster from the models API', () => {
  const roster = parseModelsResponse(MODELS_TEXT, config, NOW)

  test('keeps active models and drops the excluded prefix and the retired', async () => {
    const ids = roster.models.map(model => model.id)
    expect(ids).toContain('claude-haiku-5-5')
    expect(ids).not.toContain('claude-mythos-5-1')
    expect(ids).not.toContain('claude-haiku-4-5-20251001')
    expect(roster.source).toBe('api')
  })

  test('reads the family from the line field, else from the id', async () => {
    expect(roster.models.find(model => model.id === 'claude-opus-4-5-20251101')?.family).toBe('opus')
    expect(familyFromId('claude-opus-4-5-20251101')).toBe('opus')
    expect(familyFromId('not-a-model')).toBeUndefined()
  })

  test('the newest of a family wins by creation date', async () => {
    expect(newestOf(roster.models, 'sonnet')?.id).toBe('claude-sonnet-5-5')
    expect(newestOf(roster.models, 'opus')?.id).toBe('claude-opus-5-5')
    expect(newestOf(roster.models, 'nothing')).toBeUndefined()
  })

  test('with no dates the version in the id decides', async () => {
    const undated = roster.models.map(model => ({ ...model, createdAt: '' }))
    expect(newestOf(undated, 'sonnet')?.id).toBe('claude-sonnet-5-5')
    expect(newestOf(undated, 'opus')?.id).toBe('claude-opus-5-5')
  })

  test('reads each model its supported effort levels', async () => {
    expect(newestOf(roster.models, 'haiku')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(roster.models.find(model => model.id === 'claude-opus-4-5-20251101')?.efforts).toEqual(['low', 'medium', 'high'])
  })

  test('a family no role uses is listed, never picked', async () => {
    expect(unknownFamilies(roster, config.roles)).toEqual(['lyric'])
    expect(resolveTier({ role: 'singer', effort: 'low' }, roster, config.roles, config).isResolved).toBe(false)
  })

  test('reports a capability that reads like audio', async () => {
    expect(roster.audioCapabilities).toEqual(['claude-lyric-1: audio_output'])
  })

  test('a response with no usable model is an error, not an empty roster', async () => {
    expect(() => parseModelsResponse('{"data":[]}', config, NOW)).toThrow('no usable model')
    expect(() => parseModelsResponse('{"error":"nope"}', config, NOW)).toThrow('no "data" list')
  })
})

describe('tiers on a roster', () => {
  const roster = parseModelsResponse(MODELS_TEXT, config, NOW)

  test('a tier resolves to the newest model of its role and keeps its effort', async () => {
    const pick = resolveTier({ role: 'strong', effort: 'xhigh' }, roster, config.roles, config)
    expect(pick.isResolved && pick.model.id).toBe('claude-opus-5-5')
    expect(pick.isResolved && pick.effort).toBe('xhigh')
    expect(pick.isResolved && pick.wasClamped).toBe(false)
  })

  test('an effort the model lacks is clamped down to one it has', async () => {
    const old = { ...roster, models: roster.models.filter(model => model.id !== 'claude-opus-5-5') }
    const pick = resolveTier({ role: 'strong', effort: 'xhigh' }, old, config.roles, config)
    expect(pick.isResolved && pick.model.id).toBe('claude-opus-4-5-20251101')
    expect(pick.isResolved && pick.effort).toBe('high')
    expect(pick.isResolved && pick.wasClamped).toBe(true)
  })

  test('a model that takes no effort setting keeps the effort asked for, which the engine then leaves out', async () => {
    const pick = resolveTier({ role: 'singer', effort: 'high' }, roster, { ...config.roles, singer: 'lyric' }, config)
    expect(pick.isResolved && pick.model.id).toBe('claude-lyric-1')
    expect(pick.isResolved && pick.effort).toBe('high')
    expect(pick.isResolved && pick.wasClamped).toBe(false)
  })

  test('clamping prefers the level below, then the lowest above', async () => {
    expect(clampEffort('xhigh', ['low', 'high'], config.efforts)).toBe('high')
    expect(clampEffort('low', ['medium', 'high'], config.efforts)).toBe('medium')
    expect(clampEffort('high', [], config.efforts)).toBe('high')
  })

  test('a role mapped to another family uses that family', async () => {
    const pick = resolveTier({ role: 'balanced', effort: 'medium' }, roster, { ...config.roles, balanced: 'fable' }, config)
    expect(pick.isResolved && pick.model.id).toBe('claude-fable-5-1')
  })
})

describe('roster without the API', () => {
  const fallback = parseFallback(FALLBACK_TEXT, config, NOW)

  test('the fallback table resolves every tier of the ladder', async () => {
    expect(fallback.source).toBe('fallback')
    expect(fallback.asOf).toBe('2026-10-08')
    for (const tier of [...config.ladder, config.classifier]) {
      expect(resolveTier(tier, fallback, config.roles, config).isResolved).toBe(true)
    }
    const pick = resolveTier({ role: 'fast', effort: 'low' }, fallback, config.roles, config)
    expect(pick.isResolved && pick.model.id).toBe('claude-haiku-5-5')
    expect(pick.isResolved && pick.model.inputPerMTok).toBe(0.1)
  })

  test('the alias roster names each mapped family by its engine alias', async () => {
    const aliases = aliasRoster(config, fallback, NOW)
    expect(aliases.source).toBe('alias')
    expect(aliases.models.map(model => model.id).sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet'])
    const pick = resolveTier({ role: 'strong', effort: 'high' }, aliases, config.roles, config)
    expect(pick.isResolved && pick.model.id).toBe('opus')
    expect(pick.isResolved && pick.model.outputPerMTok).toBe(20)
  })

  test('a broken fallback file is an error', async () => {
    expect(() => parseFallback('{"asOf":"x"}', config, NOW)).toThrow('no "models" list')
  })

  test('a roster is stale after its maximum age, and when there is none', async () => {
    expect(isStale(undefined, NOW, 24)).toBe(true)
    expect(isStale(fallback, NOW + 23 * 3_600_000, 24)).toBe(false)
    expect(isStale(fallback, NOW + 25 * 3_600_000, 24)).toBe(true)
  })
})

describe('prices and changes', () => {
  const fallback = parseFallback(FALLBACK_TEXT, config, NOW)
  const roster = parseModelsResponse(MODELS_TEXT, config, NOW)

  test('reads the first price table, one row per model, a second tier as a note', async () => {
    const prices = parsePricing(PRICING_TEXT)
    expect(prices.map(price => price.name)).toEqual(['Claude Fable 5.1', 'Claude Mythos 5.1', 'Claude Sonnet 5.5', 'Claude Haiku 5.5'])
    const haiku = prices.find(price => price.name === 'Claude Haiku 5.5')
    expect(haiku?.inputPerMTok).toBe(0.1)
    expect(haiku?.outputPerMTok).toBe(0.5)
    expect(haiku?.note).toContain('$0.5 in / $2.5 out')
    expect(prices.find(price => price.name === 'Claude Sonnet 5.5')?.outputPerMTok).toBe(10)
  })

  test('a page with no table gives no prices, and the fallback table fills in', async () => {
    expect(parsePricing('no table here')).toEqual([])
    const priced = applyPricing(roster, [], fallback)
    expect(newestOf(priced.models, 'opus')?.inputPerMTok).toBe(4)
    expect(priced.models.find(model => model.id === 'claude-sonnet-5')?.inputPerMTok).toBeUndefined()
  })

  test('a listed price wins over the fallback table', async () => {
    const priced = applyPricing(roster, [{ name: 'Claude Opus 5.5', inputPerMTok: 3, outputPerMTok: 15 }], fallback)
    expect(newestOf(priced.models, 'opus')?.inputPerMTok).toBe(3)
  })

  test('a refresh says what changed', async () => {
    expect(describeChanges(undefined, roster, config.roles)).toEqual(['first roster, from the api: 7 models'])
    expect(describeChanges(roster, roster, config.roles)).toEqual([])

    const changes = describeChanges(fallback, roster, config.roles)
    expect(changes).toContain('source: fallback -> api')
    expect(changes).toContain('new family "lyric": not used until you map it to a role')
    expect(changes).toContain('possible audio capability: claude-lyric-1: audio_output')

    const older = { ...roster, models: roster.models.filter(model => model.id !== 'claude-sonnet-5-5') }
    expect(describeChanges(older, roster, config.roles)).toEqual(['balanced (sonnet): claude-sonnet-5 -> claude-sonnet-5-5'])
  })
})
