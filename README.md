# lucid

A Claude Code mod. When Claude asks you a question, lucid offers to explain it first: what is being decided, what each option leads to, and what it costs to get wrong. A subagent writes the explainer, long sections get narration you can play, and you read it in a pane of the terminal you are already in.

The offer costs nothing. No model is called until you accept it.

## Why terminal-first

The explainer is a terminal document: Markdown sections, diagrams drawn in ASCII or box-drawing characters, and frames you step through where order matters. It renders in the pane of any emulator Claude Code runs in, with nothing to open and nothing uploaded.

An HTML page and a published artifact still exist, as two explicit commands. They are never automatic, for two reasons:

- **Publishing uploads session text.** The page is written from the question and the last few messages of your session, and publishing sends it to claude.ai.
- **Claude cannot clean up after itself.** The Artifact tool's `delete` requires you to confirm every delete, so an artifact published by a mod would stay until you removed it by hand.

## Requirements

- Claude Code 2.1.295 or later, in a terminal session. The mod API is early access and changes between releases.
- macOS for narration. It uses the `say` command to render clips and `afplay` to play them; other systems build the explainer without audio.
- Optional: Node and npm for the Kokoro voice, Google Chrome for opening the HTML page.

## Install

From a clone, so that edits are live:

```sh
claude plugin marketplace add <path to the clone>
claude plugin install lucid@lucid --scope user
```

Then run `/reload-plugins`. After an edit to the folder, `/reload-plugins` again is enough.

From GitHub, typed at the prompt of a terminal session:

```
/plugin install lucid --marketplace wenTheRealBrokerage/lucid
```

The repository is private, so whoever installs it needs read access and working git credentials (`gh auth login`). The line does not work in the desktop app's Code tab.

## Use

When Claude asks a question with `AskUserQuestion`, the dialog gains two ways to ask for an explainer:

- an **Explain this first** option, when the question is single-choice and has fewer than four options;
- an **Explain this first** button above the dialog, which a mouse click reaches while the dialog stays open. No key reaches it.

Choosing the option withholds the answer from Claude, which waits. lucid rates the question with one small model call, picks the model and effort from that rating, and builds. The pane opens at once and fills as the build goes; it names the model and effort while it runs. `/explain set confirm on` adds a dialog that shows the pick, with one step cheaper or stronger, before anything larger is spent; the button above the dialog skips it, because a second dialog cannot open over the first.

| Command | What it does |
| --- | --- |
| `/explain` | Builds an explainer for the last question Claude asked. |
| `/explain about <text>` | Builds one for any text. |
| `/explain view` | Opens the pane with the keyboard. Brings back the last explainer after `/clear` or a restart. Where no pane fits, prints the current section instead. |
| `/explain status` | Says where the build is, with the model, effort and measured tokens. |
| `/explain stop` | Stops narration playing in the terminal. |
| `/explain cancel` | Cancels a build. A subagent already running finishes on its own. |
| `/explain revoice` | Renders the last explainer's narration again with the current speech engine. |
| `/explain page` | Opt-in. A second subagent writes an HTML page from the finished explainer, with the narration embedded, to a local file. |
| `/explain open` | Opens that page in a browser. |
| `/explain publish` | Opt-in. Uploads the page as a private artifact, after asking once. Needs `/explain set publish on` first. |
| `/explain tts [say [voice] \| kokoro \| hosted]` | Shows or sets the speech engine. |
| `/explain set <offer \| confirm \| open \| publish \| animate> <on \| off>` | Turns the offer, the model confirmation dialog (off by default), the browser open after `/explain page`, the publish command, or frame auto-advance on or off. |
| `/explain-models` | Refreshes the model roster, prints it, and re-checks which model writes narration. |
| `/explain-models use <role> <family>` | Maps a role to a model family. |

### The pane

The pane opens when you ask for an explainer and seats beside the transcript in a fullscreen terminal from 110 columns, else above the prompt. Focus it with `ctrl+x` then `tab` (or click), and the keys below act. `Esc` hands the keys back. `ctrl+x` then an arrow resizes it; `ctrl+x` then `x` closes it.

| Key | Does |
| --- | --- |
| `p` `n` | previous and next section |
| `t` | the contents list; `1` to `9` jump to a section while it shows |
| `f` `b` | the next and previous frame of a section that has steps |
| `g` | auto-advance the frames, one every 2.5 seconds; `g` again pauses. Off entirely with `/explain set animate off` |
| `l` `s` | play the section's narration, stop it. When a clip ends, the next narrated section plays |
| `o` | open the HTML page, shown only after `/explain page` |
| `a` | ask Claude to put the question again, after an explainer built from the dialog |

The hotkeys are the engine's: one digit or lowercase letter each, and they reach the pane only while it holds the keyboard. A dim line in the pane says so when it does not.

## The document

The builder writes one file, `explainer.json`, which lucid checks before it narrates anything. A document that fails goes back for one more build, one rung up the ladder.

