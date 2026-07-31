# WackChatter

A lightweight chat frontend for cloud LLMs, **data-compatible with SillyTavern**: character
cards and chat-completion presets move between the two apps untouched. Chats and app
settings are ours and deliberately not portable.

Bun (server) + React 19 + TypeScript + Vite (client). Desktop only — no mobile support.

Reference copy of SillyTavern lives at `../SillyTavernSource` (read-only, for format
research; we reimplement, we do not copy).

## Commands

- `bun run dev:server` — API on **8787**, hot-reloaded.
- `bun run dev:client` — Vite on **5173**, proxies `/api` to 8787. This is the URL you open.
- `bun run build` — typecheck (`tsc --noEmit`) then Vite build to `dist/`.
- `bun run start` — production: serves `dist/` + API on one port, opens the browser.
- `bun test` — all tests. `npx tsc --noEmit` for types. `bun run lint` for Biome.

`WC_PORT` overrides the API port, `WC_DATA_DIR` the data directory, `WC_NO_OPEN=1` stops
the browser launching.

## Layout

```
server/          Bun. Thin: files, DB, streaming proxy. Never builds a prompt.
  lib/png.ts     PNG chunk parse/encode + CRC32 + tEXt. Pure TS, no deps.
  lib/card.ts    Card read/normalise/merge/write.
  lib/paths.ts   Data dirs, filename sanitising, traversal guards.
shared/          Pure, no I/O. Imported by both server and client.
  prompt/        Assembly engine, macros, preset I/O, defaults.
  types/         Card, preset, worldinfo, chat.
src/             React app.
  layout/        AppShell — the three-column grid.
  features/      character/, preset/ (one folder per feature).
data/            Gitignored. characters/*.png, presets/*.json, lorebooks/, personas/.
```

**Prompt assembly runs client-side**, like SillyTavern. The server only proxies. This keeps
the server dumb and fast, lets the Prompt Manager show live per-prompt token counts, and
makes an exact "what was sent" inspector trivial.

## Format rules that must not be broken

These are verified against SillyTavern's source and covered by tests. Breaking any of them
corrupts users' libraries silently.

**Character cards** (`server/lib/card.ts`)
- PNG carries two `tEXt` chunks before `IEND`: `chara` (V2) and `ccv3` (V3), each
  `base64(utf8(JSON))`. Keyword match is case-insensitive.
- **Read precedence is `ccv3` over `chara`.** Write both.
- Fields live at both the top level (V1 legacy) and under `data.*`. `syncLegacyMirror`
  keeps them in step.
- **Unknown keys must survive.** `mergeCardData` merges onto the parsed original rather
  than rebuilding from a field list. This is how V3-only and third-party keys
  (`nickname`, `creation_date`, `assets`, `source`, `group_only_greetings`, `chub`,
  `risuai`) survive an edit. SillyTavern relies on the same mechanism.
- The card's own `avatar` field is vestigial (`"none"`). **The PNG filename is the identity.**
- Always emit `character_book.extensions`, even as `{}` — ST omits it but its own
  validator requires it.

**Presets** (`shared/prompt/preset-io.ts`)
- `enabled` lives on the **prompt order entry**, not the prompt object. `Prompt.enabled`
  exists in ST but is never read when deciding what to send.
- The live prompt order is `character_id: 100001`. A `100000` entry is legacy — preserve
  it untouched, never read from it.
- `prompt_order[].order` array order **is** the UI list order. There is no sort key.
- Serialise as `JSON.stringify(preset, null, 4)` with **no trailing newline**.
- All 12 built-in prompts must be present; ST re-injects missing ones on load, so a file
  without them would drift the moment it was opened there.
- Marker prompts (`chatHistory`, `charDescription`, `worldInfoBefore`, …) carry no
  `content` on disk — it is synthesized at send time.
- Unknown keys are preserved on save. ST itself drops them, but that loses provider
  settings a user configured there.

**Assembly** (`shared/prompt/assemble.ts`)
- Macros are substituted **per prompt object and per message at materialisation time**,
  never as one pass over a joined string. `{{random}}` must re-roll per occurrence and
  token counts are only right post-substitution.
- Budget is `openai_max_context - openai_max_tokens`. History packs **newest-first** and
  stops hard at the first message that doesn't fit.
- `injection_position: ABSOLUTE` leaves the ordered walk and splices into the history at
  `injection_depth` (0 = after the last message), ties broken by `injection_order`
  **descending**.
- A card's `system_prompt` / `post_history_instructions` override `main` / `jailbreak`
  unless the prompt sets `forbid_overrides`.
- `is_system` on a message means "hidden from prompt" — still shown in the transcript.

### Deliberate divergence from SillyTavern

`migratePreset` evaluates **all** migration rules for a key before deleting it. ST's own
loop deletes the key when it processes the first rule mentioning it, so later rules for
that key never run (`openai.js:4199-4210`) — silently dropping `image_inlining: true` and
every `openrouter_sort_models` value except `alphabetically`. Ours produces the intended
result. Safe: we write the modern key either way and ST ignores the legacy one.

## UI conventions

- **Three-column grid**, chat column is `1fr` so panels compress it rather than cover it.
  Widths are CSS variables on `.shell`, animated with one transition.
- Panels are **wide** (`clamp(380px, 25vw, 560px)`), matching ST's gutter. That width is
  what lets the full character editor live in the right panel.
- **No blocking modals.** The chat stays live and usable while anything else is open.
  Destructive actions use a two-click confirm in place, not a dialog.
- All colour, spacing and motion comes from `src/styles/tokens.css`. Components must not
  hardcode any of it — restyling should mean editing that one file.
- Styling is deliberately structural and plain; art direction is the user's.

## Testing

`bun test`. The gates that matter:
- `server/lib/card.test.ts` round-trips the real `default_Seraphina.png` from
  `../SillyTavernSource`, byte-for-byte, and asserts foreign keys survive an edit.
- `shared/prompt/preset-io.test.ts` loads ST's shipped `Default.json` and checks the
  100000/100001 split, the migration table, and the serialisation format.
- `shared/prompt/assemble.test.ts` covers order, budget cutoff, depth injection,
  overrides, names_behavior and squashing with a one-token-per-word counter.

When touching a format, add the test before the code.

## Status

Done: layout shell, PNG codec, card format + editor, preset format + Prompt Manager
(drag-reorder, markers, depth injection), assembly engine, macros.

Not built yet: providers (custom OpenAI-compatible + OpenRouter), SSE streaming, chat
storage (SQLite via `bun:sqlite`), swipes/edit/regenerate, World Info activation engine,
personas, the real tokenizer (`gpt-tokenizer` in a worker — assembly takes `countTokens`
as a parameter, so it drops in without touching the engine).

Out of scope for V1: group chats, Author's Note, instruct mode, extensions, image
generation, TTS, local models.
