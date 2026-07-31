# WackChatter

A lightweight chat frontend for cloud LLMs, **data-compatible with SillyTavern**: character
cards and chat-completion presets move between the two apps untouched. Chats and app
settings are ours and deliberately not portable.

Bun (server) + React 19 + TypeScript + Vite (client). Desktop only — no mobile support.

Reference copy of SillyTavern lives at `../SillyTavernSource` (read-only, for format
research; we reimplement, we do not copy).

## Important
- The app is not in use by anyone as we are in early stages so preserving compatibility is not a concern.

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
  lib/db.ts      bun:sqlite connection + schema.
  lib/chats.ts   createChatStore(db) — the whole persistence boundary.
  lib/secrets.ts API keys. Mode 0600. Never leaves the machine.
  lib/generate.ts The one place that calls a provider.
shared/          Pure, no I/O. Imported by both server and client.
  chat/          MessageState — the swipe invariant, as a type.
  prompt/        Assembly engine, macros, preset I/O, defaults, token cache.
  providers/     Request building + SSE parsing. Both unit-tested.
  types/         Card, preset, worldinfo, chat, settings.
src/             React app.
  layout/        AppShell — the three-column grid.
  features/      character/, preset/, chat/, connection/ (one folder per feature).
data/            Gitignored. characters/*.png, presets/*.json, chats.db, settings.json,
                 secrets.json, lorebooks/, personas/.
```

**Prompt assembly runs client-side**, like SillyTavern. The server only proxies. This keeps
the server dumb and fast, lets the Prompt Manager show live per-prompt token counts, and
makes an exact "what was sent" inspector trivial — the browser posts the object it built,
so the inspector shows the wire payload rather than a reconstruction of it.

**Connection settings are ours, not the preset's.** Endpoint, model and provider live in
`data/settings.json`; keys live in `data/secrets.json` and never reach the browser. A
preset's own connection keys (`custom_url`, `openrouter_model`, `chat_completion_source`)
round-trip untouched but are never read, so importing someone else's preset cannot
silently repoint your endpoint and exporting yours cannot leak it.

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
- `continue` reshapes the finished array: `continue_prefill` moves the partial reply to
  the very end (past prompts ordered after chatHistory, or the model answers those
  instead); otherwise `continue_nudge_prompt` is appended. `continue_postfix` is the join
  between old text and new, and the client's stream seed must use the same one.

**Messages** (`shared/chat/message.ts`)
- **`mes` is derived, never stored.** The internal `MessageState` has no `mes`,
  `send_date`, `gen_started`, `gen_finished` or `extra` — text comes from
  `swipes[swipe_id]` and metadata from `swipe_info[swipe_id]`. ST keeps `mes` as a field
  and needs `syncMesToSwipe`/`syncSwipeToMes` at every entry point to stop the two
  drifting; here there is nothing to keep in step.
- `fromChatMessage` is the only repair point, and runs at exactly two boundaries: reading
  a DB row and importing a card's greeting. When a stored `mes` disagrees with its swipe
  slot, `mes` wins — it is what the user last saw.
- `swipe_info` is always exactly `swipes.length`. A short one becomes `undefined` at the
  first swipe-right under `noUncheckedIndexedAccess`.

**Generation** (`src/features/chat/state/chatReducer.ts`)
- A placeholder's text starts **empty**, which is what excludes the message being
  generated from its own prompt — `assemble` skips blank content, so no splicing.
- **regenerate ≠ swipe.** Regenerate replaces the reply and drops its alternates; swiping
  right past the end appends one and keeps them. Swiping within the array is cached and
  generates nothing. Swipe-left at index 0 is a no-op — no wraparound.
- A failed generation must undo exactly what starting it did, or debris accumulates: an
  empty send removes the placeholder, an empty swipe removes the swipe (otherwise every
  network hiccup leaves a blank alternate), an empty regenerate restores the original.
- The selection cannot move while generating. A reply is written into whichever swipe is
  selected when it settles.
- **Streaming text never enters React state.** It lives in `streamStore` and reaches one
  leaf via `useSyncExternalStore`, so a sixty-second reply produces three or four actions
  instead of eighteen hundred — and a tick has no path to the database at all.
- The accumulator returns the **full** text every frame, never a delta. Consumers assign
  rather than append, which is what makes dropping throttled frames safe.
- `dispatch` does not update a ref synchronously. Code that needs the post-dispatch state
  folds the action through the reducer itself; reading a ref back sees the old state.

**Providers** (`shared/providers/`)
- `stop` must be **absent**, not `undefined` or `[]` — several backends 400 on an empty
  array. Assert with `Object.hasOwn`; `toEqual` passes on `undefined` and hides it.
- `seed` only when `>= 0`. Zero is a real seed, so the guard cannot be truthiness.
- `top_k` / `min_p` / `top_a` / `repetition_penalty` are **OpenRouter-only**. A plain
  OpenAI-compatible endpoint may reject the whole request over them.
- A null key produces **no** `Authorization` header. `Bearer null` makes llama.cpp and
  KoboldCpp reject a request they would otherwise serve.
- OpenRouter nests `provider: {order, allow_fallbacks, quantizations}` — `order`, not
  `only`, and `allow_fallbacks` inside `provider`. Usage is `usage: {include: true}`, not
  OpenAI's `stream_options`.
- OpenRouter sends `: OPENROUTER PROCESSING` keepalive comments. A parser that treats
  them as malformed frames kills the stream.
- The server pipes `upstream.body` through untouched and forwards the client's
  `AbortSignal` upstream. Without that forward, Stop only closes the browser socket while
  the provider keeps generating — and keeps billing.

### Deliberate divergence from SillyTavern

`migratePreset` evaluates **all** migration rules for a key before deleting it. ST's own
loop deletes the key when it processes the first rule mentioning it, so later rules for
that key never run (`openai.js:4199-4210`) — silently dropping `image_inlining: true` and
every `openrouter_sort_models` value except `alphabetically`. Ours produces the intended
result. Safe: we write the modern key either way and ST ignores the legacy one.

**A failed regenerate restores the original message and its alternates.** ST destroys the
swipe array *before* generating (`script.js:4340-4353`), so a 429 or a stray Stop loses
every alternate permanently. Costs two lines to avoid.

**Real token usage is available, opt-in.** ST never requests it — all its counts are
client-side tokenizer estimates. Ours falls back to the estimate when the provider says
nothing. Off by default for `custom`, since some proxies reject unknown top-level keys
for exactly the same reason they reject `stop: []`.

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
  overrides, names_behavior, squashing and continue with a one-token-per-word counter.
- `shared/chat/message.test.ts` proves the swipe invariant survives arbitrary action
  sequences, including a `mes` that disagrees with its slot.
- `shared/providers/sse.test.ts` is where streaming correctness lives: frames split
  mid-JSON, all three line-ending conventions, keepalive comments, usage-only chunks, and
  that the accumulator returns cumulative text rather than deltas.
- `src/features/chat/state/chatReducer.test.ts` covers the failure paths — a failed
  overswipe leaving no blank swipe, a failed regenerate restoring the alternates.

When touching a format, add the test before the code.

## Status

Done: layout shell, PNG codec, card format + editor, preset format + Prompt Manager
(drag-reorder, markers, depth injection), assembly engine, macros, providers (custom
OpenAI-compatible + OpenRouter), SSE streaming, chat storage (SQLite), multiple chats per
character with branching, swipes/regenerate/continue/edit/delete/hide, prompt inspector,
real tokenizer.

Not built yet: World Info activation engine, personas, impersonate.

Out of scope for V1: group chats, Author's Note, instruct mode, extensions, image
generation, TTS, local models.
