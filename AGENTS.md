# WackChatter

A lightweight chat frontend for cloud LLMs, **data-compatible with SillyTavern**: character
cards and chat-completion presets move between the two apps untouched. Chats and app
settings are ours and deliberately not portable. The app is not in use by anyone yet, so
compatibility of *our own* stored formats is not a concern.

Bun (server) + React 19 + TypeScript + Vite (client). Desktop only. A read-only
SillyTavern reference copy lives at `Documents/Github/SillyTavernSource` (format research
only; we reimplement, we do not copy).

## Commands

- `bun run dev:server` — API on **8787**, hot-reloaded.
- `bun run dev:client` — Vite on **5173**, proxies `/api` to 8787. This is the URL you open.
- `bun run build` — typecheck (`tsc --noEmit`) then Vite build to `dist/`.
- `bun run start` — production: serves `dist/` + API on one port, opens the browser.
- `bun test` — all tests. `npx tsc --noEmit` for types. `bun run lint` for Biome.

`WC_PORT` overrides the API port, `WC_DATA_DIR` the data directory, `WC_NO_OPEN=1` stops
the browser launching. `WC_DATA_DIR` beats the pointer file and locks the setting in the UI.

## Layout

```
server/          Bun. Thin: files, DB, streaming proxy. Never builds a prompt.
  lib/png.ts     PNG chunk parse/encode + CRC32 + tEXt. Pure TS, no deps.
  lib/card.ts    Card read/normalise/merge/write.
  lib/paths.ts   Data dirs, filename sanitising, traversal guards.
  lib/folders.ts Character folders as real directories. Identity stays flat — see below.
  lib/location.ts / transfer.ts / relocate.ts   Data dir pointer, verified moves, live relocate.
  lib/db.ts      bun:sqlite connection + schema.
  lib/chats.ts   createChatStore(db) — the whole persistence boundary.
  lib/secrets.ts API keys. Mode 0600. Never leaves the machine.
  lib/generate.ts The one place that calls a provider.
  lib/lorebooks.ts / personas.ts / cocreator.ts  Standalone books; personas; design sessions.
  lib/stats.ts   Library statistics, aggregated in SQL. Built per request, never memoised.
  lib/arena.ts   Blind benchmark rounds. Write-once rows; no ratings table, by design.
shared/          Pure, no I/O. Imported by both server and client.
  chat/          MessageState — the swipe invariant, as a type.
  cocreator/     CardStash — the filed-card model.
  prompt/        Assembly engine, macros, preset I/O, defaults, token cache.
  providers/     Request building + SSE parsing.
  regex/         User regex scripts: engine, depth, import/export. Macros are injected.
  worldinfo/     Lorebook conversion + the activation engine.
  types/         Card, preset, worldinfo, chat, settings, regex, cocreator, stats, arena.
src/             React app.
  layout/        AppShell — the three-column grid.
  features/      character/, preset/, chat/, connection/, lore/, persona/, studio/,
                 cocreator/, stats/, arena/.
  lib/revisionQueue.ts  The revision-aware save queue. Chat and the Co-Creator both bind it.
data/            Gitignored. characters/**/*.png, presets/*.json, chats.db, settings.json,
                secrets.json, lorebooks/, personas/, backups/, .wackchatter.
                The default location, not a fixed one — see "The data directory moves".
```

**Prompt assembly runs client-side**, like SillyTavern; the server only proxies. This keeps
the server dumb, lets the Prompt Manager show live per-prompt token counts, and makes the
"what was sent" inspector show the wire payload rather than a reconstruction.

**Connection settings are ours, not the preset's.** Connections live in `data/settings.json`
(`connections` list + `connectionId`; null = first), keys in `data/secrets.json` keyed by
connection id, never reaching the browser. The list mutates only through the
per-connection endpoints — `mergeSettings` pins it, so a stale tab or `{"connections": null}`
cannot delete connections. **The key belongs to the endpoint** (provider + baseUrl), not the
entry: a PATCH changing either drops the key, and `/settings/test` attaches the stored key
only when the probed endpoint matches the stored one. Ids are opaque, names editable;
nothing references a connection by name. A preset's own connection keys (`custom_url`,
`openrouter_model`, `chat_completion_source`) round-trip untouched but are never read, so
an imported preset cannot repoint your endpoint. `showReasoning` / `reportUsage` are
per-connection, edited from the Generation panel, write-through.

