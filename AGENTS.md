# WackChatter

A lightweight chat frontend for cloud LLMs, **data-compatible with SillyTavern**: character
cards and chat-completion presets move between the two apps untouched. Chats and app
settings are ours and deliberately not portable.

Bun (server) + React 19 + TypeScript + Vite (client). Desktop only — no mobile support.

Reference copy of SillyTavern lives at `Documents/Github/SillyTavernSource` (read-only, for format
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
the browser launching. `WC_DATA_DIR` beats the pointer file and locks the setting in the UI.

## Layout

```
server/          Bun. Thin: files, DB, streaming proxy. Never builds a prompt.
  lib/png.ts     PNG chunk parse/encode + CRC32 + tEXt. Pure TS, no deps.
  lib/card.ts    Card read/normalise/merge/write.
  lib/paths.ts   Data dirs, filename sanitising, traversal guards.
  lib/folders.ts Character folders as real directories. Identity stays flat — see below.
  lib/location.ts Which directory that is: pointer file, validation, cloud detection.
  lib/transfer.ts Moving a library between directories, verified and reversible.
  lib/relocate.ts Orchestrates a live move: gate, quiesce, commit.
  lib/db.ts      bun:sqlite connection + schema.
  lib/chats.ts   createChatStore(db) — the whole persistence boundary.
  lib/secrets.ts API keys. Mode 0600. Never leaves the machine.
  lib/generate.ts The one place that calls a provider.
  lib/lorebooks.ts Standalone lorebook files. Filename IS the name.
  lib/personas.ts  Personas + avatars. Filename is an opaque id.
shared/          Pure, no I/O. Imported by both server and client.
  chat/          MessageState — the swipe invariant, as a type.
  prompt/        Assembly engine, macros, preset I/O, defaults, token cache.
  providers/     Request building + SSE parsing. Both unit-tested.
  worldinfo/     Lorebook conversion + the activation engine. No I/O.
  types/         Card, preset, worldinfo, chat, settings.
src/             React app.
  layout/        AppShell — the three-column grid.
  features/      character/, preset/, chat/, connection/, lore/, persona/.
data/            Gitignored. characters/**/*.png, presets/*.json, chats.db, settings.json,
                 secrets.json, lorebooks/, personas/, backups/ (the deleted-chat trash bin),
                 .wackchatter (marks the folder as a library).
                 The default location, not a fixed one — see "The data directory moves".
```

**Prompt assembly runs client-side**, like SillyTavern. The server only proxies. This keeps
the server dumb and fast, lets the Prompt Manager show live per-prompt token counts, and
makes an exact "what was sent" inspector trivial — the browser posts the object it built,
so the inspector shows the wire payload rather than a reconstruction of it.

**Connection settings are ours, not the preset's.** Connections live in
`data/settings.json` as a list (`connections`) plus an active selection (`connectionId`,
null means "the first one"); keys live in `data/secrets.json` keyed by the connection's
opaque id and never reach the browser. The list mutates only through the
per-connection endpoints (`POST/PATCH/DELETE /api/settings/connections…`) — the
character-book rule, for the same reason: `mergeSettings` pins the list, so a stale
tab or a malformed body like `{"connections": null}` cannot delete connections, and a
deleted connection's key is removed by its own DELETE, never by pruning from a
client-supplied list. **The key belongs to the endpoint** (provider + baseUrl), not to
the entry: a PATCH that changes either drops the key rather than sending it somewhere
it was never meant for, and `/settings/test` attaches the stored key only when the
probed endpoint matches the stored one — a real id paired with a forged baseUrl is
probed keyless. Each connection is `{id, name}` over the wire settings — the persona
rule: id is opaque, name is editable, nothing references a connection by name.
`showReasoning` and `reportUsage` are per-connection but edited from the Generation
panel, write-through; they describe how the active endpoint is asked, not the preset.
A preset's own connection keys (`custom_url`, `openrouter_model`,
`chat_completion_source`) round-trip untouched but are never read, so importing someone
else's preset cannot silently repoint your endpoint and exporting yours cannot leak it.

