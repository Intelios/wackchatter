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

**Testing against real LLMs:** the connection **"For Agents to Use"** in `data/settings.json`
(custom provider) exists so agents working on this repo can run real generations. Route test
traffic through it, not the user's other connections, and don't rename or delete it — its
key lives in `data/secrets.json` like any other and never leaves the machine.

## Layout

```
server/          Bun. Thin: files, DB, streaming proxy. Never builds a prompt.
  index.ts       Loopback-gated server; dispatches to one handler per resource in routes/.
  lib/png.ts     PNG chunk parse/encode + CRC32 + tEXt. Pure TS, no deps.
  lib/card.ts    Card read/normalise/merge/write.
  lib/paths.ts   Data dirs, filename sanitising, traversal guards.
  lib/folders.ts Character folders as real directories.
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
  nexus/         Versioned knowledge, provenance, extraction contract and hybrid retrieval.
  memory/        Legacy memory conversion and hide provenance.
  persona/       derive.ts — card-to-persona: the prompt, the reply contract, the house format.
  prompt/        Assembly engine, macros, dice, preset I/O, defaults, token cache.
  providers/     Request building + SSE parsing. looseJson.ts is shared by both extractors.
  regex/         User regex scripts: engine, depth, import/export. Macros are injected.
  worldinfo/     Lorebook conversion + the activation engine.
  types/         Card, preset, worldinfo, chat, settings, regex, cocreator, stats, arena.
src/             React app.
  layout/        AppShell — the three-column grid.
  features/      character/, preset/, chat/, connection/, lore/, persona/, studio/,
                 cocreator/, stats/, arena/, memory/, regex/, settings/, start/, summary/.
  lib/revisionQueue.ts  The revision-aware save queue. Chat and the Co-Creator both bind it.
data/            Gitignored. characters/**/*.png, presets/*.json, chats.db, settings.json,
                secrets.json, lorebooks/, personas/, backups/, .wackchatter.
                The default location, not a fixed one — see "The data directory moves".
```

**Prompt assembly runs client-side**, like SillyTavern; the server only proxies.

**Connection settings are ours, not the preset's.** Connections live in `data/settings.json`,
keys in `data/secrets.json` keyed by connection id, never reaching the browser. The key
belongs to the endpoint (provider + baseUrl): a PATCH changing either drops the key. A
preset's own connection keys round-trip untouched but are never read. `showReasoning` /
`reportUsage` are per-connection.

## The data directory moves

`<repo>/data` is the default, not a fixed location; the user can relocate the library from
User Settings and the server repoints itself without restarting. Three invariants:

1. **`PATHS` is a live view, never a snapshot.** `setDataDir` rewrites one object in place,
   so ~60 call sites follow a move untouched. Never destructure `PATHS` or capture
   `PATHS.x` into a module-level const. `server/lib/paths.test.ts` pins the object
   identity.
2. **Anything memoised from `PATHS` needs a reset wired into `quiesce()`** — today the db
   handle (`db.ts`), chat store (`chats.ts`, resets first — prepared statements) and
   settings cache (`settings.ts`). Prefer anchoring to `PROJECT_ROOT` over adding a reset.
3. **The pointer write is the commit point**, immediately after the last operation that
   changes where the data physically is. Before it, unwind. After it, never unwind —
   report the failure and ask for a restart.

**Backups** (`lib/library.ts`): `switchDataDir` refuses while one is being built.
`chats.db` and `backup.json` are synthesised, not walked — **both must stay excluded at the
root** (restoring is unzip-and-adopt). Do not simplify the archive back to returning a
stream — `Bun.serve` buffers `ReadableStream` bodies in full; the `FileSink` + `Bun.file`
path streams in constant memory.

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
  than rebuilding from a field list.
- **The PNG filename is the identity**, and a folder is never part of it: paths resolve by
  searching the tree (`resolveCharacterFile`). Names are unique library-wide. Chats,
  dialogue colours and backups all key on the bare filename.
- Anything walking `data/characters` must **recurse** — a flat `readdirSync` silently
  skips every foldered card.
- Always emit `character_book.extensions`, even as `{}`.

**Presets** (`shared/prompt/preset-io.ts`)
- `enabled` lives on the **prompt order entry**, not the prompt object; `Prompt.enabled`
  is never read.
- The live prompt order is `character_id: 100001`. A `100000` entry is legacy — preserve
  untouched, never read from it. Array order **is** UI list order; no sort key.