## The data directory moves

`<repo>/data` is the default, not a fixed location; the user can relocate the library from
User Settings and the server repoints itself without restarting. Three invariants:

1. **`PATHS` is a live view, never a snapshot.** `setDataDir` rewrites one object in place,
   so ~60 call sites follow a move untouched. Never destructure `PATHS` or capture
   `PATHS.x` into a module-level const. `server/lib/paths.test.ts` pins the object
   identity.
2. **Anything memoised from `PATHS` needs a reset wired into `quiesce()`** — today the db
   handle (`db.ts`), chat store (`chats.ts`, resets first — prepared statements) and
   settings cache (`settings.ts`). Fixing an anchor to something that never moves (e.g.
   `blankAvatarCache` → `PROJECT_ROOT`) deletes the obligation; prefer that to adding one.
3. **The pointer write is the commit point**, immediately after the last operation that
   changes where the data physically is. Before it, unwind. After it, never unwind —
   report the failure and ask for a restart.

Supporting rules: the database moves as one file (`closeDatabase()` checkpoints with
`TRUNCATE` and leaves WAL — a `-wal` with content is never deleted); a synced folder gets
`journal_mode = DELETE`. `lib/backgrounds.ts` refuses caller-supplied directories while
relocation accepts them — one policy; read the comments in both places before relaxing
either.

## Format rules that must not be broken

Verified against SillyTavern's source and pinned by tests. Breaking any of them corrupts
users' libraries silently.

**Character cards** (`server/lib/card.ts`)
- PNG carries two `tEXt` chunks before `IEND`: `chara` (V2) and `ccv3` (V3), each
  `base64(utf8(JSON))`, keyword match case-insensitive. **Read precedence is `ccv3` over
  `chara`; write both.**
- Fields live at the top level (V1 legacy) and under `data.*`; `syncLegacyMirror` keeps
  them in step.
- **Unknown keys must survive.** `mergeCardData` merges onto the parsed original rather
  than rebuilding from a field list — that is how V3-only and third-party keys survive an
  edit, in both apps.
- The card's `avatar` field is vestigial. **The PNG filename is the identity, and a folder
  is never part of it**: paths resolve by searching the tree (`resolveCharacterFile`), so
  a move is a plain `rename(2)` with no reference cascade — chats, dialogue colours and
  backups all key on the bare filename. Consequence: names are unique library-wide. Same
  reasoning as the persona rule — an id something else stores must not change for a
  cosmetic reorganisation.
- Anything walking `data/characters` must **recurse** — a flat `readdirSync` silently
  skips every foldered card.
- Always emit `character_book.extensions`, even as `{}`.

**Presets** (`shared/prompt/preset-io.ts`)
- `enabled` lives on the **prompt order entry**, not the prompt object; `Prompt.enabled`
  is never read.
- The live prompt order is `character_id: 100001`. A `100000` entry is legacy — preserve
  untouched, never read from it. `prompt_order[].order` array order **is** the UI list
  order; there is no sort key.
- Serialise as `JSON.stringify(preset, null, 4)` with **no trailing newline**. All 12
  built-in prompts must be present. Marker prompts carry no `content` on disk. Unknown
  keys are preserved on save.

**Assembly** (`shared/prompt/assemble.ts`)
- Macros substitute **per prompt object and per message at materialisation time**, never
  one pass over a joined string; `{{random}}` re-rolls per occurrence and token counts
  are only right post-substitution.
- Budget is `openai_max_context - openai_max_tokens`. History packs **newest-first** and
  stops hard at the first message that doesn't fit.
- `injection_position: ABSOLUTE` splices into history at `injection_depth` (0 = after the
  last message). Ties at one depth read **low→high `injection_order`**, within one order
  assistant→user→system, toward the model's last word — a higher order sits closer to the
  end. This is SillyTavern's ordering (`populationInjectionPrompts` in `openai.js`); tuned
  presets must read the same in both apps.
- A card's `system_prompt` / `post_history_instructions` override `main` / `jailbreak`
  unless the prompt sets `forbid_overrides`. `is_system` on a message means hidden from
  the prompt, still shown in the transcript.
