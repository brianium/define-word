# define-word

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) for
looking up words without leaving the terminal.

- **Select a word** (or a phrase of up to three words) with the mouse, and a
  toast shows a short definition in the top-right corner. The status line says
  what it's looking up while it works.
- **`/define`** (or `/define <word>`) opens a side pane with the full
  dictionary entry and a short explanation of what the term means **in the
  current conversation**.

Nothing it shows is added to the conversation; Claude never sees it.

## Requirements

- Claude Code **2.1.287 or later** (mods). Tested with **2.1.288**; the mods API
  can change between releases.
- The **fullscreen layout**, `"tui": "fullscreen"` in `~/.claude/settings.json`.
  On the main-screen layout the terminal owns the mouse selection, so the toast
  never fires; `/define <word>` still works.

## Install

```sh
claude plugin marketplace add brianium/define-word
claude plugin install define-word@brianium
```

Update with `claude plugin update define-word@brianium`.

## What it sends where, and what it costs

A mod runs with your permissions, so here is everything this one reaches:

| When | Where it goes | Cost |
|---|---|---|
| You select a term | The term, to the free dictionary at `api.dictionaryapi.dev` | Free |
| The dictionary lacks the term or is slow (> 0.7 s) | The term, to **Haiku** on your plan or API key | One small completion |
| You run `/define` | One extra question over **this conversation**, on your main model, with every tool denied | Mostly a prompt-cache read, plus a few sentences of output |
| You run `/define` in a resumed session before its first new turn | The text of the latest messages (up to about 24,000 characters, tool calls left out), to **Haiku** | One small completion |

Lookups are cached for the session. Run `claude plugin validate .` in this
repository to list every hook and call the mod makes.

## How it works

Claude Code has no event for a mouse selection, so the mod checks
`$.ui.selection()` every 150 ms and looks a term up once the same selection
has held for two checks, so a drag in progress doesn't fire on half a word.
Multi-line selections, code, and anything over three words are ignored, so
selecting text to copy stays quiet.

`/define` opens the pane at once and fills its two sections as they arrive:
the dictionary entry (the same lookup as the toast), and the in-conversation
meaning, from `$.model.fork`, which asks the main model one question over the
conversation as last sent without adding it to the transcript.

A fork can only replay a request this process has already sent, so right
after `--resume` (before your first new turn) it has nothing to fork. The mod
then reads the transcript with `$.session.messages()` and asks Haiku the same
question over the newest messages; the pane notes when Haiku answered.

## Development

```sh
claude --plugin-dir ~/Projects/define-word   # load for one session, hot-reloading
claude plugin test                            # run tests/ with no session or network
claude plugin validate --strict .             # check the manifest and module
```

Claude Code writes type declarations for your build to `.claude-plugin/types/`
on every load (ignored by git), so `tsc -p .` type-checks once the mod has
loaded once.

To release, bump `version` in `.claude-plugin/plugin.json` and push; users on
the same version won't see new commits.

## License

MIT. See [LICENSE](LICENSE).