- Serialise as `JSON.stringify(preset, null, 4)` with **no trailing newline**. All 12
  built-in prompts must be present. Marker prompts carry no `content` on disk. Unknown
  keys are preserved on save.

**Macros** (`shared/prompt/`)
- Three entry points, three runtime rules, not interchangeable:
  - `assemble.ts`: **one runtime for the whole request**, committed — `{{setvar}}` writes.
  - `greeting.ts`: **fresh runtime per call, thrown away** — rendering must never write.
  - `outgoing.ts`: **one pass, committed by the caller** — returns new maps.
- **User text resolves once, at the composer chokepoint** (`useChat.resolveDraft`). Never
  on edit — `{{char}}` must survive as text in edits.
- The variable write is **folded into the state handed to `generate`**, not left to
  dispatch — reading `stateRef` after dispatching would assemble from pre-turn values.
- `{{roll}}` is droll's grammar (`NdM±K`) in `dice.ts`. Caps on dice count and sides are
  mandatory.
- `macroCatalog.ts` is **test-locked to the engine**: every documented usage must resolve,
  every `KNOWN_MACROS` name must be documented.

**Assembly** (`shared/prompt/assemble.ts`)
- Macros substitute **per prompt object and per message**, never one pass over a joined
  string. `{{random}}` re-rolls per occurrence; `{{pick}}` is the seeded alternative.
- Budget is `openai_max_context - openai_max_tokens`. History packs **newest-first** and
  stops at the first message that doesn't fit.
- `injection_position: ABSOLUTE` splices at `injection_depth` (0 = after last message).
  Ties: **low→high `injection_order`**, within one order assistant→user→system. This is
  SillyTavern's ordering; tuned presets must read the same in both apps.
- A card's `system_prompt` / `post_history_instructions` override `main` / `jailbreak`
  unless `forbid_overrides`. `is_system` = hidden from the prompt, still shown in transcript.
- `continue` reshapes the finished array: `continue_prefill` moves the partial reply to
  the end, otherwise `continue_nudge_prompt` is appended. `continue_postfix` is the join.