- `continue` reshapes the finished array: `continue_prefill` moves the partial reply to
  the very end, otherwise `continue_nudge_prompt` is appended. `continue_postfix` is the
  join, and the client's stream seed must use the same one.

**Regex scripts** (`shared/regex/`) — ST's format; imported scripts round-trip
byte-identically. The quirks are load-bearing and each has a named test.
- `markdownOnly` / `promptOnly` mean "runs during" the transcript / outgoing prompt (both
  → both; **neither → ST's destructive chat-file rewrite**, which has no call site here —
  inert by construction). `runOnEdit` is preserved, never read. The editor's "Affects"
  select maps to the pair.
- **A bare find pattern gets no flags** — `foo` replaces the first match; you need
  `/foo/g`. Invalid flags don't error: the whole original string, slashes included,
  becomes the pattern.
- Only `$N` and `$<name>` are capture references (`{{match}}` becomes `$0` first);
  `trimStrings` apply to substituted captures only, never to surrounding literal text.
- Depth bounds are inclusive, 0 is the newest message, `null` unlimited — as is a bound
  below its own floor (`minDepth < -1`, `maxDepth < 0`). Blank and `is_system` messages
  hold no depth slot: generation appends an empty placeholder before assembling.
- Regex runs **after** macro substitution, and emptiness is checked after regex — an empty
  replacement drops the message from packing. Macro expansion is injected, not imported
  (keeps `shared/regex/` a leaf): the prompt path passes assembly's runtime so
  `{{setvar}}` in a replacement really writes; the display path gets a disposable one.
- All four `assemblePrompt` callers must pass the same list (useChat generate, useChat
  summarise, usePromptPreview, useArenaRun) — miss one and token counts and the inspector
  silently disagree with what shipped.
- Not wired: `SLASH_COMMAND` / `WORLD_INFO` placements, character-embedded
  `regex_scripts`, mid-stream application. Never enable `rehype-raw` in `Markdown.tsx` —
  model HTML must stay escaped text.

**Guided generations** (`shared/prompt/assemble.ts`, `GuidesPopover.tsx`)
- Guidance is a `DepthInjection` spliced at `guidance.depth` (default 0), never a
  transcript message. `{{input}}` rides the macro engine's `extra` hook — one pass,
  exactly once, and macros the user typed stay literal. It exists only as an argument to
  `generate`: nothing to leak into the next generation or clean up on failure.
- Guided response is mode `send` without a user message; guided swipe bypasses
  `swipe()`'s cached-alternate branch. Neither touches the reducer, so both settle through
  the existing undo table. The composer does not clear on a guided action.
- Persistent guides live in `ChatMetadata.guides` (id opaque, name editable). Each
  enabled non-blank guide is its own injection. Guides and guidance are pushed **last**
  into `depthInjections`; `tokenCounts.guides` / `.guidance` are their own keys.

**Messages** (`shared/chat/message.ts`)
- **`mes` is derived, never stored**: text from `swipes[swipe_id]`, metadata from
  `swipe_info[swipe_id]` — no `mes`/`send_date`/`extra` to keep in step.
  `fromChatMessage` is the only repair point (DB row, greeting import); on disagreement
  `mes` wins. `swipe_info` is always exactly `swipes.length`.
- A user message records the persona it was sent as (`persona_id`): null = sent with no
  persona, missing = legacy — in storage NULL for "not recorded" and `''` for explicit
  none; the two must not collapse. `chat/loaded` stamps legacy messages with the chat's
  persona; rendering resolves each row's speaker, falling back to the chat persona only
  for the not-recorded case.

**Generation** (`src/features/chat/state/chatReducer.ts`)
- A placeholder's text starts **empty** — that is what excludes the generating message
  from its own prompt.
- **regenerate ≠ swipe.** Regenerate replaces the reply and drops its alternates;
  overswipe appends and keeps them; swiping within the array is cached and generates
  nothing; swipe-left at index 0 is a no-op. A failed generation must undo exactly what
  starting it did: failed send removes the placeholder, failed swipe removes the blank
  alternate, failed regenerate restores the original.
- The selection cannot move while generating; a reply lands in whichever swipe was
  selected when it settles. `dispatch` does not update a ref synchronously — fold the
  action through the reducer when you need post-dispatch state.
