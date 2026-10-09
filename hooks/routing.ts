import type { Complexity, Tier, Usage } from '../types'

import type { Config } from './roster'

// From a complexity label to a rung of the config's ladder, and one rung up
// when a build fails validation.

const LABELS: readonly Complexity[] = ['simple', 'moderate', 'complex']

/**
 * The label a classifier reply names. A reply naming none, or more than one,
 * or no reply at all (a refusal, an error) reads as `moderate`.
 */
export function parseComplexity(reply: string | undefined): Complexity {
  const named = LABELS.filter(label => new RegExp(`\\b${label}\\b`, 'i').test(reply ?? ''))

  return named.length === 1 && named[0] !== undefined ? named[0] : 'moderate'
}

const clampStep = (step: number, config: Config): number => Math.min(Math.max(step, 0), config.ladder.length - 1)

export function stepFor(complexity: Complexity, config: Config): number {
  return clampStep(config.routing[complexity] ?? config.routing.moderate ?? 0, config)
}

export function shiftStep(step: number, by: number, config: Config): number {
  return clampStep(step + by, config)
}

/** The next rung up, or undefined at the top of the ladder. */
export function escalate(step: number, config: Config): number | undefined {
  return step + 1 < config.ladder.length ? step + 1 : undefined
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (a === undefined || b === undefined) return a ?? b

  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

export function tierAt(step: number, config: Config): Tier {
  const tier = config.ladder[clampStep(step, config)]
  if (tier === undefined) throw new Error('the ladder is empty')

  return tier
}
