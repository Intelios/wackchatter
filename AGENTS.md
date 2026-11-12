# WackChatter

A lightweight chat frontend for cloud LLMs, built on SillyTavern-compatible character cards and
chat-completion presets. Importing ST cards and presets should still work, and our presets may add
documented extensions other apps don't understand; exporting to ST is no longer a goal. Chats and
app settings are ours and deliberately not portable.

Bun server + React 19 + TypeScript + Vite client, desktop only. The server is thin — files, DB,
streaming proxy — and never builds a prompt: **assembly runs client-side**, like SillyTavern.
`shared/` is pure and imported by both sides.

## Roles

- **The user is the designer.** They own the design, what's in the app, and its interface. Take every design question to them with a recommendation, and never settle one yourself.
- **The Agent is the developer.** The Agent owns the tech stack, architecture, code, docs, commits and branches, and can change or replace any of them without asking.
- **`todo.md` is the designer's.** Read it for context. Never edit it.

## Commands

- `bun run dev:server` — API on **8787**, hot-reloaded.
- `bun run dev:client` — Vite on **5173**, proxies `/api` to 8787. This is the URL you open.
- `bun run build` — `tsc --noEmit`, then Vite build. `bun run start` serves `dist/` + API on one
  port. `bun test` runs tests; `bun run lint` is Biome.

`WC_PORT` overrides the API port, `WC_DATA_DIR` the data directory, `WC_NO_OPEN=1` skips the
browser. `WC_DATA_DIR` beats the pointer file and locks the setting in the UI, but is never
published as the library location.

**Restart `dev:server` after editing server SQL.** `--hot` reloads modules, but a running chat
store keeps its old prepared statements and can ship the old shape until restart.

**Real-LLM tests** go through the **"For Agents to Use"** connection in `data/settings.json` —
never the user's other connections. Don't rename or delete it.

## Models, connections and the Co-Creator

**Models are picked, connections are not** (`shared/models/slots.ts`). A connection is an endpoint
only — no model. Every feature holds a `ModelRef` (`{connectionId, modelId}`): the app-wide slots
in `AppSettings.models` (`chat`, `summary`, `nexus`, `cocreator`, `sideChat`; summary and
Co-Creator follow chat when empty, Nexus and side chat never do), a Co-Creator session's own pick,
the Preset Co-Creator's assistant and tester per document, each Arena contender. Slots merge
field-wise, so picking one never moves another; deleting a connection clears the app slots and
recents on it, while session and contender refs stay and report the missing connection when
resolved. `resolveModelRef` / `resolveSlot` are the one place a ref becomes a `ResolvedModel` or a
`disabledReason`. Pickers use `ModelPicker` under `ModelsProvider` (catalogues, recents).

**`runGeneration` (`src/lib/generation.ts`) is the only way to `/api/generate`** —
`generation.test.ts` pins it. It sends the model's connection id (the server has no "active"
connection and refuses a request without one), forces the body's `model` to the resolved one, and
logs usage, stopped replies included. Callers build their own body. **One generation at a time
is a `GenerationSlot`** (same file): a claim is the ownership token, so a newer claim or a chat
switch makes late callbacks inert, and only the holder's `release()` may clean up. Chat replies,
impersonation and the recap share one slot (one Stop); the summary has its own, and each refuses
while the other is busy.

**Connections are ours, not the preset's.** Connections live in `data/settings.json`, keys in
`data/secrets.json` keyed by connection id, and keys never reach the browser. A key belongs to its
endpoint: a PATCH changing provider or baseUrl drops it. A preset's own connection keys round-trip
but are never read. Custom headers merge last, case-insensitively, so a user header overrides ours
instead of duplicating it; `{{key}}` resolves server-side from the stored key (no key = header
dropped, never sent literally), and an empty value removes a header, ours included.