- **Streaming text never enters React state** — it lives in `streamStore`, reaching one
  leaf via `useSyncExternalStore`. The accumulator returns the **full** text every frame,
  never a delta. Live emphasis comes from `streamSegments`, a linear segmenter not a
  parser; the settled markdown render stays authoritative.

**Providers** (`shared/providers/`)
- `stop` must be **absent**, not `undefined` or `[]` — several backends 400 on an empty
  array (assert with `Object.hasOwn`; `toEqual` hides it). `seed` only when `>= 0` — zero
  is a real seed, so no truthiness guard.
- `top_k` / `min_p` / `top_a` / `repetition_penalty` are **OpenRouter-only**. A null key
  produces **no** `Authorization` header.
- OpenRouter: `provider: {order, allow_fallbacks}` (not `only`), usage via
  `usage: {include: true}` (not `stream_options`), and `: OPENROUTER PROCESSING`
  keepalive comments must not kill the stream.
- **Anthropic on OpenRouter thinks only for an explicit `reasoning.max_tokens`.** We size
  the budget ourselves (floor 1024, cap 128000 — 21333 when not streaming), added **on
  top of** the reply budget so `max_tokens` exceeds it by construction, and delete
  `temperature` / `top_p` / `top_k` (Anthropic rejects them while thinking) plus `min_p` /
  `top_a` / `repetition_penalty`.
- The server pipes `upstream.body` through untouched and forwards the client's
  `AbortSignal` upstream — without the forward, Stop keeps the provider generating and
  billing.

**World Info** (`shared/worldinfo/`)
- `character_book` (embedded, `entries` is an **array**) and a standalone book (`entries`
  is an **object keyed by uid**) differ structurally and by field name:
  `key`↔`keys`, `keysecondary`↔`secondary_keys`, `order`↔`insertion_order`,
  `disable`↔`!enabled`. **Everything else lives in `entries[i].extensions`**, including
  the camelCase `useProbability` and `selectiveLogic` — they look like typos; they are not.
- ST writes `use_regex: true` unconditionally and degrades `position` at the top level;
  **`extensions.position` wins on read**. `originalData` holds the book as parsed;
  `toCharacterBook` rebuilds each entry from its original before overwriting mapped
  fields (that carries unknown top-level keys) and is never emitted into a
  `character_book`. `nextUid` is `max + 1` over live entries **and** `originalData` —
  reusing a freed uid grafts the deleted entry's unknown keys onto a new one.
- Never iterate `book.entries` order-sensitively (numeric keys iterate numerically, so
  `"2"` precedes `"10"`) — use `bookEntries()`.
- `order` is a **weight** (ties legal, higher = closer to the chat); `displayIndex` is a
  **permutation** (editor list order). Dragging rewrites `displayIndex` only. Emitted
  blocks sort ascending with the highest `order` last.
- The scan buffer joins messages newest-first with `\n\x01` **and starts with `\x01`** —
  the head sentinel is load-bearing for whole-word matching.
- `vectorized: true` **excludes** the entry; `sticky`/`cooldown`/`delay` only ever
  suppress — carried, unread.
- The client never sends the server a whole `character_book`: `mergeCardData`'s spread is
  shallow and replaces it wholesale; the per-uid endpoints exist so a stale tab cannot
  write a mass deletion.

**Personas** (`server/lib/personas.ts`)
- A lorebook's filename **is** its name (cards link via `extensions.world`, so renaming
  is a file move). A persona's filename is an **opaque id** with an editable `name` —
  `ChatMetadata.persona` stores the id, so a typo fix must not orphan chats. Opposite
  rules, on purpose ("the persona rule" referenced throughout this file).
- **One current persona, and the chat wins.** A pick anywhere sets both
  `AppSettings.personaId` and the open chat's `ChatMetadata.persona`; loading a chat
  adopts its recorded persona (`adoptedPersona` in `chatInit.ts`). Settings follow the
  chat, never the other way — a transcript records who you were when you wrote it.
- **Names are free to collide**, since the id is the identity. Nothing may resolve a
  persona by name without handling ambiguity: `matchPersonaByName` (`personaRoster.ts`)
  returns exact → prefix → substring and stops at the first rung with *any* match, so two
  personas called "Wren" is an error naming both, never a guess. `/persona` reports it and
  keeps the draft — a wrong guess would be stamped onto every message sent afterwards.
