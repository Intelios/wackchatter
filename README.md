# WackChatter

A lightweight chat frontend for cloud LLMs. **Data-compatible with SillyTavern** — character cards and chat-completion presets move between the two apps untouched. Chats and app settings are ours and deliberately not portable.

Built with Bun (server) + React 19 + TypeScript + Vite (client). Desktop only.

## Features

- **SillyTavern format compatibility** — reads and writes V1/V2/V3 character cards (PNG `tEXt` chunks), including preservation of unknown keys; full chat-completion preset support (prompt ordering, depth injection, marker prompts, migrations)
- **Prompt assembly runs client-side** — live per-prompt token counts, and an inspector showing the exact wire payload
- **Streaming** — SSE with live markdown emphasis rendering, stop that actually aborts upstream (no more billing while you wait)
- **Chats** — SQLite storage, multiple chats per character, branching, swipes/regenerate/continue/edit/delete/hide, deleted-chat backups (restorable trash bin), chat export/import
- **World Info** — standalone lorebooks and embedded `character_book` editing, full conversion between both formats, ST-compatible activation engine (budget, recursion, groups, regex keys)
- **Personas** with avatars, per-chat persona binding
- **Author's Note** and **guided generations** (ST's Guided Generations extension reimplemented: one-shot steering, persistent per-chat guides)
- **Prompt Manager** — drag-reorder, marker prompts, depth injection, real tokenizer
- **Providers** — any OpenAI-compatible endpoint plus OpenRouter; keys stored server-side (mode 0600), never sent to the browser
- **User Settings** — backgrounds, glass effects, dialogue colors, all themable from one token file
- **Movable library** — keep your data anywhere (external drive, synced folder), changed from the UI with no restart

## Install

Requires [Bun](https://bun.sh) 1.2 or newer — `curl -fsSL https://bun.sh/install | bash`, or
`brew install oven-sh/bun/bun`. On Windows: `winget install Oven-sh.Bun`.

```sh
git clone https://github.com/Intelios/wackchatter.git
cd wackchatter
./start.sh
```

On Windows, run `Start.bat` instead.

The launcher installs dependencies, builds the frontend and opens the app. It does both on
every launch — together they take about a second — so there is never a build step to remember
and never a stale bundle to explain.

On first run, add a provider API key in **Connection** (left panel) and pick a model. Character
cards (`.png`) drop into `data/characters/` or import via the Characters panel.

### Updating

```sh
./update.sh
```

`Update.bat` on Windows. It is `git pull` followed by `./start.sh`, and doing those two by hand
is exactly equivalent. Your library is gitignored, so characters, chats, presets and API keys
are invisible to git and survive every update.

Environment variables: `WC_PORT` (port, default 8787), `WC_DATA_DIR` (pins the data folder and
locks the in-app setting), `WC_NO_OPEN=1` (don't launch the browser).

## Development

```sh
bun install
bun run dev          # API on :8787 + Vite on :5173 (open this URL)
```

`bun run dev:server` and `bun run dev:client` run the two halves separately. `bun run build`
typechecks and builds; `bun run start` serves the built app the way `start.sh` does. The
launcher deliberately uses `build:app`, which skips `tsc --noEmit` — a type error should stop
a commit, not stop a user from opening the app.

## Data

```
data/characters/   Character cards (PNG). Filename is the identity.
data/presets/      Chat-completion presets (JSON, ST-compatible).
data/lorebooks/    Standalone World Info books.
data/personas/     Personas + avatars.
data/chats.db      Chat history (SQLite).
data/backups/      Deleted chats, restorable.
data/settings.json App settings. data/secrets.json API keys (never sent to browser).
data/.wackchatter  Marks the folder as a library, so the app can tell it from any other.
```

`data/` is gitignored, and everything in it is one portable unit.

### Moving it somewhere else

`<repo>/data` is the default, not a requirement. **User Settings → Data location** moves the whole
library anywhere — an external drive, a synced folder, wherever you actually keep things — and
the app repoints itself without a restart. Point it at a folder that already holds a library and
it adopts that one instead, moving nothing, which is also how you switch back.

Where it lands is remembered outside the library (it cannot live inside the folder it names):

```
macOS    ~/Library/Application Support/WackChatter/location.json
Windows  %APPDATA%\WackChatter\location.json
Linux    ${XDG_CONFIG_HOME:-~/.config}/wackchatter/location.json
```

`WC_DATA_DIR` overrides that file and locks the setting in the UI. If the configured folder is
missing at startup — an unplugged drive, a folder that hasn't synced yet — the app says so and
falls back to `<repo>/data` **without changing the setting**, so reconnecting the folder and
restarting is all it takes.

### Cloud folders

Putting the library in Dropbox, iCloud Drive, OneDrive or Google Drive works, with two caveats
worth knowing before you do it:

- **SQLite and sync clients disagree.** A sync client can upload `chats.db` mid-write, or let two
  machines write it at once, and either corrupts it. WackChatter detects a synced folder and turns
  off SQLite's write-ahead log there, which removes the sidecar files that cause most of this —
  but run it from **one machine at a time**, and let the folder finish syncing before you quit.
- **Your API keys go with it.** `secrets.json` lives in the library, so moving it to a synced
  folder uploads your keys to that service. They are no longer only on your machine.

## Testing

```sh
bun test        # full suite
bun run lint    # Biome
```

The suite pins format compatibility: byte-for-byte card round-trips against SillyTavern's shipped files, preset serialisation format, the swipe invariant, SSE streaming edge cases, World Info conversion and activation, and guided-generation injection rules. When a format changes, the test comes first.

## Project layout

```
server/    Thin Bun server: files, DB, streaming proxy. Never builds a prompt.
shared/    Pure TypeScript, no I/O: prompt assembly, providers, World Info engine, chat types.
src/       React app: three-column layout, panels for Connection/Prompts/Inspect and
           Characters/Lorebooks/Persona/User Settings.
```

## Design notes

- **The server never builds a prompt.** Assembly happens in the browser (like SillyTavern), so the server stays dumb and fast and the prompt inspector shows exactly what was sent.
- **No blocking modals.** The chat stays live while anything else is open.
- **Deliberate divergences from SillyTavern** (documented in `AGENTS.md`): failed regenerates restore alternates instead of destroying the swipe array, real token usage is available opt-in, migration rules all run, and unsupported World Info positions are folded rather than dropped.
