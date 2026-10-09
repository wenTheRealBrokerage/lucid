// What the terminal is, from the environment alone: which emulator, whether
// box drawing is known to render, whether it says it draws 24-bit colour.

export type TerminalKind = 'jetbrains' | 'iterm' | 'apple-terminal' | 'vscode' | 'warp' | 'kitty' | 'ghostty' | 'windows-terminal' | 'tmux' | 'unknown'

export type Terminal = {
  kind: TerminalKind
  /** Whether box-drawing diagrams are drawn without gaps here; false until a terminal is verified by hand. */
  unicodeSafe: boolean
  /** Whether the terminal announces 24-bit colour. */
  truecolor: boolean
  /** Inside tmux the outer emulator is unknown: its own variables do not pass through. */
  inTmux: boolean
}

export type TerminalEnv = {
  TERMINAL_EMULATOR?: string
  TERM_PROGRAM?: string
  TERM?: string
  COLORTERM?: string
  TMUX?: string
  WT_SESSION?: string
}

/**
 * Emulators verified to draw box drawing and block glyphs without gaps.
 * JetBrains joined on 2026-10-09: a Markdown table's borders rendered intact in
 * the Reworked terminal. Unknown kinds and tmux wait for a verified run.
 */
const UNICODE_SAFE: readonly TerminalKind[] = ['iterm', 'apple-terminal', 'vscode', 'warp', 'kitty', 'ghostty', 'windows-terminal', 'jetbrains']

export function probeTerminal(env: TerminalEnv): Terminal {
  const inTmux = (env.TMUX ?? '') !== ''
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  const term = (env.TERM ?? '').toLowerCase()
  const colorterm = (env.COLORTERM ?? '').toLowerCase()

  let kind: TerminalKind = 'unknown'
  if (inTmux) kind = 'tmux'
  else if ((env.TERMINAL_EMULATOR ?? '').toLowerCase().includes('jetbrains') || program.includes('jetbrains')) kind = 'jetbrains'
  else if (program === 'iterm.app') kind = 'iterm'
  else if (program === 'apple_terminal') kind = 'apple-terminal'
  else if (program === 'vscode') kind = 'vscode'
  else if (program === 'warpterminal') kind = 'warp'
  else if (program === 'ghostty' || term === 'xterm-ghostty') kind = 'ghostty'
  else if (program === 'kitty' || term === 'xterm-kitty') kind = 'kitty'
  else if ((env.WT_SESSION ?? '') !== '') kind = 'windows-terminal'

  // Terminal.app announced no truecolor before macOS 26; trust COLORTERM alone elsewhere.
  const truecolor = kind !== 'apple-terminal' && (colorterm === 'truecolor' || colorterm === '24bit')

  return { kind, unicodeSafe: UNICODE_SAFE.includes(kind), truecolor, inTmux }
}