- `AppSettings.recentPersonaIds` orders both the composer's switcher and the panel's
  roster, newest first, capped at `MAX_RECENT_PERSONAS`. The cap is enforced in
  `server/lib/settings.ts` on read *and* on patch, because the list is appended to on every
  switch and nothing else prunes it. It is convenience only — `orderPersonas` drops ids it
  cannot resolve — but `cascadePersonaDelete` still removes a deleted persona's slot, or a
  dead id would starve a live persona out of the capped list.

### Deliberate divergences from SillyTavern

- `migratePreset` evaluates **all** migration rules for a key before deleting it (ST's
  loop drops later rules for the same key).
- A failed regenerate restores the original message **and its alternates**; ST destroys
  the swipe array before generating.
- Real token usage is opt-in (`reportUsage`), falling back to the estimate when the
  provider says nothing; off by default for `custom` — some proxies reject unknown keys.
- Unsupported World Info positions fold into before/after, flagged in the inspector,
  rather than being dropped.
- The activation engine substitutes no macros — assembly does, exactly once. Cost: the
  World Info budget is measured pre-substitution.
- `use_regex` is written but ignored on read; a key is regex iff it parses as a
  `/…/flags` literal.
- World Info randomness is seeded on `chatId` + the last **user** message id, so
  regenerate/swipe/continue see identical lore. A draw is **skipped, not consumed**, for
  an entry that was never going to roll. Only admitted entries feed recursion.
- Only `{{...}}` is reported as an unresolved macro — everything else in angle brackets
  is ordinary prompt text (presets are full of `<POV>`-style markers).

### Replicated ST quirks — do not "fix"

Both look like bugs; both are kept because books were authored against them, and both
have named tests. Per-entry `matchWholeWords` and regex keys are the escape hatches.

- A multi-word key skips whole-word matching entirely and becomes a substring test —
  `red dragon` matches inside `bored dragonfly` (`world-info.js:349`).
- The boundary regex uses `\W` with no `u` flag, so every non-Latin letter counts as a
  word boundary — Cyrillic, Greek and CJK keys effectively lose whole-word matching.

## UI conventions

- **The four sub-apps replace the chat shell** — they are not modals or panels, they
  share one shell skeleton, and all four are reached only from the Start screen. The
  Studio is manual, the Co-Creator conversational, Stats read-only, the Arena a test bench;
  Finish hands off from the Co-Creator to the Studio one-way with no path back. Entering
  any of them flushes the save queue first and a failed flush aborts the transition rather
  than hiding unsaved work — for Stats that is also what makes the numbers right, since a
  chat still in the queue is one the server has not been told about. Only the two creator
  areas register persistence; Stats and the Arena have nothing of their own to flush on the
  way out.
- **In the Co-Creator the model never writes a field** — it proposes in labelled fenced
  blocks and every slot got there via "Use as". Two tested invariants: everything the
  model sees is in the readable transcript (the stash never reaches a prompt), and block
  affordances appear only on a settled message. Its re-roll is an overswipe — appends a
  take, never displaces (`resumeSwipeId` restores the reader on failure); do not add a
  destructive regenerate. Its streaming is its own setting
  (`AppSettings.coCreator.streaming`, default true), not the preset's.
- **The session's avatar column is revision-free; `finishedAvatar` is not.** The avatar
  endpoints write it through `setSessionAvatar` with no revision bump — the whole-session
  save preserves the column, so the two write families commute and a bump would collide
  with the client's own next revision (the Finish "Session changed elsewhere." bug; pinned
  by tests). The client's `avatar/set`/`avatar/cleared` likewise cost no revision: the
  server write is already durable when the response dispatches. `finishedAvatar` is a real
  document field — it rides the whole-session snapshot, which is the only way Finish's
  recording reaches the server.
- **No blocking modals.** Destructive actions use a two-click confirm in place. Disabled
  beats refused: a blocked entry is `disabled` with a `disabledReason` that becomes its
  `title` — no toast system.
