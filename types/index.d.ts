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

/**
 * A diagram the pane draws as a code block: `ascii` always, `unicode` (box
 * drawing) where the terminal is known to draw it. `maxWidth` is the widest line,
 * as the check measured it.
 */
export type Diagram = {
  ascii: string[]
  unicode?: string[]
  maxWidth: number
}

export type Section = {
  id: string
  heading: string
  markdown: string
  diagram?: Diagram
  /** Frames the person steps through with f and b; one line each. */
  steps?: string[]
  /** Overrides the length rule for narration: true narrates a short section, false silences a long one. */
  narrate?: boolean
  /** One sentence the pane sets apart under the section. */
  takeaway?: string
  /** Absolute path of the rendered narration, when the section has one. */
  audio?: string
}

export type Stage =
  | 'classifying'
  | 'confirming'
  | 'building'
  | 'narrating'
  | 'voicing'
  | 'paging'
  | 'publishing'
  | 'done'
  | 'failed'
  | 'cancelled'

/** Token counts as the engine measured them; never an estimate. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Job = {
  id: string
  origin: 'option' | 'button' | 'command'
  dialogId?: string
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
  /** The published artifact, after `/explain publish`. */
  url?: string
  isUrlStale?: boolean
  /** The local HTML page, after `/explain page`. */
  file?: string
  finishedAt?: number
  builderUsage?: Usage
  narratorUsage?: Usage
  error?: string
}

/** What the pane shows: which section, which of its frames, whether the contents list is up, what plays. */
export type View = {
  index: number
  step: number
  isToc: boolean
  isAuto: boolean
  playing: string | null
}

declare module 'claude-code' {
  interface PluginState {
    lucid: {
      pending: Pending | null
      job: Job | null
      view: View
    }
  }
}
