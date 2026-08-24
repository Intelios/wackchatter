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

**After editing server SQL, restart `dev:server`.** Bun's `--hot` re-runs module code but a
long-running server keeps serving the memoised chat store's *old* prepared statements — a
changed `summarySelect` ships the old summary shape until restart (observed with
`branchedFrom`: every branch was recorded, none of them reached the timeline).

## Layout

```
server/          Bun. Thin: files, DB, streaming proxy. Never builds a prompt.
  index.ts       Loopback-gated server; dispatches to one handler per resource in routes/.
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
  chat/          MessageState — the swipe invariant; branch.ts — branch-time id repair.
  cocreator/     CardStash — the filed-card model.
  memory/        Id-based memory list ops + the extraction prompt and reply contract.
  persona/       derive.ts — card-to-persona: the prompt, the reply contract, the house format.
  prompt/        Assembly engine, macros, preset I/O, defaults, token cache.
  providers/     Request building + SSE parsing. looseJson.ts is shared by both extractors.
  regex/         User regex scripts: engine, depth, import/export. Macros are injected.
  worldinfo/     Lorebook conversion + the activation engine.
  types/         Card, preset, worldinfo, chat, settings, regex, cocreator, stats, arena.
src/             React app.
  layout/        AppShell — the three-column grid.
  features/      character/, preset/, chat/, connection/, lore/, persona/, studio/,
                 cocreator/, stats/, arena/, memory/, regex/, settings/, start/, summary/.
                 arena/ splits its rules out as pure modules: elo.ts (replay + verdict
                 preview), matchups.ts (head to head), series.ts (corner colour),
                 runStats.ts (which column won each measure), pairing.ts, chart.ts.
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

**Story memory** (`shared/memory/`, `src/features/memory/`, `src/features/summary/`)
- **One story-memory slot, three modes** (`AppSettings.memoryMode`): `'classic'` rolling
  summary, `'memories'` discrete recalls, `'off'`. A chat may carry both
  `metadata.summary` and `metadata.memories`, but assembly injects one or neither —
  never both, which would tell the model the same events twice in two voices.
- **Memories are id-based, never index-based** (`Memory.range` names message ids;
  indices shift under delete, branch and swipe). `memoryWatermark` (last covered
  message) is the extraction checkpoint — the counterpart of
  `summary.checkpointMessageId`.
- **The extractor never sees a global message index and never names a destructive
  action.** It is shown a window numbered from zero and answers in those local numbers,
  mapped to real ids in `extract.ts`. Which messages get hidden is derived from the
  ranges it wrote, by code — a malformed reply can produce a bad memory but cannot hide
  the wrong thing. Extraction (`useChat.extractMemories`) builds its own request: no
  `assemblePrompt`, no preset prompts, no jailbreak. It checkpoints after every window
  and never overwrites a memory the user edited (`edited`). `autoHide` — the one
  destructive switch — is always read live from saved settings, never a panel snapshot.
- **Recall is the activation engine.** A memory's keywords become `WorldInfoEntry.key`
  (so `/pattern/flags` keys work exactly as in a lorebook); `pinned` becomes `constant`.
- **Hiding carries provenance.** A memory hides its covered range minus the verbatim
  tail (enforced in `hideableMessageIds` — recent prose stays word-for-word) by setting
  `is_system` + `hiddenBy`. A memory may only reveal what it stamped: a manual hide
  survives its deletion, and one memory cannot reveal another's hides. Editing a
  message marks covering memories `stale` (`markMemoriesStale`).
- **Branching repairs the ids** (`shared/chat/branch.ts`). A branch copies the prefix
  with fresh message ids, so `remapBranchMetadata` rewrites every range, the watermark
  and the summary checkpoint onto the branch's ids, clamps ranges that straddle the
  fork, and drops memories written from transcript past it. `branchedFrom.messageId`
  still names the parent's message, on purpose.
- Classic summarising chunks the backlog with estimate-then-verify packing
  (`packClassicSummaryChunk`): one cheap token walk picks a prefix, a few full
  assemblies verify it, and the accepted assembly is returned verbatim so dynamic lore
  and macros are not rerun.

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
- The client never sends the server a whole `character_book` *when editing an established
  card*: `mergeCardData`'s spread is shallow and replaces it wholesale; the per-uid endpoints
  exist so a stale tab cannot write a mass deletion. The one exception is the Co-Creator's
  Finish for a seeded session, which copies the seed card's book onto a card it created
  seconds earlier in the same flow from a fresh read — there is no established card to
  clobber, so the hazard the rule exists for cannot occur (`finish.ts`).

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
- **The derived persona's house format is one `Label: value` line per fact, a blank line
  between, appearance and identity only.** `renderPersonaDescription` (`shared/persona/derive.ts`)
  is the one place it is written and `derive.test.ts` pins it — deliberately against the
  *normalised* form, not byte-for-byte against `data/personas`, whose hand-edited files carry
  incidental trailing whitespace. Labels are a closed, ordered vocabulary; a synonym is
  rewritten to our spelling, a prose label (`Personality`, `Backstory`, `Scenario`) is
  dropped, and at most three unknown labels survive, after the known block.
- **The derivation omits, never infers.** A fact the card does not state gets no line. The
  contract asks for that, and the parser *also* drops `unknown` / `N/A` / `—` values — prompt
  compliance must not be the only thing between the user and an invented age, because a
  persona rides in every request and a wrong fact there reads as true forever. The converter
  writes nothing until Save, so a bad roll leaves no persona behind; `scenario` is never sent,
  since a persona outlives the story it was derived from.
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

- **The four sub-apps replace the chat shell** — not modals or panels; all four are
  reached only from the Start screen. The two creator areas hand off to each other in both
  directions: Finish leaves the Co-Creator for the Studio opened on the card it produced,
  and the Studio workbench's "Design with an assistant" enters the Co-Creator seeded from
  the open card (the library's button still starts a blank session). Entering any of them
  flushes the save queue first and a failed flush aborts the transition rather than hiding
  unsaved work (for Stats that is also what makes the numbers right). Only the two creator
  areas register persistence.
- **In the Co-Creator the model never writes a field** — it proposes in labelled fenced
  blocks and every slot got there via "Use as" or arrived with the Studio seed
  (`provenance.source: 'seed'`). Everything the model sees is in the readable transcript
  (the stash never reaches a prompt; the seed card arrives as a visible opening user turn —
  `seed.ts`, dispatched with `session/loaded` so it survives StrictMode and never re-seeds
  a session the user has emptied); block affordances appear only
  on a settled message. Its re-roll is an overswipe — appends a take, never displaces;
  do not add a destructive regenerate. Its streaming is its own setting
  (`AppSettings.coCreator.streaming`, default true), not the preset's.
- **The session's avatar column is revision-free; `finishedAvatar` is not.** The avatar
  endpoints write through `setSessionAvatar` with no revision bump — the whole-session
  save preserves the column, so the two write families commute (a bump would collide
  with the client's own next revision; pinned by tests). `finishedAvatar` is a real
  document field that rides the whole-session snapshot — the only way Finish's
  recording reaches the server.
- **`seedAvatar` is write-once at creation.** The Studio handoff records which card the
  session was seeded from; the whole-session UPDATE statement never names the column, so
  every later save preserves it by omission. Renames follow the reference cascade
  (`reassignSeedCard`, deliberately no revision bump — same rule as the examples);
  deleting the seed card detaches it while the transcript keeps the seed text, and Finish
  then degrades to a flat card rather than failing. Finish copies the seed's embedded
  book, extensions (`fav` reset, like duplicate) and identity fields onto the new Drafts
  card — the carry-over is disjoint from `toCardPatch`, so a stash slot the user cleared
  stays cleared.
- **No blocking modals.** Destructive actions use a two-click confirm in place. Disabled
  beats refused: a blocked entry is `disabled` with a `disabledReason` that becomes its
  `title` — no toast system.
- All colour, spacing, sizing and motion comes from `src/styles/tokens.css` — components
  hardcode none of it. Glass is token redefinition on `.shell[data-glass]`; the scrim,
  blur and `@supports`/`prefers-*` fallbacks are legibility requirements, not polish; and
  `backdrop-filter` goes on the bar and panels only, never on message bubbles (scroll
  recomposite). Built-in backgrounds are bundled image assets, never seeded into
  gitignored `data/`.
- **Ambient effects** (`src/features/backgrounds/`, rendered by `ParticleLayer`) are
  particle overlays paired per background: `AppSettings.backgroundEffects` maps the
  stored background string (`builtin:<id>` / `user:<file>`) to an effect id, ships
  empty, and is written only through `pairBackgroundEffect` — the client sends the
  whole map and `mergeSettings` guards it like `characterRatings`, so
  `{"backgroundEffects": null}` cannot wipe pairings. `resolveBackgroundEffect` is the
  one gate every shell goes through; an id the catalog no longer knows degrades to
  "no effect", the deleted-upload rule. Physics is pure (`engine.ts`, tested without a
  DOM); the canvas component is the only impure piece, and its budget rules are
  contractual: one canvas per shell (never per panel/bubble), per-spec fps caps,
  pause on `document.hidden`, no `shadowBlur` (glows are pre-rendered sprites), DPR
  capped at 2. The loop checks `matchMedia('(prefers-reduced-motion)')` itself — token
  overrides zero durations, they cannot stop a rAF loop — and the layer is
  `display: none` under `prefers-reduced-transparency`/`prefers-contrast`. Layering:
  the layer is the shell's **last static child**; `behind` (default) sits in the
  z-index 0 band above the scrim and is sampled by glass `backdrop-filter`, `front`
  ties the content's z-index 1 and wins by DOM order — anything raised to 2+ (popups,
  overlays) always outranks the rain.
- Panels are **multi-destination, routed by a panel id** — not an open/closed boolean
  plus a tab (a boolean and a tab can disagree; an id cannot). Closing a side unmounts
  its panel and flushes pending autosaves like switching does (`flushRightPanel` is what
  makes a failed flush surface). Bar buttons are toggle buttons (`aria-pressed`), not
  tabs. The chat column is `1fr`; the header row is a fixed grid track so
  `grid-template-columns` stays the only animated property.
- **The composer is a field with a tray under it**, not a row of controls around a
  field. Everything except typing — persona chip, menus, guided actions, Send — sits in
  a `--wc-control`-height tray beneath, and the tray's height comes out of the input's
  growth budget: `MAX_VIEWPORT_SHARE` ceilings the *whole* composer, so
  `composerGrowth.ts` subtracts a *measured* `trayBlock`, not a constant.
  `--wc-composer-row` is the input's `min-height` and the one-row floor the clamp
  refuses to go below.
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
- **The creator-notes scenario list is a picker.** When a card's `creator_notes` resolve to
  one line per greeting (`readScenarioNotes` — committed only when the counts agree), each
  line is a button: picking one is `useChat.swipeTo`, the reducer's existing `swipe/select`
  at that index, never a generation. The popup stays open on a pick; a line naming a
  greeting the message never received (card edited after the chat started) is disabled
  with its reason as the title.
- Slash commands are typed, parsed in `slashCommands.ts` before `chat.send`: only text
  starting with `/` is a command, and a command-shaped line that fails to parse is an
  **error, never a silent send**. Indexes/ranges are zero-based and inclusive, matching
  ST. `/hide` is an atomic single-revision set. Commands are blocked while a reply or
  summary runs; autocomplete is the discovery path.
- Quick commands are normalised app settings (id opaque, name editable) reachable only
  from the burger menu; picking one fills the composer and is not gated on `busy`. The
  composer's draft has exactly one write path: `ComposerHandle.insert`.
- **The branch timeline is a read-only map** (`branchTree.ts` pure, `BranchTree.tsx` renders).
  The burger's "Branch timeline…" takes the chat column the way the card reader does (portal
  into the overlay root, non-modal, Escape), and like "Character card…" it is deliberately
  not busy-gated — the jumps *inside* are what wait for the reply, since a switch would
  discard it. The family is the **connected component of the current chat over `branchedFrom`
  links**, never "all chats with this character" — `ChatSummary.branchedFrom` is extracted in
  the summary SQL (`json_extract` on the metadata blob) so one list fetch builds the whole
  tree. `branchedFrom` has no root id and no foreign key: a parent deleted from the library
  severs the chain (the chat stays, marked orphaned, dashed stub where the ancestry went),
  and a parent loop — only possible through imported metadata — breaks at the loop's earliest
  chat. `x` is the created-timestamp fraction **except** that a child is never drawn left of
  its parent; the timeline may lie slightly about *when*, it never draws an edge backwards.
  The px placement pass (`placeBranchTimeline`) enforces on-screen spacing — lanes push
  collisions right and the canvas widens rather than compresses. Clicking a node is the one
  action: `openChat`, the same door as every transcript switch. Branching and deleting stay
  in the menus that already own them.
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

- **Assemble once, send N times.** `useArenaRun.start` calls `assemblePrompt` a single
  time per run; every column gets the same `messages` array and only `buildRequestBody`
  runs per contender — identical history packing, World Info draws and
  `{{random}}`/`{{pick}}` rolls. A per-column re-roll re-sends the run's *cached*
  messages for the same reason.
- **No ratings table.** Rounds are stored write-once and the leaderboard is replayed
  from them in `created` order on every render, so a rating cannot drift from its
  history and `K_FACTOR` can change without invalidating anything. `replay` returns the
  table AND the chart's per-round series from **one** walk; the reveal's deltas come
  from `previewVerdict`, and `headToHead` counts from the same rounds — never a local
  `K_FACTOR * (score - expected)`, which would drift from the leaderboard. Every series
  covers every round (backfilled at `START_RATING`) so the lines read against one
  another.
- `bad` ("neither is usable") is recorded but moves **no** ratings and is excluded from
  every head-to-head record — it is not a draw, and scoring it as one would drag a
  strong rating toward a weak one on evidence containing no comparison.
- A tie lifts **both** ratings by `TIE_BONUS` (1) instead of scoring 0.5 each — the
  zero-sum update would charge the favourite a point for the draw, penalising a round
  that said both replies were worth keeping. Ties are the one verdict that is not
  zero-sum; win *rate* still counts a tie as half.
- Ratings under `PROVISIONAL_ROUNDS` rank **below** established ones however high the
  number goes.
- **Only blind rounds are scored.** The open Arena writes nothing.
- **The blind is a real blind.** While masked, nothing identifying reaches the DOM — no
  name, model, provider, reasoning text or timings, and by default no streaming (token
  cadence identifies a model as surely as a label). `hold` withholds a *settled* reply
  too, or the first column to finish would reveal itself by finishing.
- Deleting a contender never cascades into rounds; an id the pool can no longer resolve
  falls back to the model string recorded on the round (`RoundSide` stores model and
  provider as facts, not display names — the Stats rule).
- Pairing is **least-played**, not uniform (uniform re-decides settled matchups while
  two entrants never meet). Side assignment is a per-round coin flip, or position bias
  binds to one contender for the whole history.
- A run waits for `useLorebooks().pending` to clear — a blind round that ran before the
  card's linked book arrived would benchmark against lore a real chat would supply.
- **Corner colour is resolved per view, not stored** (`series.ts`): `viewSeries` assigns
  `--wc-series-N` against the entrants actually in a given view, so two visible things
  never share a colour; past eight tokens it repeats, hence every swatch is accompanied
  by a name. A masked column carries **no** colour.
- **A comparison never nests a scroll.** The columns grow and the page scrolls; the
  Benchmark duel is one scroller holding both panes so a single gesture moves them
  together. A genuinely enormous reply folds (measured, not guessed from a character
  count) rather than growing a scrollbar.
- **Replies render at the transcript's size and weight** (`--wc-text-base`/500) — this
  screen exists to have prose judged; column type steps down only as column count goes
  up. Columns stay equal width — a long reply must not widen its own column. Length is
  stated aloud in the bar from character counts (never `completionTokens`), and length
  is never given a winner.
- **Figures are compared at the precision they are displayed at** (`runStats.ts`): the
  tape prints seconds to one decimal, so 118ms and 143ms must both read as no-winner —
  a lime `0.1s` beside a plain `0.1s` reads as a rendering fault. Same rule
  `recordPoints` follows for rating deltas. Pinned by tests.
- The card picker is capped, searchable, pins the selection to the top and honours
  `hiddenTags` — a real library is hundreds of cards. The cue composer highlights macros
  with the mirror trick (`CueField.tsx`): every wrapping metric is set once on
  `.arena-cue__text` and inherited by both layers. The card is chosen from the medallion
  itself (`CharacterPicker.tsx`), composed from `Popover` per the popup rule; focus
  lands on the staged card in a **layout effect**, not a `requestAnimationFrame` — a
  frame callback does not fire while the window is backgrounded.

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