**The Co-Creator side chat** is one saved scratchpad in the session's whole-document
revision/save queue. Its context snapshot is frozen text, never live references; its messages
never enter the main prompt or turn counts, and both conversations share one generation gate and
Stop. The side chat's model is its own (the session's pick, else the `sideChat` slot) and never
borrows another: missing configuration blocks sends. Opening, reopening and resetting never generate; reset keeps side settings and filed cards,
including side-chat provenance.

**The Character Co-Creator** sizes every request, main and side, from its model's catalogue
context (`models/modelContext.ts`), never a setting. Filing never overwrites blind: a block into
a field that already holds something goes through the compare first. **Existing-card sessions have a durable full-card baseline and their own inherited portrait.**
The accepted working card is pinned in every main request (also for new cards); side chat
freezes it when opened/reset. Suggestions still require filing and replacements require
compare. Alternate scenarios are Alternate Greetings. Finish primarily updates the current
`targetAvatar`, with Create a new character available separately; a copy becomes the new
target while `seedAvatar` retains the origin. Missing targets disable Update, never silently
create. Updates three-way compare changed fields against the baseline, include explicit
clears, and use a version-checked atomic field/art/rename save. A publication id makes
session recording retryable without rewriting the card or reviving renamed references.

**The Preset Co-Creator** (`src/shell/PresetCoCreator.tsx`) is the loop ask → edit → test →
send back, laid out as the Co-Creator, the preset rail and the bench. Its assistant is sized
from its model's catalogue context too. **Nothing on the bench spends money on its own:** after
an edit a test only reports that its reply ran on an older revision (`staleRevision`); Rerun is a
click, and makes a swipe beside the old reply so before and after read side by side
(`rerunPair`, derived from the swipes' evidence). The session's cost is the recorded token
counts (assistant `usage`, test evidence) at the catalogue's prices, never an estimate.

## The data directory moves

`<repo>/data` is only the default; the user can relocate the library from User Settings and the
server repoints itself without restarting.

1. **`PATHS` is a live view, never a snapshot.** `setDataDir` rewrites the object in place so ~60
   call sites follow a move. Never destructure it or capture `PATHS.x` at module scope;
   `paths.test.ts` pins the identity.
2. **Anything memoised from `PATHS` resets in `quiesce()`** — db handle, chat store (first:
   prepared statements) and settings cache. Prefer anchoring to `PROJECT_ROOT` over a reset.
3. **The pointer write is the commit point.** Before it, unwind; after it, never unwind — report
   the failure and ask for a restart.

Backups: `switchDataDir` refuses while one is building, and `chats.db` / `backup.json` are
synthesised, not walked — **both must stay excluded at the root** (restore is unzip-and-adopt).
The archive streams through a `FileSink` because `Bun.serve` buffers a returned `ReadableStream` in
full.

## Which libraries open

3.0 carries **no migrations**. It opens what 2.3 left (schema 14, `libraryVersion.ts`) and refuses
anything older with one message, checked in `createSchema` before any write, at boot (every route
answers 503 with it) and in `inspectLocation` (`too-old`). SillyTavern import compatibility — card
V1/V2 mirrors, preset key renames, the 100000 order — is not migration and stays.

**`upgrade.ts` is the one conversion**, 2.3 → 3.0, run when a library's chat store is built — at
boot and right after a library switch, before anything reads settings.json. It runs in append-only
steps (meta `conversion_step` counts those done), each idempotent: chats (what 2.3 repaired
lazily), then models (each old connection/model pair becomes the `ModelRef` it meant, in
settings.json and in Co-Creator session and Preset Co-Creator document JSON — rows first, because
they need the connection models settings.json is about to lose). Steps **never touch `modified`**
(recents and Stats key on it) and bump `revision`. `SCHEMA` must
hold every column the stores write — `CREATE TABLE IF NOT EXISTS` never evolves a table — so any
schema change is a new step there plus a `SCHEMA_VERSION` bump.

## Rules that must not be broken

Verified against SillyTavern where it applies, and pinned by tests. Breaking one corrupts
libraries or silently changes behaviour; the code next to each test holds the detail.

**Character cards** (`server/lib/card.ts`)
- A PNG carries `chara` (V2) and `ccv3` (V3) `tEXt` chunks, keyword-matched case-insensitively.
  **Read `ccv3` first; write both.**
- Fields live at top level and under `data.*`, kept in step by `syncLegacyMirror`. **Unknown keys
  survive** — `mergeCardData` merges onto the parsed original, never rebuilds from a field list.
- **The PNG filename is the identity**, never the folder. Resolve by searching the tree, recurse
  when walking `data/characters`; chats, dialogue colours and backups key on the bare filename.
- Always emit `character_book.extensions`, even as `{}`.

**Presets** (`shared/prompt/preset-io.ts`)
- `enabled` lives on the **prompt order entry**, never on the prompt. The live order is
  `character_id: 100001`; a `100000` entry is legacy — preserve it, never read it. Array order is
  UI order.
- Write `JSON.stringify(preset, null, 4)` with no trailing newline. All 12 built-in prompts must be
  present; markers carry no `content`; unknown keys survive.
- `role: "documentation"` is WackChatter-only author context. Preserve it on every preset path,
  expose it to the Preset Co-Creator, and drop it in `assemblePrompt` before any other handling.
  Built-in markers never use it.

**Macros** (`shared/prompt/`) — three entry points, three runtimes: `assemble.ts` runs **one
committed runtime per request**, `greeting.ts` uses a **fresh runtime per call, thrown away**,
`outgoing.ts` is **one pass committed by the caller**.
- **User text resolves once, in `useChat.resolveDraft`** — never on edit, so `{{char}}` survives in
  edited text. Fold `{{setvar}}` writes into the state handed to `generate`.
- `{{roll}}` is droll's `NdM±K` grammar (`dice.ts`); caps on dice count and sides are mandatory.
- `macroCatalog.ts` is test-locked to the engine: every documented usage resolves, every
  `KNOWN_MACROS` name is documented.

**Assembly** (`shared/prompt/assemble.ts`)
- Macros substitute **per prompt and per message**, never over a joined string. `{{random}}`
  re-rolls per occurrence; `{{pick}}` is the seeded alternative.
- Budget is `openai_max_context - responseReserve(preset)` (`openai_max_tokens` when capped);
  history packs **newest-first** and stops at the first message that doesn't fit.
- **The app never caps a reply on its own** (`shared/providers/responseLength.ts`). Only a
  preset with a cap sends `max_tokens`; new presets start with `openai_max_tokens_unlimited`
  (not in `PRESET_DEFAULTS`, so imports keep their number). Summary, recap, Nexus, the
  Co-Creators and persona derive send none — their budgets only reserve context. Claude
  thinking on OpenRouter is the one exception: the budget must fit under `max_tokens`.
- `injection_position: ABSOLUTE` splices at `injection_depth` (0 = after the last message). Ties:
  low→high `injection_order`, then assistant→user→system. ST's ordering; tuned presets must match.
- A card's `system_prompt` / `post_history_instructions` override `main` / `jailbreak` unless
  `forbid_overrides`. `is_system` is hidden from the prompt but shown in the transcript.
- `continue` reshapes the finished array: `continue_prefill` moves the partial reply to the end,
  otherwise `continue_nudge_prompt` is appended; `continue_postfix` is the join.

**Regex scripts** (`shared/regex/`) — ST's format, imported scripts round-trip byte-identically.
- `markdownOnly` / `promptOnly` mean "runs during transcript / outgoing prompt"; both → both,
  neither → inert.
- **A bare pattern gets no flags**: `foo` replaces the first match; write `/foo/g`. Invalid flags
  make the whole string, slashes included, the pattern.
- Only `$N` and `$<name>` are captures; `trimStrings` apply to captures only. Depth bounds are
  inclusive, 0 is newest, `null` unlimited; `is_system` holds no depth slot.
- Runs **after** macros; an empty replacement drops the message from packing. Every
  `assemblePrompt` caller passes the same list, and the classic summary runs it over its
  transcript too.
- Not wired: `SLASH_COMMAND` / `WORLD_INFO` placements, card-embedded scripts, mid-stream.
  Never enable `rehype-raw` in `Markdown.tsx`.

**Generations that stay out of the transcript** — guidance is a `DepthInjection`, `{{input}}` rides
the macro `extra` hook, persistent guides live in `ChatMetadata.guides`, and both go last into
`depthInjections`. Impersonate uses the flat preset field `impersonation_prompt` (no 13th
built-in — it would break round-trip), appended **dead last** as `finalControls`, text to the
composer, `n` forced to 1. Recap bypasses `assemblePrompt`: `createDefaultPreset()` with `[system,
transcript]`, no card, persona, lore, memory or macros, single chat only.

**Story memory** (`shared/nexus/`, `src/features/{nexus,summary}/`)
- **One slot per chat:** `ChatMetadata.memoryMode` is `classic`, `nexus` or `off`; app settings
  only set the default for new chats. Summary and Nexus never inject together.
- **The classic summary is its own request** (`summary/request.ts`): its instructions, the card
  and persona descriptions, the memory so far and the new chat as a transcript. No preset, lore
  or chat samplers; its samplers are `SummarySettings`, and how much a request carries is the
  model's own context length (`models/modelContext.ts`, 128k when unknown), never a setting.
  Defaults stay generous: update every 80, keep 200 when hiding. Coverage is **message
  fingerprints** (`StorySummary.covered`), never ids; an id `checkpointMessageId` is read, not
  written. Each run puts the old text in `history` once. The automatic run starts only on growth
  seen in the open chat, never on opening one, and a failure never retries by itself.
- **Canon is `ChatMetadata.nexus`**, saved through the revision queue: opaque node ids, versioned
  names, append-only revisions with source fingerprints. Tombstones, disabled records and manual
  edits survive extraction; equal names never merge.
- **Recall checks evidence against the selected transcript version** — hidden, deleted and
  abandoned swipes excluded, manual corrections never regenerated; branching clamps sources to
  the copied prefix and remaps ids. Reviewed findings are one-request context, consumed on
  dispatch, never transcript messages.
- **The memory model is independent:** its own `nexus` slot and samplers, fixed JSON contract.
  Like the summary, each run packs to its model's own context (`NexusRun.contextTokens`), never
  a setting.
  Missing configuration pauses paid work; errors stop, never retry automatically, and extraction
  never changes transcript visibility. Embeddings are a disposable local cache
  (`nexus_embeddings`) sharing the library lifecycle; the worker never fetches models remotely.

**Messages and generation**
- **Group chats were removed in 3.0.** Every chat-store read filters `kind = 'direct'`, so a
  2.x library's group rows (and their backups) stay on disk, never listed, opened or deleted.
- **`mes` is derived, never stored** — text from `swipes[swipe_id]`, metadata from
  `swipe_info[swipe_id]`; `swipe_info` is always `swipes.length`. `fromChatMessage` is the only
  repair point; on disagreement `mes` wins.
- A user message's `persona_id` records its persona — `null` none, missing not recorded (an
  import from an old export; the 3.0 conversion stamped the library). NULL and `''` must not
  collapse. Chats arriving from a file get their missing mode and persona in `arrivingMetadata`.
