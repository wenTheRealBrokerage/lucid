// Test data. Model ids and family names appear here as data, the way they
// reach the mod from the models API and from its JSON files.

export const CONFIG_TEXT = JSON.stringify({
  roles: { fast: 'haiku', balanced: 'sonnet', strong: 'opus', frontier: 'fable' },
  excludeIdPrefixes: ['claude-mythos-'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  ladder: [
    { role: 'balanced', effort: 'medium' },
    { role: 'balanced', effort: 'high' },
    { role: 'strong', effort: 'medium' },
    { role: 'strong', effort: 'high' },
    { role: 'strong', effort: 'xhigh' },
  ],
  routing: { simple: 0, moderate: 1, complex: 3 },
  classifier: { role: 'fast', effort: 'low' },
  narrationLadder: [
    { role: 'fast', effort: 'low' },
    { role: 'fast', effort: 'medium' },
    { role: 'balanced', effort: 'medium' },
  ],
  narrationMinChars: 600,
  rosterMaxAgeHours: 24,
})

const effort = (levels: string[]) => ({
  supported: levels.length > 0,
  ...Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map(level => [level, { supported: levels.includes(level) }])),
})

const ALL = ['low', 'medium', 'high', 'xhigh', 'max']

export const MODELS_TEXT = JSON.stringify({
  data: [
    { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-10-07T18:00:00Z', line: 'haiku', lifecycle: 'active', capabilities: { effort: effort(ALL), image_input: { supported: true } } },
    { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-28T00:00:00Z', line: 'sonnet', lifecycle: 'active', capabilities: { effort: effort(ALL) } },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-06-29T00:00:00Z', line: 'sonnet', lifecycle: 'active', capabilities: { effort: effort(ALL) } },
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-21T00:00:00Z', line: 'opus', lifecycle: 'active', capabilities: { effort: effort(ALL) } },
    { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', created_at: '2025-11-24T00:00:00Z', lifecycle: 'active', capabilities: { effort: effort(['low', 'medium', 'high']) } },
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', created_at: '2026-08-28T00:00:00Z', line: 'fable', lifecycle: 'active', capabilities: { effort: effort(ALL) } },
    { id: 'claude-mythos-5-1', display_name: 'Claude Mythos 5.1', created_at: '2026-09-01T00:00:00Z', line: 'mythos', lifecycle: 'active', capabilities: { effort: effort(ALL) } },
    { id: 'claude-lyric-1', display_name: 'Claude Lyric 1', created_at: '2026-10-01T00:00:00Z', line: 'lyric', lifecycle: 'active', capabilities: { effort: effort([]), audio_output: { supported: true } } },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-15T00:00:00Z', line: 'haiku', lifecycle: 'retired', capabilities: { effort: effort([]) } },
  ],
  has_more: false,
})

export const FALLBACK_TEXT = JSON.stringify({
  asOf: '2026-10-08',
  models: [
    { id: 'claude-haiku-5-5', family: 'haiku', name: 'Claude Haiku 5.5', efforts: ALL, inputPerMTok: 0.1, outputPerMTok: 0.5, note: 'second tier above 100,000 tokens' },
    { id: 'claude-sonnet-5-5', family: 'sonnet', name: 'Claude Sonnet 5.5', efforts: ALL, inputPerMTok: 2, outputPerMTok: 10 },
    { id: 'claude-opus-5-5', family: 'opus', name: 'Claude Opus 5.5', efforts: ALL, inputPerMTok: 4, outputPerMTok: 20 },
    { id: 'claude-fable-5-1', family: 'fable', name: 'Claude Fable 5.1', efforts: ALL, inputPerMTok: 10, outputPerMTok: 50 },
  ],
})

export const PRICING_TEXT = [
  '# Pricing',
  '',
  '| Model | Base input tokens | 5m cache writes | Cache hits | Output tokens |',
  '| --- | --- | --- | --- | --- |',
  '| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |',
  '| Claude Mythos 5.1 ([limited availability](https://example.com)) | $10 / MTok | $12.50 / MTok | $0.25 / MTok | $50 / MTok |',
  '| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $0.10 / MTok | $10 / MTok |',
  '| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.01 / MTok | $0.50 / MTok |',
  '| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $0.05 / MTok | $2.50 / MTok |',
  '',
  '## Batch',
  '',
  '| Model | Batch input | Batch output |',
  '| --- | --- | --- |',
  '| Claude Sonnet 5.5 | $1 / MTok | $5 / MTok |',
].join('\n')