- All colour, spacing, sizing and motion comes from `src/styles/tokens.css` — components
  hardcode none of it. Glass is token redefinition on `.shell[data-glass]`; the scrim,
  blur and `@supports`/`prefers-*` fallbacks are legibility requirements, not polish; and
  `backdrop-filter` goes on the bar and panels only, never on message bubbles (scroll
  recomposite). Built-in backgrounds are bundled SVG assets, never seeded into
  gitignored `data/`.
- Panels are **multi-destination, routed by a panel id** — not an open/closed boolean
  plus a tab (a boolean and a tab can disagree; an id cannot). Closing a side unmounts
  its panel and flushes pending autosaves like switching does (`flushRightPanel` is what
  makes a failed flush surface). Bar buttons are toggle buttons (`aria-pressed`), not
  tabs. The chat column is `1fr`; the header row is a fixed grid track so
  `grid-template-columns` stays the only animated property.
- **The composer is a field with a tray under it**, not a row of controls around a field.
  The field keeps the full measure; everything else — persona chip, menus, guided actions,
  Send — sits in a `--wc-control`-height tray beneath. Two consequences. The tray is the
  composer's *fixed* end (the dock is `flex-shrink: 0`, so the field grows upward and the
  tray never moves while you type), and the tray's height comes out of the input's growth
  budget: `MAX_VIEWPORT_SHARE` is a ceiling for the whole composer, so `composerGrowth.ts`
  subtracts a *measured* `trayBlock` rather than a constant. Charging the share to the
  input alone lets the composer exceed it by exactly the tray's height.
  `--wc-composer-row` no longer aligns anything to the input's baseline — it is the input's
  `min-height` and, through that, the one-row floor the clamp refuses to go below.
- **Presets save explicitly, characters autosave.** Editing a preset raises a Save/Revert
  bar and locks switching/rename/import until resolved; Revert re-reads the file, the
  only authority on what the preset was. The preset draft lives above the left panel's
  router (`usePresetDraft` in `App`) so the bar survives panel switches.
- An editor takes over its panel (with a back button), never appends below the list. One
  lorebook editor serves both standalone books and embedded `character_book`, persistence
  via callbacks — two copies would drift invisibly.
- `NumberField` / `SelectField` / `TriCheckField` are shared for real reasons
  (unclearable numbers, index-mapped numeric selects, `T | null` "inherit" tri-states).
  `TagField` is **not** safe for World Info keys — `/foo,bar/i` is one legal key; use
  `KeyField`.
- **`Popover` is the only popup mechanism**; `Menu` is its data-driven variant (entries as
  data keeps builders like `buildChatMenu` pure and testable). Focus calls inside popups
  pass `preventScroll: true`; submenu flyouts are `position: fixed` to escape the menu's
  scroll container.
- Slash commands are typed, parsed in `slashCommands.ts` before `chat.send`: only text
  starting with `/` is a command, and a command-shaped line that fails to parse is an
  **error, never a silent send**. Indexes/ranges are zero-based and inclusive, matching
  ST. `/hide` is an atomic single-revision set. Commands are blocked while a reply or
  summary runs; autocomplete is the discovery path.
- Quick commands are normalised app settings (id opaque, name editable) reachable only
  from the burger menu; picking one fills the composer and is not gated on `busy`. The
  composer's draft has exactly one write path: `ComposerHandle.insert`.
- Error boundaries wrap the root and each shell region (left panel, chat, right panel).
  `lib/crashReport.ts` is pure and tested because it runs in the failure path on values
  that may not be Errors.

**Stats** (`server/lib/stats.ts`, `src/features/stats/`)

- Counting happens in SQL and the client is sent ids and numbers, never display names —
  those resolve against the lists `App` already holds, so a deleted card falls back to its
  raw id instead of dropping out of its own history. Nothing is denormalised: there is no
  stats table, so a figure cannot drift from the transcripts it summarises.
- **Rerolls exclude `position 0`.** A card's alternate greetings arrive as swipes on the
  first message, so a naive `swipes − messages` reports rerolls the user never made — on a
  real library that was 131 against 50 actual. Named test.
- **The server sends UTC hour buckets and the client folds the calendar.** `send_date` is
  UTC and so is SQLite's `date()`, so bucketing days server-side files a 23:30 session under
  tomorrow, and a fixed client offset is wrong across a daylight-saving change. Day
  stepping is by calendar date, never `+ 86400000`.