## The data directory moves

`<repo>/data` is the default, not a fixed location. The user can relocate the whole library
from Appearance → Data location, and the server repoints itself without restarting. Three
invariants make that safe, and each one is a real bug that was possible before it existed.

**1. `PATHS` is a live view, never a snapshot.** `setDataDir` rewrites one object in place,
which is the only reason ~60 call sites that read `PATHS.x` follow a move without being
touched. So: never destructure `PATHS`, and never capture `PATHS.x` into a module-level
const. The old `BLANK_AVATAR_PATH` did exactly that — and was anchored to the data dir's
parent, so it would have travelled with the library it had no business following.
`server/lib/paths.test.ts` pins the object identity; if that test ever fails, every one of
those call sites is silently stuck on the old root.

**2. Anything memoised from `PATHS` needs a reset, wired into `quiesce()`.** Today that is
the database handle (`db.ts`), the chat store (`chats.ts`, which holds prepared statements
bound to that handle, so it resets first) and the settings cache (`settings.ts`). Note what
is *not* on the list: `blankAvatarCache` is anchored to `PROJECT_ROOT`, which never moves.
Fixing an anchor deletes a reset obligation — prefer that to adding one.

**3. The pointer write is the commit point.** It goes immediately after the last operation
that changes where the data physically is. Before it, unwind. After it, never unwind: report
the failure and ask for a restart, because a restart reads the pointer and lands correctly.
Writing the pointer last instead — the obvious ordering — means a crash leaves the library
moved and the config saying otherwise, and the next boot finds an empty directory that
`ensureDataDirs()` helpfully recreates.

Two supporting rules. **The database moves as one file**: `closeDatabase()` checkpoints with
`TRUNCATE` and leaves WAL, because Bun caches prepared statements and a plain `close()` never
gets SQLite to drop its own sidecars — and a `-wal` that still has content is never deleted.
**A synced folder gets `journal_mode = DELETE`**, since the specific thing every sync client
mishandles is three interdependent files pretending to be independent ones.

`lib/backgrounds.ts` refuses caller-supplied directories and this feature accepts them; the
comments in both places explain why that is one policy rather than two. Read them together
before relaxing either.

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
- **A folder is a real directory, and never part of the identity.** Cards may sit anywhere
  under `data/characters`, so paths resolve by searching the tree for the filename
  (`resolveCharacterFile`) rather than by joining it onto the root. That is what makes a move
  a plain `rename(2)` with no reference cascade — chats, dialogue colours and backups all key
  on the bare filename, so reorganising in a file browser, which this feature exists to
  permit, would otherwise orphan every chat with no way to reconnect them. The price is that
  `characterExists` spans the whole tree, so names are unique library-wide rather than per
  folder. Same reasoning as the persona rule: an id something else stores must not change for
  a cosmetic reorganisation.
