# lucid

A Claude Code mod. When Claude asks you a question, lucid offers to turn it into an explainer page: what is being decided, what each option leads to, and what it costs to get wrong. A subagent builds the page, long sections get narration you can play, and the page is published as a private artifact.

The offer costs nothing. No model is called until you accept it.

## Requirements

- Claude Code 2.1.295 or later, in a terminal session. The mod API is early access and changes between releases.
- macOS. Narration uses the `say` command and `afplay`.
- Optional: Node and npm for the Kokoro voice, Google Chrome for opening pages.

## Install

From a clone, so that edits are live:

```sh
claude plugin marketplace add ~/Documents/Workspace/lucid
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

Choosing the option withholds the answer from Claude, which waits. lucid then rates the question with one small model call, shows the model and effort it would use, and asks before it builds. The button skips that question, because a second dialog cannot open over the first.

| Command | What it does |
| --- | --- |
| `/explain` | Builds an explainer for the last question Claude asked. |
| `/explain about <text>` | Builds one for any text. |
| `/explain view` | Opens the explainer pane. Brings back the last explainer after `/clear` or a restart. |
| `/explain open` | Opens the page in a browser. |
| `/explain status` | Says where the build is, with the model, effort and measured tokens. |
| `/explain stop` | Stops narration playing in the terminal. |
| `/explain cancel` | Cancels a build. A subagent already running finishes on its own. |
| `/explain revoice` | Renders the last explainer's narration again with the current speech engine. |
| `/explain tts [say [voice] \| kokoro \| hosted]` | Shows or sets the speech engine. |
| `/explain set <offer \| confirm \| open \| publish> <on \| off>` | Turns the offer, the confirmation, the automatic browser open, or publishing on or off. |
| `/explain-models` | Refreshes the model roster, prints it, and re-checks which model writes narration. |
| `/explain-models use <role> <family>` | Maps a role to a model family. |

In the pane: `p` and `n` step through sections, `l` plays the section's narration, `s` stops it, `o` opens the page, `a` asks Claude to put the question again. Focus the pane with `ctrl+x` then `tab`, or click.

### Where the page shows

1. In the pane, as Markdown, one section at a time.
2. In the terminal as a real page, if the [terminal-browser](https://github.com/zenbu-labs/terminal-browser) mod is loaded. **UNVERIFIED**: this path has never run. It needs a terminal that draws kitty graphics with Unicode placeholders (kitty, Ghostty). Warp did not as of 2026-10-09.
3. Otherwise in Google Chrome, or the default browser when Chrome is missing.

## How a model is chosen

No model id or family name is written into the code. They come from three files of data:

- `lucid.config.json`: which family plays each role (`fast`, `balanced`, `strong`, `frontier`), the ladder of role and effort pairs, and which rung each complexity starts on.
- The roster: `GET /v1/models` with the session's own login, refreshed from a timer at most once a day. The newest model of each family is used. A family no role names is listed by `/explain-models` and never used until you map it.
- `roster.fallback.json`: prices and ids dated 2026-10-08, used when the API cannot be reached.

When the API cannot be reached, lucid uses Claude Code's own aliases for each family, then the fallback ids. On 2026-10-09 each alias resolved to the newest model of its family.

| Rated | First try | If the page fails its checks |
| --- | --- | --- |
| simple | balanced, medium effort | balanced, high |
| moderate | balanced, high | strong, medium |
| complex | strong, high | strong, xhigh |

An effort a model does not support is lowered to one it does. A classifier reply that names no label, or more than one, counts as moderate.

lucid shows measured token counts after a build. It never shows a cost estimate.

## Speech

Claude models write the narration script. They do not produce audio, so a speech engine does.

- **`say`** (default). The macOS system voice, on this machine, offline. `/explain tts say Samantha` picks a voice.
- **Kokoro** (opt-in). `/explain tts kokoro` installs `kokoro-js` and a voice model under `~/.claude/plugins/data/lucid/kokoro`: about 500 MB in all, fetched once, then offline. Needs Node and npm.
- **Hosted** (opt-in). `/explain tts hosted` asks first, because it sends narration text off this machine. It needs `LUCID_TTS_URL` and `LUCID_TTS_API_KEY`, and optionally `LUCID_TTS_MODEL`, and speaks to an OpenAI-style `audio/speech` endpoint. **UNVERIFIED**: never run against a real service.

A section is narrated when it has at least 600 characters of prose and the writer judges it worth hearing. The script must keep every standalone number from the section. If no writer passes, the section is read as written.

In the page, each narrated section has a Listen button that pauses and resumes. In the terminal there is no pause: Play starts the clip and Stop ends it.

## Privacy

- Building an explainer sends the question and the last few messages of your session to a Claude model on your account.
- **Publishing uploads that text, as the page, to claude.ai.** The artifact is private to you until you share it. `/explain set publish off` keeps pages on this machine.
- **Hosted speech sends narration text to a third party.** It is off until you turn it on.
- `say` and Kokoro render on this machine. Kokoro downloads its model once from Hugging Face.
- Pages, scripts and audio are kept under `~/.claude/plugins/data/lucid/jobs/`. Delete that folder to remove them.

## Platform limits

- **macOS only.** On other systems `say` does not exist and `$.audio` plays nothing. **UNVERIFIED** there.
- **Terminal only.** The desktop app, VS Code and mobile surfaces are **UNVERIFIED**.
- Under `claude -p` there is no question dialog and no Artifact tool. `/explain` says so and builds nothing.
- The pane opens by itself only in a terminal at least 144 columns wide (110 once you have opened it before). `/explain view` opens it at any width.
- In manual permission mode the publish asks for approval each time. The builder's two file writes may ask too (**UNVERIFIED**).
- The system voice wrote silent clips inside a detached tmux session during testing. lucid detects a silent clip and reports it instead of embedding it.
- Published-page audio was tested in Chrome on macOS only. Safari, the desktop app and mobile are **UNVERIFIED**.
- `ArtifactCheck` was not available to test with. The page checks are lucid's own: title, wrappers, script and stylesheet hosts, pinned versions, network calls, both themes, and sections that match.
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
.claude-plugin/     plugin and marketplace manifests
hooks/register.tsx  every hook and every call on the engine
hooks/*.ts          roster, routing, narration and page checks: pure functions
prompts/            what the two subagents are told
scripts/embed.sh    writes the one-file page with audio as data URIs
scripts/kokoro.mjs  renders a script with Kokoro
assets/player.html  the Listen button
tests/              run by claude plugin test
```

The subagents are registered at run time, not declared in `agents/`: a spawn takes only an engine alias as its model, so the exact model id and the effort ride the registration.