```
{"title": "<short name>",
 "sections": [{"id": "kebab-case-id", "heading": "...", "markdown": "...",
   "diagram": {"ascii": ["..."], "unicode": ["..."], "maxWidth": 60},
   "steps": ["..."], "narrate": true, "takeaway": "..."}]}
```

- `markdown`: prose, lists, tables and fenced code; no raw HTML. Tab and newline are the only control characters the engine draws.
- `diagram`: optional. `ascii` is required and uses `+ - | < > ^ v`, letters, digits and punctuation; `unicode` is an optional box-drawing twin; no tabs in either; every line at most `maxWidth`, which is at most 60. A docked pane at 80 columns has 63 body columns, and the diagram card takes four of them.
- `steps`: optional frames, at most 24, revealed one at a time.
- `narrate`: optional. By default sections of 600 characters or more are narrated; `true` or `false` overrides that for one section.
- `takeaway`: optional, one sentence, set apart under the section.
- The whole file stays under 90,000 characters, below the 100,000 the engine draws in one tree.

Diagrams are drawn with the `Code` element and `truncate-end`, so a diagram wider than the pane is cut at the edge with a hint, never wrapped into a torn drawing.

## The terminal probe

lucid reads `TERMINAL_EMULATOR`, `TERM_PROGRAM`, `TERM`, `COLORTERM`, `TMUX` and `WT_SESSION` once per load, and derives the emulator, whether box drawing is trusted, whether it announces 24-bit colour, and whether it runs inside tmux. The probe decides one thing: whether a diagram's `unicode` twin is drawn or its `ascii` form. Nothing else depends on it.

| Emulator | Box drawing | Notes |
| --- | --- | --- |
| iTerm2, Terminal.app, VS Code, Warp, kitty, Ghostty, Windows Terminal | trusted | Terminal.app is treated as 256 colours even when `COLORTERM` says otherwise |
| JetBrains terminal | trusted | a Markdown table's box-drawing borders rendered intact in the Reworked terminal on 2026-10-09 |
| inside tmux | ASCII | the outer emulator's variables do not pass through |
| anything else | ASCII | |

Colour in the pane comes from theme keys (`claude`, `success`, `error`, `warning`, `inverseText`), so it follows the light or dark theme you picked. Dim text is kept for the keys line and future pipeline stages only, because some palettes draw it near-invisible. No truecolor is assumed. Nothing relies on kitty graphics or on the mouse; clicks work where the terminal reports them.

## Verified terminals

Run the checklist in each terminal and fill a row. Every cell starts **UNVERIFIED**; nothing below was promoted from research.

1. `/explain view` seats the pane at the panel's natural width and at 80 columns.
2. `ctrl+x tab` focuses it; `p n t 1-9 f b g l s a` act; `Esc` returns the keys.
3. A table and a diagram render without torn borders (ASCII fallback if not).
4. A 3,000-character section scrolls with the arrows.
5. Play voices a clip and auto-advances to the next narrated section (macOS only).
6. Frame step works, and auto-advance stops with `/explain set animate off`.
7. No artifact exists after a build; `/explain page` writes a local HTML file; `/explain publish` asks once, then publishes.

| Terminal | Version | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Warp | 2026-10 build, Claude Code 2.1.295 | PASS (dock at 110+, inline on the main screen; 80 columns gives a 63-column body) | PASS for `ctrl+x tab` and the hotkeys in the Phase 0 spike; the lucid keys UNVERIFIED | PASS (table and box-drawing fence in the spike) | PASS (arrows scrolled a 3,000-character section) | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| IntelliJ terminal (Reworked 2025) | 2026-10 build | PASS (pane seated and drew a full explainer) | UNVERIFIED | PASS for a table (borders intact); a diagram UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| IntelliJ terminal (Classic) | | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| iTerm2 | | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Terminal.app | | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| VS Code terminal | | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| tmux | | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Windows Terminal | | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |

In IntelliJ, start `claude` from a terminal tab, not the plugin icon, which has been reported to give an 80x24 PTY. Older IDEs need "Move focus to the editor with Escape" unchecked for `Esc` to reach the app.

## How a model is chosen

No model id or family name is written into the code. They come from three files of data:

- `lucid.config.json`: which family plays each role (`fast`, `balanced`, `strong`, `frontier`), the ladder of role and effort pairs, and which rung each complexity starts on.
- The roster: `GET /v1/models` with the session's own login, refreshed from a timer at most once a day. The newest model of each family is used. A family no role names is listed by `/explain-models` and never used until you map it.
- `roster.fallback.json`: prices and ids dated 2026-10-08, used when the API cannot be reached.

When the API cannot be reached, lucid uses Claude Code's own aliases for each family, then the fallback ids. On 2026-10-09 each alias resolved to the newest model of its family.

| Rated | First try | If the document fails its checks |
| --- | --- | --- |
| simple | balanced, medium effort | balanced, high |
| moderate | balanced, high | strong, medium |
| complex | strong, high | strong, xhigh |