- `extra.token_count` is **completion tokens only**, frequently our own estimate. It is
  labelled "generated" and **must never be presented as a cost** — there is no prompt-token
  history to build one from. `extra.api` is a `ProviderId`, not a connection, and old rows
  carry `'openai'`; render an unrecognised provider verbatim rather than dropping the row.
- Every chart animation ships its paired `prefers-reduced-motion` block, and the count-up
  hook checks `matchMedia` itself — a JS animation is not covered by the token overrides.
  It also completes on a hidden document, so the numbers match the CSS animations beside
  them rather than stranding at zero.

**Model Arena** (`server/lib/arena.ts`, `src/features/arena/`)

- **Assemble once, send N times.** `useArenaRun.start` calls `assemblePrompt` a single time
  per run and every column gets the same `messages` array; only `buildRequestBody` runs per
  contender. This is the fairness invariant the whole sub-app rests on — identical history
  packing, identical World Info draws, identical `{{random}}`/`{{pick}}` rolls. Bodies still
  differ in provider-specific samplers, which is unavoidable and correct. A per-column
  re-roll re-sends the run's *cached* messages for the same reason.
- **No ratings table.** Rounds are stored write-once and the leaderboard is replayed from
  them in `created` order on every render, so a rating cannot drift from the history behind
  it and `K_FACTOR` can change without invalidating anything. Same rule as Stats. `bad`
  ("neither is usable") is recorded but moves **no** ratings — it is not a draw, and scoring
  it as one would drag a strong rating toward a weak one on evidence containing no
  comparison. Named tests.
- Ratings under `PROVISIONAL_ROUNDS` rank **below** established ones however high the number
  goes; sorting on rating alone would let a lucky two-round entrant read as a verdict.
- `replay` returns the table AND a per-round series for the chart from **one** walk. Two
  walks would be two implementations of the same Elo loop, free to drift — the exact thing
  the no-ratings-table rule exists to prevent. Every series covers every round, backfilled
  at `START_RATING` for a contender that joined late, so the lines can be read against one
  another. A `bad` round still takes a slot on the axis and moves nothing.
- **Only blind rounds are scored.** The open Arena writes nothing — a comparison where you
  knew which one was which is not evidence.
- **The blind is a real blind.** While masked, nothing identifying reaches the DOM: no name,
  model, provider, reasoning text or timings, and by default no streaming either, because
  token cadence identifies a model as surely as a label. `hold` withholds a *settled* reply
  too, or the first column to finish would reveal itself by finishing.
- Deleting a contender never cascades into rounds. An id the pool can no longer resolve
  falls back to the model string recorded on the round — the Stats rule, and the reason
  `RoundSide` stores the model and provider as facts rather than display names.
- Pairing is **least-played**, not uniform: uniform draws re-decide settled matchups while
  two entrants never meet, so a leaderboard stays provisional long after the rounds were
  paid for. Side assignment is a per-round coin flip, or position bias binds to one
  contender for the whole history.
- A run waits for `useLorebooks().pending` to clear. The chat never needed that flag — a
  human is typing — but a blind round generates with nobody in the loop, and one that ran
  before the card's linked book arrived would benchmark against lore a real chat would have
  supplied.

## Testing

`bun test`. Every rule above is pinned by a test next to the code it governs — the
heaviest gates round-trip real artefacts (`server/lib/card.test.ts` byte-for-byte against
the real Seraphina PNG, `shared/prompt/preset-io.test.ts` against ST's shipped
`Default.json`, `shared/worldinfo/convert.test.ts` against Seraphina's embedded book) and
`server/lib/location.test.ts` / `transfer.test.ts` / `paths.test.ts` gate the
data-directory rules, including the in-place `PATHS` rewrite. **When touching a format,
add the test before the code.**

There is no DOM test harness — keep logic in pure functions (builders, matchers,
reducers) so React wrappers stay thin.

`paths.ts` is module state shared by the whole `bun test` process: any test that repoints
it must put it back or the failure lands in an unrelated file.

One trap from `src/lib/autosave.test.ts`: **an editor must never own its revision
counter** — ask the queue (`nextRevision`). A locally counted counter resets under the
queue's per-entity high-water marks and later edits are rejected as stale: unsent, no
timer armed, `isDirty` false, `flush` unable to rescue them.