- `hiddenBy` marks a message a memory hid. The classic summary writes `'summary'` when it hides
  what it covers (its rewrite still reads those; it never touches a message you hid), older
  stamps are the pre-Nexus system's, and a person hiding or revealing a message clears it.
- A placeholder starts **empty**, excluding the generating message from its own prompt.
- **Regenerate ≠ swipe:** regenerate replaces and drops alternates; overswipe appends and keeps
  them; in-array swiping is cached. A failed generation undoes exactly what starting it did.
  Selection can't move while generating; `dispatch` doesn't update refs synchronously.
- Streaming text never enters React state: it lives in `streamStore`, reaches one leaf through
  `useSyncExternalStore`, and the accumulator returns the full text every frame.

**Providers** (`shared/providers/`)
- `stop` must be **absent**, not `undefined` or `[]`; `seed` only when `>= 0` — zero is a seed.
  A null key means **no `Authorization` header**.
- `top_k`, `min_p`, `top_a` and `repetition_penalty` are **OpenRouter-only**.
- OpenRouter: `provider: {order, allow_fallbacks}` (not `only`), usage via `usage: {include:
  true}`, and `: OPENROUTER PROCESSING` keepalives must not kill the stream. Anthropic on
  OpenRouter needs explicit `reasoning.max_tokens` and rejects `temperature` / `top_p` / `top_k`
  while thinking.