**Regex scripts** (`shared/regex/`) — ST's format; imported scripts round-trip
byte-identically. Each quirk has a named test.
- `markdownOnly` / `promptOnly` mean "runs during" transcript / outgoing prompt. Both → both;
  neither → inert (ST's destructive chat-file rewrite has no call site here).
- **A bare find pattern gets no flags** — `foo` replaces the first match; need `/foo/g`.
  Invalid flags: the whole string (slashes included) becomes the pattern.
- Only `$N` and `$<name>` are capture references; `trimStrings` apply to captures only.
- Depth bounds are inclusive, 0 is newest, `null` unlimited. `is_system` messages hold no
  depth slot.
- Regex runs **after** macro substitution; an empty replacement drops the message from
  packing. All four `assemblePrompt` callers must pass the same regex list.
- Not wired: `SLASH_COMMAND` / `WORLD_INFO` placements, character-embedded `regex_scripts`,
  mid-stream application. Never enable `rehype-raw` in `Markdown.tsx`.

**Guided generations** — Guidance is a `DepthInjection`, never a transcript message.
`{{input}}` rides the macro engine's `extra` hook. Persistent guides live in
`ChatMetadata.guides`. Guides and guidance are pushed **last** into `depthInjections`.

**Impersonate** — The instruction is ST's **flat preset field** `impersonation_prompt`, not
a prompt object (no 13th built-in — would break preset round-trip). Appended **dead last**
as a `finalControls` message. Nothing reaches the transcript — text goes to the composer
via `ComposerHandle.replace`. `n` forced to 1. No auto memory-extraction.

**Recap** — Bypasses `assemblePrompt` entirely: `[system instruction, user transcript]` with
`createDefaultPreset()`. No preset prompts, card, persona, lore, memory or macros. Borrows
impersonation's reducer contract (no transcript message). Single-chat only.

**Story memory** (`shared/nexus/`, `src/features/nexus/`, `src/features/summary/`)
- **One per-chat slot:** `ChatMetadata.memoryMode` is `classic` (Summary), `nexus`, or `off`.
  App settings provide the default for new chats only. Summary and Nexus never inject together.
- **Canonical knowledge lives in `ChatMetadata.nexus`**, saved through the revision queue.
  Nodes have opaque identities and versioned names/aliases. Facts, events, situations and
  threads have append-only revisions with source fingerprints and attribution. Tombstones,
  disabled records and manual edits survive later extraction. Equal names alone never merge.
- **Evidence is checked against the selected transcript version at recall time.** Hidden,
  deleted and abandoned swipe sources are excluded. Manual corrections never fall back to
  generated text.
- **Branching never clamps a Nexus.** Every source and the manual-edit anchor must be within
  the copied prefix; surviving versions have message IDs remapped.
- **The memory model is independent:** explicit saved connection ID, independent model string,
  dedicated samplers, fixed validated JSON contract. Missing configuration pauses paid
  operations without borrowing the chat model. Errors stop, no automatic paid retry loops.
  Extraction never changes transcript visibility.
- **Reasoning budget:** OpenAI-compatible endpoints count thinking inside `max_tokens`, so
  `nexusMaxTokens` includes effort-sized headroom (4K–64K). Claude on OpenRouter is the
  exception — `buildRequestBody` adds thinking budget on top of `max_tokens`.
- **Local recall:** BGE-small q8, tokenizer, manifest and licence vendored under
  `public/models`; WASM runtime ships locally. Worker forbids remote model fetching. Query
  jobs take priority. Cache includes content and model fingerprints.
- **`nexus_embeddings` is a disposable SQLite cache**, separate from canonical records.
  Shares the library database lifecycle (backup, relocation, cascade deletion).
- **Reviewed Recall findings are one-request context, never transcript messages.** Armed
  findings survive draft edits, consumed on dispatch. The search deduplicates against the
  automatic selection (`shared/nexus/findings.ts`).
- Legacy `shared/memory/` code remains for conversion and old hide provenance.
- Classic summarising keeps estimate-then-verify `packClassicSummaryChunk`.

**Messages** (`shared/chat/message.ts`)
- **`mes` is derived, never stored**: text from `swipes[swipe_id]`, metadata from
  `swipe_info[swipe_id]`. `fromChatMessage` is the only repair point; on disagreement
  `mes` wins. `swipe_info` is always exactly `swipes.length`.
- A user message records the persona it was sent as (`persona_id`): null = no persona,
  missing = legacy. In storage NULL and `''` must not collapse.

**Generation** (`src/features/chat/state/chatReducer.ts`)
- A placeholder's text starts **empty** — excludes the generating message from its own prompt.
- **regenerate ≠ swipe.** Regenerate replaces and drops alternates; overswipe appends and
  keeps them; swiping within the array is cached. A failed generation must undo exactly what
  starting it did.
- The selection cannot move while generating. `dispatch` does not update a ref synchronously.
- **Streaming text never enters React state** — it lives in `streamStore`, reaching one leaf
  via `useSyncExternalStore`. The accumulator returns the **full** text every frame.

**Providers** (`shared/providers/`)
- `stop` must be **absent**, not `undefined` or `[]` — several backends 400 on an empty
  array. `seed` only when `>= 0` — zero is a real seed.
- `top_k` / `min_p` / `top_a` / `repetition_penalty` are **OpenRouter-only**. A null key
  produces **no** `Authorization` header.
- OpenRouter: `provider: {order, allow_fallbacks}` (not `only`), usage via
  `usage: {include: true}` (not `stream_options`), and `: OPENROUTER PROCESSING`
  keepalive comments must not kill the stream.
- **Anthropic on OpenRouter** needs explicit `reasoning.max_tokens`. We size it ourselves
  and delete `temperature` / `top_p` / `top_k` (Anthropic rejects them while thinking).
- The server pipes `upstream.body` through untouched and forwards the client's
  `AbortSignal` upstream.

**World Info** (`shared/worldinfo/`)
- `character_book` (embedded, `entries` is an **array**) and standalone book (`entries` is
  an **object keyed by uid**) differ structurally and by field name:
  `key`↔`keys`, `keysecondary`↔`secondary_keys`, `order`↔`insertion_order`,
  `disable`↔`!enabled`. **Everything else lives in `entries[i].extensions`**, including
  `useProbability` and `selectiveLogic` — they look like typos; they are not.
- **`extensions.position` wins on read** over top-level `position`.
- `toCharacterBook` rebuilds each entry from its `originalData` before overwriting mapped
  fields — that carries unknown top-level keys. `nextUid` is `max + 1` over live entries
  **and** `originalData`.
- Never iterate `book.entries` order-sensitively — use `bookEntries()`.
- `order` is a **weight** (higher = closer to chat); `displayIndex` is a **permutation**.
- The scan buffer joins newest-first with `\n\x01` **and starts with `\x01`** — the head
  sentinel is load-bearing for whole-word matching.
- `vectorized: true` **excludes** the entry.
- The client never sends the server a whole `character_book` when editing an established
  card — `mergeCardData`'s spread replaces it wholesale; per-uid endpoints exist to prevent
  stale-tab mass deletions.

**Personas** (`server/lib/personas.ts`)
- A persona's filename is an **opaque id** with an editable `name` — `ChatMetadata.persona`
  stores the id, so renaming must not orphan chats. (Contrast: a lorebook's filename **is**
  its name.)
- **One current persona, and the chat wins.** A pick sets both `AppSettings.personaId` and
  the open chat's `ChatMetadata.persona`; loading a chat adopts its recorded persona.
- **Names may collide** — the id is the identity. `matchPersonaByName` returns
  exact → prefix → substring and stops at the first rung with any match.
- **Variants** are whole personas linked by `variantOf`. One level only. Deleting the base
  severs the link. `variantLabel` is UI-only, never in a prompt (`{{user}}` stays the name).

### Deliberate divergences from SillyTavern

- `migratePreset` evaluates **all** migration rules before deleting a key.
- A failed regenerate restores the original message **and its alternates**.
- The **usage log** (`usageLog`, off by default) appends JSONL to `~/.wackchatter/usage.jsonl`.
- `extra.usage_reported` separates provider counts from estimates.
- Real token usage is opt-in (`reportUsage`), off by default for `custom`.
- Unsupported World Info positions fold into before/after rather than being dropped.
- The activation engine substitutes no macros — assembly does, once.
- `use_regex` is written but ignored on read; a key is regex iff it parses as `/…/flags`.
- World Info randomness is seeded on `chatId` + last user message id, so regenerate/swipe
  see identical lore. A draw is skipped, not consumed.
- Only `{{...}}` is reported as an unresolved macro.

### Replicated ST quirks — do not "fix"

Both look like bugs; both are kept because books were authored against them, and both
have named tests. Per-entry `matchWholeWords` and regex keys are the escape hatches.

- A multi-word key skips whole-word matching entirely and becomes a substring test —
  `red dragon` matches inside `bored dragonfly`.
- The boundary regex uses `\W` with no `u` flag, so every non-Latin letter counts as a
  word boundary.

## UI conventions

- All colour, spacing, sizing and motion comes from `src/styles/tokens.css` — components
  hardcode none of it.
- **`Popover` is the only popup mechanism**; `Menu` is its data-driven variant. Focus calls
  inside popups pass `preventScroll: true`.
- **No blocking modals.** Destructive actions use a two-click confirm in place. Disabled
  beats refused: a blocked entry is `disabled` with a `disabledReason` title.
- Panels are **multi-destination, routed by a panel id** — not open/closed + tab.
- **Presets save explicitly, characters autosave.** The preset draft lives above the left
  panel's router (`usePresetDraft` in `App`).
- Slash commands are typed, parsed in `slashCommands.ts` before `chat.send`: a command-shaped
  line that fails to parse is an **error, never a silent send**.
- Error boundaries wrap the root and each shell region.

**Stats** — Counting in SQL, client gets ids and numbers (never display names). Rerolls
exclude `position 0` (alternate greetings are swipes). Server sends UTC hour buckets, client
folds the calendar. `extra.token_count` is completion tokens only — **never present as a
cost**.

**Model Arena** — Rounds are stored write-once; the leaderboard is replayed from them on
every render. `bad` moves no ratings. Ties lift both by `TIE_BONUS`. Only blind rounds are
scored. Pairing is least-played. Assemble once per run, send same messages to all contenders.
Merging is a lens on history (`ArenaSettings.mergedContenders`), never an edit to rounds.
The blind is a real blind — nothing identifying reaches the DOM while masked.

**Tournament Mode** — A bracket is its own points ladder, never mixed with Elo. Points double
per stage. The plan is stored, progress replayed from `arena_matches`. Matches are write-once.
Every match is blind. Ties/bad re-roll once, then the judge must pick a winner.

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
counter** — ask the queue (`nextRevision`).