An effort a model does not support is lowered to one it does. A classifier reply that names no label, or more than one, counts as moderate. `/explain page` starts on the rung the explainer was built on.

lucid shows measured token counts after a build. It never shows a cost estimate.

## Speech

Claude models write the narration script. They do not produce audio, so a speech engine does.

- **`say`** (default). The macOS system voice, on this machine, offline. `/explain tts say Samantha` picks a voice.
- **Kokoro** (opt-in). `/explain tts kokoro` installs `kokoro-js` and a voice model under `<config dir>/plugins/data/lucid/kokoro`: about 500 MB in all, fetched once, then offline. Needs Node and npm.
- **Hosted** (opt-in). `/explain tts hosted` asks first, because it sends narration text off this machine. It needs `LUCID_TTS_URL` and `LUCID_TTS_API_KEY`, and optionally `LUCID_TTS_MODEL`, and speaks to an OpenAI-style `audio/speech` endpoint. **UNVERIFIED**: never run against a real service.

A section is narrated when it has at least 600 characters of prose and the writer judges it worth hearing, unless its own `narrate` says otherwise. The script must keep every standalone number from the section. If no writer passes, the section is read as written.

Clips are rendered to files, so they survive `/explain revoice` and are embedded by `/explain page`. In the terminal there is no pause: Play starts the clip and Stop ends it. In the page, each narrated section has a Listen button that pauses and resumes.

## Privacy

- Building an explainer sends the question and the last few messages of your session to a Claude model on your account.
- Nothing leaves this machine otherwise. **`/explain publish` uploads the page to claude.ai**, private to you until you share it, and only after `/explain set publish on` and a confirmation.
- **Hosted speech sends narration text to a third party.** It is off until you turn it on.
- `say` and Kokoro render on this machine. Kokoro downloads its model once from Hugging Face.
- Documents, scripts, audio and pages are kept under `<config dir>/plugins/data/lucid/jobs/`, where the config dir is `CLAUDE_CONFIG_DIR` or `~/.claude`. Delete that folder to remove them.

## Platform limits

- **Narration is macOS only.** On other systems `say` does not exist and `$.audio` plays nothing; the explainer still builds. **UNVERIFIED** there.
- **Terminal only.** On the desktop app, VS Code and mobile the pane draws the same sections with diagrams as fenced Markdown. Those surfaces are **UNVERIFIED** beyond the test kit.
- Under `claude -p` there is no question dialog. `/explain` says so and builds nothing.
- A pane opened by a command or a button seats at any width. One opened by the "Explain this first" option, which runs inside the tool call, counts as unasked: it seats only in a terminal at least 144 columns wide (110 once you have opened it before). `/explain view` seats it at any width, and prints the section when even that fails.
- The pane opens without the keyboard while the question dialog is up. Answer the dialog, then `ctrl+x tab`.
- There is no pause in the terminal, and `afplay` is the player.
- The system voice wrote silent clips inside a detached tmux session during testing. lucid detects a silent clip and leaves the section without audio.
- Page audio was tested in Chrome on macOS only. Safari, the desktop app and mobile are **UNVERIFIED**.
- The terminal-browser path for the HTML page, through the `browser` noun another mod adds, is **UNVERIFIED**: it has never run. It needs a terminal that draws kitty graphics with Unicode placeholders. kitty and Ghostty answer the graphics query; Ghostty 1.3.1 lacks the Unicode placeholders per terminfo.dev, and Warp did not draw them as of 2026-10-09.
- Whether a private repository auto-updates in the background without a credential helper is **UNVERIFIED**.

## Develop

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```

`tsc` needs the engine's type declarations in `.claude-plugin/types/`. Start `claude --plugin-dir .` once and the engine writes them. Use a current TypeScript: with several hundred MCP tools connected, TypeScript 5.6 runs out of type depth in the engine's generated declarations.

Bump `version` in `.claude-plugin/plugin.json` on every shared change. Installed copies from GitHub update only on a new version.

```
.claude-plugin/          plugin and marketplace manifests
hooks/register.tsx       every hook and every call on the engine, and the pane
hooks/explainer.ts       the document's checks and the pane's pure helpers
hooks/terminal.ts        the terminal probe, from environment variables
hooks/page.ts            the dialog offer and the opt-in page's checks
hooks/{roster,routing,narration}.ts  model choice and narration: pure functions
prompts/explainer.md     the terminal builder's instructions
prompts/explainer-page.md  the opt-in page builder's instructions
prompts/narration-writer.md
scripts/embed.sh         writes the one-file page with audio as data URIs
scripts/kokoro.mjs       renders a script with Kokoro
assets/player.html       the page's Listen button
tests/                   run by claude plugin test
```

The subagents are registered at run time, not declared in `agents/`: a spawn takes only an engine alias as its model, so the exact model id and the effort ride the registration. The terminal builder gets the `Write` tool alone; the page builder gets `Read`, `Write`, `Edit` and `Skill`.
