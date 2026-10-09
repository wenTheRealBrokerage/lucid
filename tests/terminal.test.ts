import { describe, expect, test } from 'claude-code/testing'

import { probeTerminal } from '../hooks/terminal'
import type { TerminalEnv, TerminalKind } from '../hooks/terminal'

// Each row: the environment a terminal is known to set, and what the probe
// must make of it. Box drawing is trusted on the emulators lucid lists: two
// verified by a run (Warp, JetBrains), the rest assumed from research.

const ROWS: [string, TerminalEnv, { kind: TerminalKind; unicodeSafe: boolean; truecolor: boolean; inTmux: boolean }][] = [
  ['iTerm2', { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color', COLORTERM: 'truecolor' }, { kind: 'iterm', unicodeSafe: true, truecolor: true, inTmux: false }],
  ['Terminal.app', { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }, { kind: 'apple-terminal', unicodeSafe: true, truecolor: false, inTmux: false }],
  ['Terminal.app claiming truecolor is still 256 colours', { TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor' }, { kind: 'apple-terminal', unicodeSafe: true, truecolor: false, inTmux: false }],
  ['VS Code', { TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' }, { kind: 'vscode', unicodeSafe: true, truecolor: true, inTmux: false }],
  ['Warp', { TERM_PROGRAM: 'WarpTerminal', COLORTERM: 'truecolor' }, { kind: 'warp', unicodeSafe: true, truecolor: true, inTmux: false }],
  ['kitty by TERM', { TERM: 'xterm-kitty', COLORTERM: 'truecolor' }, { kind: 'kitty', unicodeSafe: true, truecolor: true, inTmux: false }],
  ['Ghostty', { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty', COLORTERM: 'truecolor' }, { kind: 'ghostty', unicodeSafe: true, truecolor: true, inTmux: false }],
  ['Windows Terminal', { WT_SESSION: 'abc', COLORTERM: '24bit' }, { kind: 'windows-terminal', unicodeSafe: true, truecolor: true, inTmux: false }],
  ['JetBrains, verified 2026-10-09', { TERMINAL_EMULATOR: 'JetBrains-JediTerm', TERM: 'xterm-256color' }, { kind: 'jetbrains', unicodeSafe: true, truecolor: false, inTmux: false }],
  ['tmux hides the outer terminal', { TMUX: '/tmp/tmux-501/default,1,0', TERM: 'tmux-256color', TERM_PROGRAM: 'tmux' }, { kind: 'tmux', unicodeSafe: false, truecolor: false, inTmux: true }],
  ['nothing set', {}, { kind: 'unknown', unicodeSafe: false, truecolor: false, inTmux: false }],
]

describe('the terminal probe', () => {
  for (const [name, env, expected] of ROWS) {
    test(`${name}: ${expected.kind}, box drawing ${expected.unicodeSafe ? 'trusted' : 'not trusted'}`, async () => {
      expect(probeTerminal(env)).toEqual(expected)
    })
  }
})