- The server pipes `upstream.body` through untouched and forwards the client's `AbortSignal`.

**World Info** (`shared/worldinfo/`)
- Embedded `character_book` (`entries` array) and standalone books (`entries` keyed by uid) differ:
  `key`↔`keys`, `keysecondary`↔`secondary_keys`, `order`↔`insertion_order`, `disable`↔`!enabled`.
  **Everything else lives in `entries[i].extensions`**, `useProbability` and `selectiveLogic`
  included — typos that are load-bearing.
- **`extensions.position` wins on read.** `toCharacterBook` rebuilds from `originalData` so unknown
  keys survive; `nextUid` is `max + 1` over live entries **and** `originalData`.
- `order` is a **weight** (higher = closer to chat); `displayIndex` is a **permutation**. Never
  iterate `book.entries` order-sensitively — use `bookEntries()`.
- The scan buffer joins newest-first with `\n\x01` and starts with `\x01`; the sentinel is
  load-bearing for whole-word matching. `vectorized: true` excludes an entry.
- Edit an established card's book through per-uid endpoints, never by sending a whole
  `character_book` — `mergeCardData` spreads, so a stale tab would mass-delete.

**Personas** (`server/lib/personas.ts`)
- The filename is an **opaque id**; `ChatMetadata.persona` stores it, so renaming must not orphan
  chats. (A lorebook's filename *is* its name.)
- **One current persona, and the chat wins:** a pick sets `AppSettings.personaId` and the chat's
  `ChatMetadata.persona`; opening a chat adopts its recorded persona.
- Names may collide; the id is identity. `matchPersonaByName` is exact → prefix → substring,
  stopping at the first rung with a match.
- Variants are whole personas linked by `variantOf`, one level; deleting the base severs the link.
  `variantLabel` is UI-only and never reaches a prompt.

### Deliberate divergences from SillyTavern

`migratePreset` evaluates every rule before deleting a key. A failed regenerate restores the
message and its alternates. Unsupported World Info positions fold into before/after. World Info
randomness is seeded on `chatId` + last user message id, so a swipe sees identical lore and a
skipped draw isn't consumed. `use_regex` is written but ignored; a key is regex iff it parses as
`/…/flags`. The activation engine substitutes no macros; assembly does, once. Only `{{...}}` is an
unresolved macro. The usage ledger is on by default (explicit false preserved), keeps JSONL in
`~/.wackchatter/usage/v2/` (see `docs/tokentrail-integration.md`), and `extra.usage_reported`
separates provider counts from estimates. Provider-reported usage is opt-in per connection
(`reportUsage`), off by default for `custom`.

### Replicated ST quirks — do not "fix"

Both have named tests; per-entry `matchWholeWords` and regex keys are the escape hatches. A
multi-word key skips whole-word matching and becomes a substring test (`red dragon` matches inside
`bored dragonfly`). The boundary regex uses `\W` without `u`, so every non-Latin letter is a word
boundary.

## UI

**State and markup are apart.** `src/app/useAppController.ts` holds everything the app knows and
does — settings (`useAppSettings`, defaults and slot resolution in the pure `settingsView.ts`),
the library, the trash bin, navigation — and `src/shell/Shell.tsx` is markup over it, one screen
per `view` (the chat or home, the Studio, the Co-Creators, the Arena, Stats). The 2.x interface
is gone; the components it shared with 3.0 (connection editor, regex list, lorebook editor,
popovers) stay in `src/features` with their base CSS beside them, and `.wc3` rules in
`src/shell` restyle them. `useChat` is likewise a composer over
`useChatSession`, `useChatGeneration`, `useChatSummary` and `useChatLifecycle`, with the pure parts
in `chatRequest.ts` and `summary/request.ts` / `summary/coverage.ts`. Every navigation that leaves the chat stops
generation, flushes saves, and refuses to move if a flush fails.


- Colour, spacing, sizing and motion come from `src/styles/tokens.css`; components hardcode none.
- **`Popover` is the only popup mechanism** (`Menu` is its data-driven variant). Focus calls
  inside popups pass `preventScroll: true`.
- **No blocking modals.** Destructive actions confirm with two clicks in place. Disabled beats
  refused: a blocked entry is `disabled` with a `disabledReason` title.
- The margin is **multi-destination, routed by a tool id** (`ToolId`), not open/closed plus tab.
- **Presets save explicitly, characters autosave.** The preset draft (`usePresetDraft`) lives in
  the app controller, above every screen, so closing a tool never hides unsaved edits.
- Slash commands parse in `slashCommands.ts` before `chat.send`; a command-shaped line that fails
  to parse is an **error, never a silent send**.
- Error boundaries wrap the root and each shell region.

**The chat in 3.0:** the chat's model sits on the island (one click opens the picker; it sets
the `chat` slot). `AppSettings.revealReplies` is the Streaming switch in Settings ▸ Look and display only: `finished` (off) hides the text while
it streams and shows it whole at the end, so the island and the Line still follow the stream;
the preset's `stream_openai` stays the real switch, for endpoints that cannot stream. The
character's card opens from each portrait (a glance) and in full in the margin, which it
shares with the tools: opening one puts the other away.