- Anything that walks the character directory must **recurse**. A flat `readdirSync` there is
  a bug now: it silently skips every foldered card. `rewriteWorldLinks` and
  `readLibraryStats` were both fixed for this and both would fail quietly, not loudly.
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
  `injection_depth` (0 = after the last message). Ties at one depth read **low→high
  `injection_order`**, and within one order **assistant→user→system**, toward the model's
  last word — so a higher order sits **closer to the end**. That is SillyTavern's ordering
  (`populationInjectionPrompts` in `openai.js`: it walks order groups high→low over the
  newest-first array, then reverses; the UI's "low/top to high/bottom" says the same), and
  it is what makes presets with tuned priorities read the same in both apps. The author's
  note riding an absolute scenario uses `order − 1` for beforeScenario / `order + 1` for
  afterScenario, which only works under this reading.
- A card's `system_prompt` / `post_history_instructions` override `main` / `jailbreak`
  unless the prompt sets `forbid_overrides`.
- `is_system` on a message means "hidden from prompt" — still shown in the transcript.
- `continue` reshapes the finished array: `continue_prefill` moves the partial reply to
  the very end (past prompts ordered after chatHistory, or the model answers those
  instead); otherwise `continue_nudge_prompt` is appended. `continue_postfix` is the join
  between old text and new, and the client's stream seed must use the same one.

**Guided generations** (`shared/prompt/assemble.ts`, `src/features/chat/GuidesPopover.tsx`)

Ported from SillyTavern's Guided Generations extension, reimplemented rather than copied.
Three features; the built-in generated guides, the stat tracker and profile switching are
deliberately not among them.

- **Guidance is a `DepthInjection`, not a message.** The composer text is wrapped in
  `guidance.template` and spliced in at `guidance.depth` (default 0 — after the last
  message, the model's last word). It never enters the transcript, which is the whole
  point: steering a reply should not leave a turn nobody wanted to read.
- **`{{input}}` rides the macro engine's `extra` hook**, the same mechanism `{{original}}`
  uses for card overrides — not a string replace. So it expands in the engine's single
  pass, exactly once, and **macros the user typed stay literal**: a `{{setvar}}` in the
  steering box must not mutate chat state. The extension's `String.replace('{{input}}', …)`
  also substitutes only the first occurrence.
- **One-shot means one-shot.** Guidance exists only as an argument to `generate`, so unlike
  an ephemeral injection parked in chat metadata there is nothing to leak into the next
  generation or survive a failure that skipped its cleanup. ST needs a `/flushinject` in a
  `finally` on top of its own `ephemeral` flag; we need nothing.
- **Guided response is mode `send` without a user message**; guided swipe is mode `swipe`,
  bypassing `swipe()`'s cached-alternate branch. Neither touches the reducer, so both
  settle through the existing undo table — a failed response drops its placeholder, a
  failed swipe drops its blank alternate.
- **Persistent guides live in `ChatMetadata.guides`**, per chat, like the Author's Note and
  like ST's `chat_metadata.script_injects`. `id` is opaque and `name` is editable (the
  persona rule, not the lorebook one). Each enabled, non-blank guide is pushed as its own
  injection even though they share a depth and coalesce anyway — that is what attributes a
  broken macro to `guide:<id>` rather than to a merged blob.
- Guides and guidance are pushed **last** into `depthInjections`, so when several sources
  share one wire position `groupDepthInjections` reads world info and the note first, then
  the standing guides, then the one-shot steer.
- `tokenCounts.guides` and `.guidance` are **their own keys**, never folded into
  `worldInfoDepth` — that one is already the sum over every grouped injection.
- The composer **does not clear on a guided action**. It is an instruction, not a turn, and
  keeping it makes "guide, then guide the swipe the same way" one retype instead of two.
  ST clears and then needs a whole Recover Input button to undo that.

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
- **A user message records the persona it was sent as** (`persona_id`), the same way it
  records `name`: switching persona mid-chat must not re-face or re-colour the transcript.
  Null means "sent with no persona", missing means a legacy message; `chat/loaded` stamps
  legacy user messages with the chat's persona so the history freezes while it can still
  be reconstructed. In storage the column is NULL for "not recorded" and `''` for the
  explicit none — the two states must not collapse. Rendering resolves each row's speaker
  (`ChatView`'s `UserMessageBubble`), falling back to the chat persona only for the
  not-recorded case.

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
- **Streaming renders `*em*` / `**strong**` live, from a linear segmenter, not a parser.**
  `streamSegments` pairs asterisk runs in the same single pass that colours dialogue:
  a run opens unless followed by whitespace (so `* bullets` stay literal), closes unless
  preceded by it, `**` pairs before `*`, and an opener that never closes italicises to
  the end of the stream — "emphasis in progress", with the delimiter hidden instead of
  flickering until its pair arrives. Delimiter runs become `hidden` segments the
  renderer drops, exactly as markdown consumes them, even when they sit inside another
  pair's content (`*a **b** c*`). Escaped `\*` and code spans stay literal. The settled
  react-markdown render remains authoritative; a nested case the segmenter gets wrong is
  invisible, not wrong, because the bubble swaps to it the moment the commit lands.
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

**World Info** (`shared/worldinfo/`)
- `character_book` (embedded, `entries` is an **array**) and a standalone book
  (`entries` is an **object keyed by uid**) differ structurally *and* by field name.
  `convert.ts` maps both directions, verified against ST's own `convertCharacterBook`
  (`world-info.js:5498`) and `convertWorldInfoToCharacterBook`
  (`endpoints/characters.js:663`).
- Top-level renames: `key`↔`keys`, `keysecondary`↔`secondary_keys`,
  `order`↔`insertion_order`, `disable`↔`!enabled`. **Everything else lives in
  `entries[i].extensions`**, including two camelCase names sitting among snake_case ones:
  **`useProbability`** and **`selectiveLogic`**. They look like typos. They are not.
- ST writes `use_regex: true` unconditionally and degrades `position` to
  `before_char`/`after_char` at the top level, with the real numeric value in
  `extensions.position`. **The extension wins on read**; the top-level field is only the
  fallback for a book written by something that isn't ST.
- `originalData` holds the embedded book exactly as parsed. `toCharacterBook` rebuilds
  each entry from its original before overwriting mapped fields — that is what carries
  per-entry unknown **top-level** keys (`priority`, `name`, vendor keys) that the
  extensions bag does not cover. Never emitted into a `character_book`.
- `nextUid` is `max + 1` over the live entries **and `originalData`**. Reusing a uid freed
  by a delete would graft the deleted entry's unknown keys onto a new one.
- Never iterate `book.entries` for anything order-sensitive: numeric-looking keys iterate
  in ascending *numeric* order, so `"2"` precedes `"10"`. Use `bookEntries()`.
- `order` is a **weight** (ties legal, higher = closer to the chat); `displayIndex` is a
  **permutation** (the editor's list order). Dragging rewrites `displayIndex` only —
  rewriting `order` would mutate a compatibility-relevant field and have to invent
  distinct values for tied entries.
- Entries are sorted **descending** by `order` then `unshift`ed into their bucket, so the
  emitted block reads ascending with the highest `order` last. That is ST
  (`world-info.js:88` + `:5095`), and it is why a higher `order` feels "more important".
- The scan buffer joins messages newest-first with `\n\x01` **and starts with `\x01`**.
  That head sentinel is what makes `(?:^|\W)` whole-word matching treat the first message
  like every other, and it stops a key spanning the seam between two messages.
- `vectorized: true` **excludes** the entry. In ST those are reachable only by vector
  search, so treating the flag as absent would fire them where ST never would. Contrast
  `sticky`/`cooldown`/`delay`, which only ever *suppress* — carried, unread.
- The client must never send the server a whole `character_book`. `mergeCardData`'s spread
  is shallow, so it replaces the book wholesale (correct: entries are an array, and a deep
  merge cannot express "deleted"). The per-uid endpoints read the stored PNG, mutate one
  entry and write it back, so a stale tab cannot write a mass deletion.

**Personas** (`server/lib/personas.ts`)
- A lorebook's filename **is** its name — a card links to one by name via
  `extensions.world`, so renaming is a file move. A persona's filename is an **opaque id**
  and `name` is an editable field, because `ChatMetadata.persona` stores that id and a
  typo fix must not orphan every chat referencing it. Opposite rules, on purpose.
- **The chat wins.** `AppSettings.personaId` is the default for *new* chats;
  `ChatMetadata.persona` is what *this* chat uses. A transcript records who you were when
  you wrote it, so changing the default must not relabel past messages.
- **Picking before a chat is picking for the next one.** With no chat open there is no
  `ChatMetadata.persona` to write, so the persona grid's click sets `AppSettings.personaId`
  instead — choose who you are, then open a character, and the new chat starts with it.
  With a chat open the same click writes the chat's persona. One control, two targets,
  routed by `hasChat`; the pick button is never disabled for want of an open chat.

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

**Unsupported World Info positions are folded, not dropped.** ANTop/EMTop/outlet →
`before`; ANBottom/EMBottom → `after`, flagged so the inspector says "placed at Before
(Author's Note top unsupported)". Silently discarding an author's lore is worse than
placing it slightly wrong and saying so.

**The activation engine substitutes no macros.** Assembly does, exactly once, where the
environment lives — so the double-substitution class of bug cannot exist. Cost: the World
Info budget is measured pre-substitution. Deliberate.

**`use_regex` is written but ignored on read.** A key is a regex iff it parses as a
`/…/flags` literal, same as ST — the flag is written only for a clean diff.

**World Info randomness is seeded**, on `chatId` + the last **user** message id, so
regenerate/swipe/continue see identical lore and a new turn rolls fresh. Keyed on the last
*user* message because `generate` appends the assistant placeholder before assembling, so
the last message id is a fresh uuid on every attempt. And a draw is **skipped**, not
consumed, for an entry that was never going to roll (`probability >= 100`, `<= 0`, or
`!useProbability`) — with a seeded generator, spending a draw on a foregone conclusion
would mean adding one always-on entry reshuffled every later roll.

**Only admitted entries feed recursion.** ST also recurses on entries that failed the
budget check, pushing content into the scan buffer that was never sent.

**Only `{{...}}` is reported as an unresolved macro.** The diagnostic pass used to flag
any `<UPPERCASE>` token too, on the theory that it might be a missed legacy identity
macro. It never could be — `<USER>`, `<BOT>`, `<CHAR>`, `<GROUP>` and `<CHARIFNOTGROUP>`
are substituted earlier, and those five are the only ones ST ever had. Everything else in
angle brackets is ordinary prompt text, and popular presets are full of pseudo-XML section
markers like `<POV>`, so the check produced nothing but false positives and taught the
warning count to mean nothing.

### Replicated on purpose

Two ST matching behaviours look like bugs and are kept anyway, each with a named test so
nobody "fixes" them. Books were authored against them, and changing which entries fire in
somebody's existing library is worse than an odd rule — per-entry `matchWholeWords` and
regex keys are the escape hatches.

- A **multi-word key skips whole-word matching** entirely and becomes a substring test, so
  `red dragon` matches inside `bored dragonfly` (`world-info.js:349`).
- The boundary regex uses `\W` with **no `u` flag**, so every non-Latin letter counts as a
  word boundary — Cyrillic, Greek and CJK keys effectively lose whole-word matching.

## UI conventions

- **Character Creator Studio is a separate area, not a modal or panel.** It deliberately
  replaces the chat shell for full-card authoring, so it is the explicit exception to the
  usual "chat stays live" rule. Entering flushes the active chat and right panel first; exit
  flushes the Studio card queue first. A failed flush aborts the transition rather than hiding
  unsaved work. The normal right-panel character editor remains the quick-edit surface.
- **A full-width header row over three columns.** The chat column is `1fr` so panels
  compress it rather than cover it. Widths are CSS variables on `.shell`, animated with
  one transition; the header row is a **fixed** track so `grid-template-columns` stays the
  only animated property.
- The bar spans every column (`grid-column: 1 / -1`). That is the mechanism, not a detail:
  the bar's own width never changes as the columns animate, so the button clusters stay
  pinned to the screen edges instead of sliding when a panel opens.
- Panels are **wide** (`clamp(380px, 25vw, 560px)`), matching ST's gutter. That width is
  what lets the full character editor live in the right panel.
- **No blocking modals.** The chat stays live and usable while anything else is open.
  Destructive actions use a two-click confirm in place, not a dialog.
- All colour, spacing, sizing and motion comes from `src/styles/tokens.css`. Components
  must not hardcode any of it — restyling should mean editing that one file.
- **Both sides are multi-destination**, routed by a panel id rather than an open/closed
  boolean plus a tab: left is Connection / Prompts / Generation / Inspect, right is
  Characters / Lorebooks / Persona / Appearance. Pressing the button of the panel already
  showing closes that side. A boolean and a tab can disagree; an id cannot.
- The bar buttons are **toggle buttons, not tabs** — `aria-pressed` + `aria-expanded` +
  `aria-controls`. `role="tab"` would promise arrow-key navigation between siblings, and
  these panels are not siblings under one container.
- **Closing a side unmounts its panel**, unlike the old collapse-in-place, so closing has
  to flush pending autosaves exactly like switching does. The panels' own unmount cleanups
  are fire-and-forget and swallow errors; routing through `flushRightPanel` is what makes
  a failed flush abort and surface.
- The chat picker stays under Characters, because it is scoped to the selected character.
- **One lorebook editor** serves both the standalone books and the embedded
  `character_book`; persistence is callbacks. The entry form is ~20 controls with
  non-obvious semantics, and drift between two copies would be invisible — a book would
  behave differently depending on which screen you edited it in.
- `NumberField`, `SelectField` and `TriCheckField` are shared for reasons, not tidiness:
  a number bound straight to an input cannot be cleared (`Number('') === 0`); a select
  must map back through its options **by index**, since `WiPosition`/`WiLogic`/`WiRole`
  are numeric and include `0`; and `scanDepth`/`caseSensitive`/`matchWholeWords` are
  `T | null` where null means "inherit", which a plain checkbox cannot express.
- `TagField` is **not** safe for World Info keys — `/foo,bar/i` is one legal key. Use
  `KeyField`, which splits via `shared/worldinfo/keys.ts`.
- **`Popover` is the only popup mechanism**, and `Menu` is its data-driven list variant.
  Menu entries are *data*, not JSX children, which is what lets `buildChatMenu` and
  `buildMessageMenu` be pure tested functions rather than components; `GuidesPopover` uses
  the shell directly because a form is not a list. Both are non-modal, so neither
  contradicts the no-modals rule. Anything that focuses an element inside a popup must pass
  `focus({ preventScroll: true })`: the layout is fixed to the viewport, and a browser
  scrolling to "reveal" an element drags the whole app out from under it.
- `Popover` **flips its side when the preferred one has no room**, measured in a layout
  effect on open. Without it a bubble's ⋯ near the bottom of the window opens a popup that
  runs off screen, and the last entries — delete among them — cannot be reached. A flip
  rather than a portal, so the popup stays a DOM child of `.popover` and dismissal keeps
  working on ordinary containment. It is controlled (`open` + `onOpenChange`) because both
  consumers need to close it from inside their own content. Escape closes **and restores
  focus to the trigger**; an outside click closes without restoring, since the click has
  already put focus where the user wanted it. The same effect measures the room **inside
  the nearest clipping ancestor** — the chat column, not the viewport; viewport numbers
  overestimate by the top bar — and caps the popup's height to it, so a popup **grows with
  its content** up to the available space and only scrolls past that. The stylesheet cap
  (`min(60vh, --wc-scroll-cap)`) still governs where set; the menu overrides it to `none`,
  because a full menu plus a user-grown list must not scroll while screen remains.
- `Menu` entries may carry a **submenu whose flyout opens to the side** — on hover, click,
  or ArrowRight. The flyout is `position: fixed`, not a nested Popover: the menu popup is a
  scroll container, and anything absolutely positioned inside it would be clipped. Fixed
  escapes that because no ancestor of the popup carries a transform or filter (glass puts
  its backdrop-filter on the bar and panels, never here) — and it stays a DOM child of the
  menu, so the parent's outside-click dismissal contains it and closing the menu unmounts
  it. Hover-open does not take focus; keyboard- and click-open do. Escape/ArrowLeft inside
  the flyout closes only the flyout and refocuses its trigger — the stopPropagation is
  load-bearing, since Popover's own Escape dismisses everything.
- **Disabled beats refused.** SillyTavern toasts "stop the generation first"; we have no
  toast system, so a blocked entry is `disabled` with a `disabledReason` that becomes its
  `title`. Same information, no new machinery.
- **Quick commands are app-wide settings, and nothing ships in the box.** `quickCommands`
  in `settings.json` is a flat array carried by `mergeSettings`'s spread, but normalised —
  a stale tab or `{"quickCommands": null}` must not wipe user-written commands. The persona
  rule again: `id` opaque, `name` editable. The whole feature lives in the burger menu: a
  **Quick commands submenu** whose flyout lists the usable ones (blank text inserts
  nothing, so blank commands stay out) ahead of an "Edit quick commands…" entry that is
  the discovery path when the list is empty. Commands are **not gated on `busy`**: picking
  one only fills the composer, and queueing your next move mid-generation is the point.
  The editor opens from inside the flyout but **anchors to the burger button** — its
  Popover root is stretched over the ChatMenu wrapper, exactly that button's box, so the
  popup's ordinary CSS anchoring grows it from the right place with no trigger of its own.
  The composer never grew a button for this feature.
- **The composer's draft has exactly one write path: `ComposerHandle.insert`.** The draft
  stays private `useState` — the `onSend` bargain — so quick commands reach it through a
  React 19 ref-as-prop imperative handle, never lifted state. `insert` appends on a newline
  when there is a draft, replaces when there is not, and focuses the textarea **one tick
  later**: `Menu` restores focus to its trigger *after* `onSelect` runs, so an immediate
  focus would lose the race and the cursor would land on the burger button, not the box.
- **Presets save explicitly, characters autosave.** The difference is what a mistake
  costs: a card field is one value you can retype, a preset is a tuned artefact where
  "that felt worse" needs a way back. Editing a preset raises a Save/Revert bar and
  disables preset switching, rename and import until it is resolved — Revert re-reads the
  file, which is the only authority on what the preset was.
- **The preset draft lives above the left panel's router** (`usePresetDraft`, called from
  `App`), and the Save/Revert bar renders **once**, in the panel's chrome slot outside the
  scrolling body — so it shows on all four left panels, Connection and Inspect included.
  If `dirty` lived inside a panel, editing a sampler and clicking Connection would unmount
  the bar: the edits would still be in `App`'s state with no way to save them, and the app
  would look saved. Losing work silently is worse than losing it loudly.
- **An editor that takes over its panel, not one appended below it.** `CharacterEditor`
  and `PromptEditor` both replace their panel's contents and offer a back button. Stacking
  an editor under a long list means scrolling to the field and back for every edit.

## Background and glass

- The background image is a layer **behind the whole shell**, spanning every row and column
  so it sits under the top bar too — that is what makes the bar read as glass over the
  image rather than a lid on top of it. A real element, not a `::before`: React sets
  `backgroundImage` directly, and `sanitizeFilename` permits parentheses, so a name like
  `sunset (2).jpg` would break a `url()` built from a CSS variable.
- Glass is **token redefinition, not component restyling**. `.shell[data-glass="true"]`
  redefines `--wc-surface` and friends, so every surface goes translucent without one
  component file changing.
- Legibility has three layers and all of them are required: a scrim (the contrast floor,
  independent of the image), a blur on the image (kills the high-frequency detail that dim
  alone cannot), and per-surface alpha floors. Plus the `@supports not (backdrop-filter)`
  and `prefers-reduced-transparency` / `prefers-contrast` fallbacks — without those the app
  is genuinely unreadable on some machines, so they are not polish.
- **`backdrop-filter` goes on the bar and the two panels only, never on message bubbles.**
  The panels are grid areas that never overlap the scrolling transcript, so each samples a
  static backdrop the browser can cache. Bubbles are N elements inside a scroll container,
  and each one would force a recomposite on every scroll frame. Nothing is lost: the
  backdrop is already blurred, so a second blur behind a bubble is invisible. For the same
  reason the bar must stay in its own grid row rather than floating over the chat.
- **Built-in backgrounds ship as bundled client assets**, not seeded into `data/` — `data/`
  is gitignored, and a seeded file would be deletable with no way back. They are authored
  SVG gradients rather than copies of SillyTavern's images, which are AGPL assets. The
  Appearance panel offers a one-click import for anyone who wants ST's, copying from their
  own local install into their own gitignored `data/` — nothing is redistributed.

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
- `shared/worldinfo/convert.test.ts` round-trips Seraphina's embedded book and proves the
  survival rules: every ST extension key both directions, unknown extension *and*
  top-level keys, duplicate ids reassigned rather than overwritten, and a uid freed by
  deleting the highest entry never reused.
- `shared/worldinfo/match.test.ts` pins the matching semantics, including both replicated
  quirks and that `g` is stripped so a cached regex is not stateful.
- `shared/worldinfo/activate.test.ts` covers the engine: budget cutoff, `ignoreBudget`,
  recursion with exclude/prevent, group winners, seeded determinism, and that a certain
  entry consumes no draw.
- `server/lib/settings.test.ts` gates the field-wise merge — a partial `worldInfo` patch
  must not reset the fields it did not mention.
- `shared/prompt/assemble.test.ts`'s `guided generations` block pins the injection rules:
  guidance last, guides before the last message, disabled and blank guides contributing
  nothing, several guides sharing one wire message in list order, and that a `{{char}}`
  typed by the user stays literal while one in the template expands.
- `src/features/chat/guides.test.ts` covers the list edits, including that `nextGuideName`
  fills the lowest free slot rather than counting entries.
- `src/features/chat/quickCommands.test.ts` does the same for quick commands, including
  that blank-text commands are unusable and an unnamed one borrows its label from the text.
- `src/features/chat/ChatMenu.test.ts` pins the chat menu's gating: Continue unavailable
  on a user-final transcript, checkpoint and regenerate unavailable on an empty one, every
  action but the panel jumps and the quick commands disabled mid-generation, and every
  disabled entry carrying a reason. There is no DOM test harness in this project, so menu
  logic lives in a pure `buildChatMenu` and the React wrapper stays thin — the same split
  as `composeLorebookSources` in `useLorebooks`.
- `server/lib/location.test.ts` gates the data-directory rules. Two are load-bearing rather
  than thorough: an unreachable pointer must fall back **and leave the pointer file's bytes
  untouched** (rewriting it is how an unplugged drive silently becomes a lost setting), and a
  symlink pointing at `/usr` must be refused (without resolving symlinks first, every
  containment guard is trivially walked past). The cloud table asserts its negatives too —
  `Documents/Dropboxes` must not match, because a false alarm teaches users to click through
  the warning that matters.
- `server/lib/folders.test.ts` and `characters.test.ts` gate the folder rules: traversal is
  contained, a duplicate basename resolves to the same file every time (shallowest wins),
  a move leaves the avatar untouched, deleting a folder lifts its cards rather than deleting
  them, and a lorebook rename reaches a card inside a folder — that last one is the flat-walk
  regression, and it is the kind that corrupts a library in silence.
- `server/lib/paths.test.ts` pins that `setDataDir` rewrites `PATHS` **in place**, so a
  reference taken beforehand follows the move. That single assertion is what the ~60
  untouched call sites rest on. Note the loud comment at the top: `paths.ts` is module state
  shared by the whole `bun test` process, so any test that repoints it must put it back or
  the failure lands in an unrelated file.
- `server/lib/transfer.test.ts` runs the same move both ways (`rename` and, via `forceCopy`,
  the cross-disk copy) against a real seeded database, and checks what would actually hurt:
  the chat row still reads back, `quick_check` passes, no `-wal` reaches the destination,
  `secrets.json` is still 0600, and a failed copy leaves the source untouched.
- `src/features/appearance/dataLocation.test.ts` covers `describeVerdict`, including that
  every disabled state carries a reason — same convention as `ChatMenu.test.ts`.

When touching a format, add the test before the code.
