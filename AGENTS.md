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
- **`docs/todo.md` is the designer's.** Read it for context. Never edit it.

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

## Connections and the Co-Creator

**Connections are ours, not the preset's.** Connections live in `data/settings.json`, keys in
`data/secrets.json` keyed by connection id, and keys never reach the browser. A key belongs to its
endpoint: a PATCH changing provider or baseUrl drops it. A preset's own connection keys round-trip
but are never read. Custom headers merge last, case-insensitively, so a user header overrides ours
instead of duplicating it; `{{key}}` resolves server-side from the stored key (no key = header
dropped, never sent literally), and an empty value removes a header, ours included.

**The Co-Creator side chat** is one saved scratchpad in the session's whole-document
revision/save queue. Its context snapshot is frozen text, never live references; its messages
never enter the main prompt or turn counts, and both conversations share one generation gate and
Stop. Side connection/model choices are explicit and endpoint-bound: missing configuration blocks
sends. Opening, reopening and resetting never generate; reset keeps side settings and filed cards,
including side-chat provenance.

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
- Budget is `openai_max_context - openai_max_tokens`; history packs **newest-first** and stops at
  the first message that doesn't fit.
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
  `assemblePrompt` caller, summary packers included, passes the same list.
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
- **Canon is `ChatMetadata.nexus`**, saved through the revision queue: opaque node ids, versioned
  names, append-only revisions with source fingerprints. Tombstones, disabled records and manual
  edits survive extraction; equal names never merge.
- **Recall checks evidence against the selected transcript version** — hidden, deleted and
  abandoned swipes excluded, manual corrections never regenerated; branching clamps sources to
  the copied prefix and remaps ids. Reviewed findings are one-request context, consumed on
  dispatch, never transcript messages.
- **The memory model is independent:** own connection, model and samplers, fixed JSON contract.
  Missing configuration pauses paid work; errors stop, never retry automatically, and extraction
  never changes transcript visibility. Embeddings are a disposable local cache
  (`nexus_embeddings`) sharing the library lifecycle; the worker never fetches models remotely.
- 2.0 boot migrates with **`migrateChatMeta`, never `updateChatMeta`** — the latter stamps
  `modified`, scrambling recents and Stats. It runs before `Bun.serve`, one savepoint per chat;
  failures are reported and retried next start, and the marker is written only when all succeed.

**Messages and generation**
- **Group chats were removed in 3.0.** Every chat-store read filters `kind = 'direct'`, so a
  2.x library's group rows (and their backups) stay on disk, never listed, opened or deleted.
- **`mes` is derived, never stored** — text from `swipes[swipe_id]`, metadata from
  `swipe_info[swipe_id]`; `swipe_info` is always `swipes.length`. `fromChatMessage` is the only
  repair point; on disagreement `mes` wins.
- A user message's `persona_id` records its persona — `null` none, missing legacy. NULL and `''`
  must not collapse.
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

- Colour, spacing, sizing and motion come from `src/styles/tokens.css`; components hardcode none.
- **`Popover` is the only popup mechanism** (`Menu` is its data-driven variant). Focus calls
  inside popups pass `preventScroll: true`.
- **No blocking modals.** Destructive actions confirm with two clicks in place. Disabled beats
  refused: a blocked entry is `disabled` with a `disabledReason` title.
- Panels are **multi-destination, routed by a panel id**, not open/closed plus tab.
- **Presets save explicitly, characters autosave.** The preset draft (`usePresetDraft`) lives above
  the left panel's router.
- Slash commands parse in `slashCommands.ts` before `chat.send`; a command-shaped line that fails
  to parse is an **error, never a silent send**.
- Error boundaries wrap the root and each shell region.

**Stats** live in TokenTrail: the action flushes saves and opens the matching library via
`tokentrail:` without aborting generation. Discovery stays separate from the library pointer and
is never published under `WC_DATA_DIR`; TokenTrail reads files read-only, and navigation never
creates a chat or switches libraries.

**Model Arena** rounds are write-once; the leaderboard replays them on every render. Only blind
rounds score; `bad` moves no ratings and ties lift both by `TIE_BONUS`. Pairing is least-played.
Assemble once per run and send identical messages to every contender. Merging is a lens on
history, never an edit. Nothing identifying reaches the DOM while masked.

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