**Stats** live in TokenTrail: the action flushes saves and opens the matching library via
`tokentrail:` without aborting generation. Discovery stays separate from the library pointer and
is never published under `WC_DATA_DIR`; TokenTrail reads files read-only, and navigation never
creates a chat or switches libraries.

**Model Arena** rounds are write-once; the leaderboard replays them on every render. Only blind
rounds score; `bad` moves no ratings and ties lift both by `TIE_BONUS`. Pairing is least-played.
Assemble once per run and send identical messages to every contender. Merging is a lens on
history, never an edit. Nothing identifying reaches the DOM while masked — names, models,
timings, cost, colour, and a failed reply's provider error. What the Arena knows and does is
`useArena` (`src/features/arena/useArena.ts`), with `src/shell/Arena.tsx` as its markup
(Leaderboard, Benchmark with a Blind switch, Tournaments; the pool on
the island). Each blind round records its sides' tokens, time and connection in
`arena_round_usage` (schema 15, from 3.0 on; older rounds have none, nothing estimates them),
priced at the catalogue when shown. The leaderboard's stats (`src/shell/arenaStats.ts`) and
"this sitting" (rounds with no pause over 45 minutes) are read off the rounds, never stored.
Removing a model from the pool never touches its rounds. Cards and cues have their own Setup
page; a cue with `enabled: false` sits out of new rounds without being deleted (`activeProbes`).

**Tournament** is its own points ladder, never mixed with Elo. Points double per stage; the plan is
stored and progress replays from `arena_matches`. Matches are write-once and always blind. Ties
and `bad` re-roll once, then the judge must pick a winner.

## Testing

Every rule above is pinned by a test next to its code; add the test **before** the code when
touching a format. The format gates round-trip fixtures built inline in the shape ST writes — a
dual-chunk card with an embedded book (`card.test.ts`), an ST-style preset with both prompt orders
(`preset-io.test.ts`), a book carrying every World Info key (`convert.test.ts`) — so no external
SillyTavern checkout is needed. The `location` / `transfer` / `paths` tests gate the
data-directory rules. No DOM harness: keep logic in pure functions and React wrappers thin.

`paths.ts` is shared module state across `bun test`; any test that repoints it must put it back.
An editor must never own its revision counter — ask the queue (`nextRevision`).
