export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Complexity = 'simple' | 'moderate' | 'complex'

/** One rung of a ladder: a role (mapped to a model family by config) and an effort. */
export type Tier = { role: string; effort: Effort }

export type AskedOption = { label: string; description?: string }

export type AskedQuestion = {
  question: string
  header: string
  options: AskedOption[]
  multiSelect: boolean
}

/** The last question Claude asked, kept so `/explain` can pick it up later. */
export type Pending = {
  id: string
  questions: AskedQuestion[]
  at: number
  isOpen: boolean
}

export type Section = {
  id: string
  heading: string
  markdown: string
  /** Absolute path of the rendered narration, when the section has one. */
  audio?: string
}

export type Stage =
  | 'classifying'
  | 'confirming'
  | 'building'
  | 'narrating'
  | 'voicing'
  | 'publishing'
  | 'done'
  | 'failed'
  | 'cancelled'

/** Token counts as the engine measured them; never an estimate. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Job = {
  id: string
  origin: 'option' | 'button' | 'command'
  question: string
  stage: Stage
  note: string
  dir: string
  startedAt: number
  sections: Section[]
  complexity?: Complexity
  step?: number
  model?: string
  effort?: Effort
  title?: string
  url?: string
  file?: string
  finishedAt?: number
  builderUsage?: Usage
  narratorUsage?: Usage
  error?: string
}

export type View = { index: number; playing: string | null }

declare module 'claude-code' {
  interface PluginState {
    lucid: {
      pending: Pending | null
      job: Job | null
      view: View
    }
  }
}
