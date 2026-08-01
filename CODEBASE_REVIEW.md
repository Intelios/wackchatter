# WackChatter Codebase Review

**Review date:** 1 August 2026  
**Scope:** All first-party server, shared, client, style, configuration, and test code in the repository  
**Focus:** Bugs and glitches, speed, and engineering quality  
**Explicit exclusion:** Visual design and aesthetic polish. The intentionally barebones UI is not treated as a defect.

## Executive summary

WackChatter has a strong core architecture. The separation between prompt assembly, provider request construction, persistence, and React presentation is clear; strict TypeScript and the unusually thorough SillyTavern-compatibility tests catch many subtle format failures. Streaming text being kept outside React state is exactly the kind of decision an ultra-fast chat client should make.

The largest risks are not in those well-tested pure modules. They are at the boundaries:

1. **The API binds to every network interface by default and has no authentication.** Other devices able to reach the machine can mutate local data, replace provider keys, or initiate billed generations.
2. **Character-card writes are not awaited, and several autosave editors drop or race updates.** These paths can acknowledge a save that has not completed, lose the last edit when navigating, or allow an older write to overwrite a newer one.
3. **Renames do not preserve referential integrity.** Character renames orphan chats; lorebook renames/deletes leave character-card and global-setting references stale.
4. **Prompt history packing is quadratic.** A measured 1,000-message assembly took approximately 1.32 seconds on the review machine. Appending one message to a cached 500-message transcript still took approximately 245 ms.
5. **Tests are excellent for pure compatibility logic but sparse around routes, file storage, asynchronous failure, and React lifecycle behavior.** The aggregate coverage figure therefore looks healthier than the actual risk boundary.

The product is already fast in several important ways, but fixing persistence correctness and incremental prompt accounting should precede feature expansion.

## Validation performed

- Read the full first-party source tree and its supporting tests: 133 tracked files and roughly 24,000 lines including tests and styles.
- `bun test`: **484 passed, 0 failed**.
- `bun run build`: **passed**, including TypeScript checking.
- `bun run lint`: **passed**, 128 files checked.
- `bun test --coverage`: **80.31% functions / 85.22% lines** among loaded modules. This excludes many modules that no test imports, so it is not whole-repository coverage.
- Ran targeted reproductions for non-stream provider errors, World Info recursion, filename handling, chat persistence, PNG rewriting, and prompt-assembly scaling.

Priorities used below:

- **P0:** Immediate security, privacy, or uncontrolled-cost exposure.
- **P1:** Data-loss risk, major correctness failure, or a primary performance blocker.
- **P2:** User-visible defect or meaningful scalability/maintainability issue.
- **P3:** Hardening or lower-impact improvement.

## Bugs and glitches

### WC-01 — The unauthenticated API is exposed to the local network

**Priority: P0**  
**Evidence:** `server/index.ts:81-90`

`Bun.serve` is given a port and fetch handler but no hostname. Bun's documented default hostname is `0.0.0.0`, not loopback. Every API route is therefore reachable from other hosts when the operating system/network permits it, and the API has no authentication or origin check.

This is more than passive data exposure. The routes can modify settings and secrets, delete or replace library data, test arbitrary endpoints, and start provider-billed generations.

**Recommendation:** Bind to `127.0.0.1` by default. If remote access is ever offered, make it an explicit opt-in with authentication, restrictive CORS/origin checks, and clear exposure warnings. Validate `Host`/`Origin` even on loopback to reduce browser-based cross-site request risks.

### WC-02 — Character writes report success before the data is durable

**Priority: P1**  
**Evidence:** `server/lib/characters.ts:96`, `:118`, `:134`, `:186`, `:278`; `server/lib/lorebooks.ts:98`

The character storage functions call `Bun.write(...)` without awaiting its promise. Callers receive success while the write is still pending, write failures become unobserved rejections, and overlapping updates may settle out of order. The rename path is particularly unsafe because it starts a write and then immediately renames the file.

The lorebook rename path similarly discards the promise returned by the follow-up save.

**Recommendation:** Make all mutation functions asynchronous and await every write. Write to a temporary sibling file, flush/close it, and atomically rename it over the destination. Serialize writes per character/lorebook or reject stale revisions so an older request cannot win a race.

### WC-03 — Autosave lifecycle and concurrency can lose edits

**Priority: P1**  
**Evidence:** `src/features/character/CharacterEditor.tsx:51-83`; `src/features/lore/LorePanel.tsx:96-101`; `src/features/persona/PersonaPanel.tsx:102-126`; `src/features/lore/EmbeddedBook.tsx:28-70`

Several editors debounce writes but clear their timers on close, selection change, or unmount without flushing the pending change:

- A character edit made less than 700 ms before leaving the editor is discarded.
- A lorebook edit made shortly before switching books is discarded. One shared timer also means editing book B can cancel a pending save for book A.
- Persona patches can be dropped on selection changes or failures; a delayed callback can observe a reset queue.
- Embedded-lore entries use independent timers that concurrently perform whole-card read/modify/write cycles. Changes to two entries can overwrite one another.

Overlapping character saves are also not ordered. A slow older response can update both the file and parent state after a newer response.

**Recommendation:** Introduce one reusable, revision-aware autosave queue per entity type. It should keep immutable snapshots, coalesce only updates to the same entity, serialize requests, flush on controlled transitions, retain failed work for retry, and ignore stale responses. The existing chat save queue is a useful starting pattern, though it also needs delta-saving work described later.

### WC-04 — Rename and delete operations leave broken references

**Priority: P1**  
**Evidence:** `server/routes/characters.ts:150-157`; `server/routes/lorebooks.ts:70-95`; `server/lib/chats.ts`; `server/lib/settings.ts`

Filenames are identities in the current model, but the necessary cascades are incomplete:

- A character rename does not update `chats.character_id`, orphaning existing transcripts from that character.
- The client defines `characterApi.rename` but does not call it, so editing a character's name changes card metadata without renaming the file identity.
- A lorebook rename/delete updates persona references, but not character-card `data.extensions.world` references.
- A lorebook rename/delete does not update `settings.worldInfo.globalLorebooks`, leaving invisible stale global selections.
- Character deletion leaves chats behind without an explicit archive/orphan policy.

The lore UI says rename updates links, which is only partially true.

**Recommendation:** Put reference updates in a single server-side transaction/coordinator and test every referring store. For characters, either cascade chat identity changes or move to an immutable opaque ID with an editable display name. For deletion, deliberately choose cascade, archive, or refusal while referenced.

### WC-05 — A cancelled lore fetch can be cached as completed forever

**Priority: P1**  
**Evidence:** `src/features/lore/useLorebooks.ts:129-157`

The hook adds a lorebook ID to `fetchedRef` before its request finishes. If the effect is cleaned up while the request is in flight, a successful response is not stored because `cancelled` is true, but the ID remains marked as fetched. Later effects skip it permanently. The dependency set changes frequently as character, persona, and global sources change, so this is a realistic silent omission from prompt assembly.

**Recommendation:** Cache explicit `idle/loading/loaded/error` state or the in-flight promise. Mark an item loaded only after its data is committed; clear or retry cancelled/failed requests. Prefer an abort signal where the API layer supports one.

### WC-06 — Character autosaves can reload the wrong chat or create duplicates

**Priority: P1**  
**Evidence:** `src/features/chat/useChat.ts:239-273`

The chat-initialization effect depends on the full `character` object, not just the character identity. A character autosave replaces that object, rerunning chat listing and reopening the most recent chat. If the user currently has a different transcript open, it can be replaced unexpectedly.

For a new character with no chats, repeated effect runs can also issue multiple create requests. Cancelling the React effect does not cancel the server mutation.

**Recommendation:** Key chat initialization only on `characterId`. Read mutable greeting/card data from a ref when creation is actually required. Deduplicate creation with an in-flight promise/idempotency key and never let background initialization replace an explicitly selected chat.

### WC-07 — The app can pay for multiple completions and use only one

**Priority: P1**  
**Evidence:** `shared/providers/request.ts`; `shared/providers/sse.ts:203-205`, `:278-280`

The request builder forwards preset `n` values greater than one, but both streaming and non-stream parsing read only `choices[0]`. Extra completions are discarded despite consuming provider work and potentially billing. In a stream, taking the first array element in each chunk is not a safe substitute for following a stable `choice.index`.

**Recommendation:** Clamp `n` to 1 until multi-choice UI/storage is intentionally implemented. Alternatively, accumulate every choice by index and add the results as distinct swipes.

### WC-08 — Non-stream provider errors are swallowed

**Priority: P2**  
**Evidence:** `src/lib/api.ts:383-388` versus streamed handling at `:434-436`

For a successful HTTP response containing a completion-shaped error object, the non-stream path parses and returns without checking the accumulator's `error`. The streaming path does check it.

A targeted reproduction with `{\"error\":{\"message\":\"provider exploded\"}}` returned normally with empty content instead of throwing. This can make a failed generation look like a blank successful reply.

**Recommendation:** Apply the same final error check to both paths and add direct tests for `streamGenerate`, not only for the pure SSE accumulator.

### WC-09 — Long and Unicode filenames can become unreadable after creation

**Priority: P2**  
**Evidence:** `server/lib/paths.ts:53-70`

Filename sanitization truncates the complete filename to 200 JavaScript characters after callers append `.png` or `.json`. A maximum-length stem therefore loses its suffix. The file may be written, but later list/get code filters or resolves it differently, making it effectively disappear. Character creation can exhibit the same identity mismatch.

The limit is counted in UTF-16 code units rather than filesystem bytes, so 200 emoji produce a 400-byte UTF-8 name, above common 255-byte component limits. The Windows reserved-name check also allows names such as `CON.json`, and the containment check assumes `/` separators.

**Recommendation:** Sanitize the stem separately, reserve the suffix length, enforce a UTF-8 byte budget, reject reserved basenames before their extension, and use `path.resolve`/`path.relative` with platform separators for containment. Add boundary/property tests.

### WC-10 — `ignoreBudget` World Info entries can still be skipped after budget exhaustion

**Priority: P2**  
**Evidence:** `shared/worldinfo/activate.ts:459-462`

After an ordinary recursive entry exhausts the World Info budget, the recursion loop breaks. That prevents a remaining `ignoreBudget` entry from being matched against newly admitted recursive content, even though the editor promises it is always includable after the budget is spent.

A targeted three-entry reproduction activated the recursive source, rejected a normal entry for budget, and then never considered the `ignoreBudget` entry keyed by the source text.

**Recommendation:** Stop considering normal entries after exhaustion, but continue recursion while an unmatched eligible `ignoreBudget` entry can still activate. Add this exact case beside the existing activation tests.

### WC-11 — The avatar picker advertises formats the server rejects

**Priority: P2**  
**Evidence:** `src/features/character/CharacterEditor.tsx:171-179`; `server/lib/card.ts`

The client accepts PNG, JPEG, and WebP, while character-card writing requires a PNG container so it can embed `tEXt` chunks. Choosing JPEG or WebP therefore fails after the UI has said the file is acceptable.

**Recommendation:** Restrict the picker to PNG for now, or explicitly transcode other formats to PNG before upload and explain the conversion.

### WC-12 — Prompt preview and generation can resolve seeded macros differently

**Priority: P2**  
**Evidence:** `src/features/chat/useChat.ts:396-412`; `src/features/preset/usePromptPreview.ts:78-92`

Generation supplies the chat ID as the assembly seed, but prompt preview omits it. Seed-dependent macros such as picks can therefore show different content and token counts from the payload actually sent.

**Recommendation:** Build preview and generation through one shared assembly-input function, including the same seed, continue settings, persona/card context, and World Info inputs. Test that preview messages equal generation messages for the same snapshot.

## Speed and scalability

### PERF-01 — History packing is quadratic and is the main measured latency risk

**Priority: P1**  
**Evidence:** `shared/prompt/assemble.ts:719-742`; `shared/prompt/token-cache.ts`; `src/lib/tokenizer.ts:37-47`

For every candidate history message, assembly rebuilds the growing candidate prompt, materializes it, and counts the entire array again. This makes history packing approximately O(n²) in transcript length. The cache helps only when the exact same message array is counted; appending one message invalidates all growing-prefix keys.

Measured with the real `cl100k_base` tokenizer on the review machine:

| History size | Cold assembly |
|---:|---:|
| 100 messages | 35.5 ms |
| 250 messages | 89.8 ms |
| 500 messages | 329.2 ms |
| 1,000 messages | 1,316.8 ms |

With a persistent cache, a 500-message repeat fell to 20.6 ms, but appending one message still cost 244.6 ms.

**Recommendation:** Precompute fixed prompt cost and each history message's token contribution, then pack with a running total. The current tokenizer envelope is additive, so most candidates do not require recounting the full array. Handle squash/continue transforms with targeted adjustments and perform at most one authoritative full validation at the end. Cache per-message materialization/token cost by content plus macro environment revision rather than JSON-stringified growing arrays.

### PERF-02 — Every card autosave rewrites and rechecksums the entire PNG

**Priority: P1**  
**Evidence:** `server/lib/png.ts:110-142`, `:170-201`; `server/lib/characters.ts`

Changing one metadata field reads the full avatar, reconstructs every PNG chunk, recalculates CRCs for unchanged image-data chunks, and writes the full image again. Combined with frequent autosave, cost scales with avatar size rather than metadata size.

Synthetic rewrite measurements:

| PNG size | Metadata rewrite CPU time |
|---:|---:|
| 1 MiB | 6.9 ms |
| 5 MiB | 15.6 ms |
| 20 MiB | 106.7 ms |

Disk I/O and competing writes are additional. Large cards can therefore make ordinary text editing feel slow and increase the race window identified above.

**Recommendation:** Preserve raw framing and CRC bytes for unchanged chunks, remove/replace only the `chara`/`ccv3` chunks, and splice the new chunks before `IEND`. Pair this with debounced, serialized, atomic writes. A metadata sidecar cache can further accelerate list views while keeping the PNG authoritative.

### PERF-03 — Library list endpoints repeatedly parse every complete file

**Priority: P2**  
**Evidence:** `server/lib/characters.ts:45-66`; `server/lib/lorebooks.ts:26-51`

Listing characters synchronously reads and parses every full PNG. Listing lorebooks parses every JSON file just to derive summaries and entry counts. Lorebook saves then refresh the whole list, turning a one-entry edit into work proportional to the entire library.

**Recommendation:** Cache summaries by canonical path plus `mtime`/size or maintain a rebuildable SQLite/sidecar index. Mutation endpoints should return the new summary so the client can update one item without immediately rescanning the library.

### PERF-04 — Every chat edit clones, transfers, and rewrites the whole transcript

**Priority: P2**  
**Evidence:** `src/features/chat/useChat.ts:152-160`; `src/features/chat/state/chatPersistence.ts:45-51`; `server/lib/chats.ts:135-152`, `:225-233`

The client clones the complete chat snapshot, the save queue clones it again, the API serializes all messages, and the server deletes/reinserts every message. This is simple and safe for short chats but scales linearly with every edit.

An in-memory server-only benchmark took about 28.6 ms and transferred approximately 827 KiB of JSON for 5,000 messages; browser cloning, stringify/parse, networking, and disk work are not included. Large `pagehide` keepalive bodies can also exceed browser limits and fail to persist the last edit.

**Recommendation:** Add revisioned message-level upserts/deletes or a compact operation log. At minimum, eliminate the double clone, skip unchanged rows, and expose save failures instead of treating unload keepalive as guaranteed durability.

### PERF-05 — Large modules are loaded before their features are needed

**Priority: P2**  
**Evidence:** production build output; `src/lib/useTokenizer.ts:29-45`

The production build reports:

- Main JavaScript: **538.06 kB** raw / **167.03 kB** gzip.
- `cl100k_base` chunk: **951.25 kB** raw / **436.16 kB** gzip.
- `o200k_base` chunk: **2,013.63 kB** raw / **1,016.87 kB** gzip.

The tokenizer is code-split, which is good, but tokenizer loading starts immediately even without a configured model or an imminent generation/preview. Panel-only editors, drag-and-drop, and Markdown functionality also contribute to the main path.

**Recommendation:** Defer tokenizer loading until a chat/prompt count is required, or schedule it during idle time after settings resolve. Consider a worker so tokenization cannot block interaction. Lazy-load panel editors and other feature-only dependencies. Track bundle budgets in CI rather than optimizing purely from the warning threshold.

### PERF-06 — Long transcripts render every message on ordinary state changes

**Priority: P2**  
**Evidence:** `src/features/chat/ChatView.tsx:65-88`

The transcript maps every message and `MessageBubble` is not memoized. The Markdown subtree is memoized, and streaming correctly bypasses parent React state, but reducer actions and save-status changes can still revisit the whole transcript. This will become visible in very long chats.

**Recommendation:** Memoize stable message rows and callbacks, isolate global controls/save state from the list, and virtualize/window the transcript once realistic long-chat profiling shows the crossover point. Preserve scroll anchoring and swipe height when doing so.

### PERF-07 — Generation logging and image delivery perform avoidable work

**Priority: P3**  
**Evidence:** `server/routes/generate.ts:30`, `:49-52`, `:72-76`; character image route

The generation route logs full request and response bodies, which can be large, slow terminals, and expose private conversation content. Character images are read again and served with `cache-control: no-cache`, despite the client having a modification version suitable for immutable URLs.

**Recommendation:** Put payload logging behind an explicit debug flag and log sizes/provider/status by default. Serve versioned image URLs with immutable caching or use ETags, and stream `Bun.file` rather than eagerly reading into memory.

## Engineering quality gaps

### QUAL-01 — Coverage is strongest where risk is lowest

**Priority: P1**

The pure compatibility core is exceptionally well tested: card conversion, prompt order/assembly, message swipe invariants, provider parsing, and World Info conversion/matching all have deep edge-case suites. However, there are few or no direct tests for:

- HTTP routes and their validation/error behavior.
- Character, lorebook, persona, and preset storage under write failure or concurrency.
- `streamGenerate` as an end-to-end client parser.
- Autosave timers, unmount/switch behavior, stale responses, and failed retries.
- Cross-store rename/delete cascades.
- Chat initialization effect races.

The coverage report cannot reveal all of this because files never imported by tests are absent from its denominator. For example, `src/lib/api.ts` showed only 21.04% line coverage, the DOM `Menu` 2.86%, and `useLorebooks` 27.41%, while many routes/storage modules were not represented at all.

**Recommendation:** Make boundary testing the next testing investment. Use temporary data directories and real route handlers for storage/API integration tests, fake timers plus deferred promises for hook/editor lifecycle tests, and filesystem fault injection for durability. Keep the existing pure suites unchanged; they are a major asset.

### QUAL-02 — File persistence is not consistently atomic

**Priority: P1**  
**Evidence:** settings, secrets, preset, lorebook, persona, and character storage modules

Most JSON and PNG saves write directly over the authoritative file. A crash, process termination, disk-full condition, or partial write can leave an empty/truncated artifact. Secrets require extra care because a failed replacement must not weaken mode `0600`.

**Recommendation:** Centralize an atomic writer: create a unique temporary sibling, set the intended mode, write, flush/close, and rename. Preserve a recoverable backup where corruption would be expensive. Add startup recovery for abandoned temporary files only when their identity and format validate.

### QUAL-03 — API payloads and persisted settings rely heavily on TypeScript casts

**Priority: P2**  
**Evidence:** `server/lib/http.ts:31-38`; `server/lib/settings.ts:56-57`, `:106-135`

`readJson<T>` only parses and casts; it does not validate. Imported presets/lorebooks and settings patches can contain malformed nested values that are later assumed valid. Known top-level settings are spread from disk without comprehensive normalization, while routing/header arrays and numeric values are trusted.

This is a local app, but malformed imports, old files, manual edits, and browser bugs are normal inputs—not hostile edge cases.

**Recommendation:** Add small runtime validators at persistence and route boundaries. Clamp finite numeric ranges, validate enums/arrays, cap request and upload sizes, and return field-specific 400 responses. Continue preserving unknown compatibility keys only in formats whose contracts require it.

### QUAL-04 — Async failures and stale responses are handled inconsistently

**Priority: P2**  
**Evidence:** `src/features/chat/useChat.ts`; `src/features/preset/SettingsPanel.tsx:87-95`; editor hooks

Some background calls deliberately discard promises, chat refresh converts an error into an empty list, and several UI actions have no local catch/retry path. Preset saving permits further edits while a request is in flight; an older successful response can clear `dirty` after a newer unsaved change. Settings patches can likewise settle out of order.

**Recommendation:** Standardize asynchronous state around request revisions and explicit `idle/saving/saved/error` states. A response may clear dirty state only if its submitted revision still matches the editor revision. Surface recoverable errors inline and keep unsaved snapshots available for retry.

### QUAL-05 — Some domain facts are inferred from position instead of stored explicitly

**Priority: P2**  
**Evidence:** `src/features/chat/ChatView.tsx:74-77`

Greeting macro rendering is applied to the first assistant message based on transcript position. If preceding messages are deleted or rearranged, an ordinary assistant reply containing `{{...}}` can be treated as a greeting.

**Recommendation:** Store an explicit greeting/source marker in message metadata at import/chat creation. Rendering should depend on the marker, not current array position.

### QUAL-06 — Repository automation and onboarding are thin

**Priority: P3**

The internal `AGENTS.md` is excellent and unusually precise, but there is no conventional README or checked-in CI workflow visible in the repository. New contributors and non-agent users have no short setup/architecture guide, and the passing test/type/lint/build gates are not visibly enforced on changes.

**Recommendation:** Add a concise README with prerequisites, commands, data safety, architecture, and format-compatibility principles. Add CI for tests, typecheck/build, lint, and eventually bundle/performance budgets.

### QUAL-07 — Styling conventions are drifting from the declared token contract

**Priority: P3**

This is **not a visual-design criticism**. The current barebones appearance is intentional. The maintainability issue is that components contain numerous hardcoded pixel, timing, and occasional color values despite the repository rule that spacing, color, and motion live in `src/styles/tokens.css`.

**Recommendation:** When UI design work begins, first migrate structural values into semantic tokens. That will make the planned visual redesign much cheaper and prevent component-specific constants from becoming accidental API.

## What is already strong

- **Compatibility preservation is treated as a data-integrity problem.** The card, preset, message, and World Info suites cover obscure but important SillyTavern behavior and unknown-key survival.
- **The streaming architecture is performance-aware.** Text ticks avoid React state and database writes, and the accumulator exposes cumulative text so throttled frames can be dropped safely.
- **Prompt assembly is client-side and inspectable.** This supports accurate wire-payload inspection and keeps the server small.
- **Provider construction is cleanly separated and tested.** Empty `stop`, optional authorization, OpenRouter-only fields, usage formats, abort forwarding, and SSE keepalives receive direct attention.
- **TypeScript strictness and lint/build health are good.** All current gates pass cleanly.
- **The domain boundaries are understandable.** Shared pure logic, thin server routing, and feature-oriented client folders make targeted improvements feasible without a rewrite.

## Recommended implementation order

### Phase 1 — Protect data and the machine

1. Bind the server to loopback and add origin/host protection.
2. Await, serialize, and atomically replace every persisted artifact.
3. Replace editor timers with revisioned autosave queues and flush controlled transitions.
4. Make character/lorebook identity changes update every reference transactionally.
5. Add integration and lifecycle tests for those fixes before broader refactoring.

### Phase 2 — Remove the main latency sources

1. Replace quadratic history packing with incremental token accounting and add a repeatable 100/500/1,000-message benchmark.
2. Splice PNG metadata without re-encoding unchanged chunks.
3. Cache library summaries and stop full rescans after single-item mutations.
4. Move chat persistence toward revisioned message deltas.

### Phase 3 — Correct edge behavior and harden boundaries

1. Clamp or implement multi-choice generation.
2. Fix non-stream error propagation, lore-fetch cancellation, and World Info `ignoreBudget` recursion.
3. Validate runtime payloads/settings and filename byte limits.
4. Align prompt preview inputs with real generation.
5. Add bundle budgets, deferred tokenizer loading, and long-transcript profiling.

## Suggested regression and performance gates

- A character/lorebook update never acknowledges before its atomic replacement completes.
- Rapid edits with deliberately reordered responses always persist the newest revision.
- Closing or switching an editor immediately after typing preserves or visibly reports the pending edit.
- Renaming a character preserves all chats; renaming/deleting a lorebook leaves no stale card, persona, or global-setting reference.
- Prompt assembly remains near-linear from 100 to 1,000 history messages and stays under an agreed device budget.
- Editing metadata in a large PNG does not recompute CRCs for unchanged `IDAT` chunks.
- A non-stream `{ error: ... }` response rejects generation and leaves no blank reply.
- A cancelled lore request can be loaded successfully on the next effect.
- `n > 1` is either rejected/clamped or produces the corresponding number of stored swipes.
- Filenames preserve their required suffix and remain below the filesystem byte limit for ASCII and Unicode inputs.

## Conclusion

WackChatter does not need an architectural restart. Its pure core is already disciplined and its performance intentions are visible in the streaming and prompt-inspection design. The next step is to bring the asynchronous boundaries up to the same standard: make storage durable and ordered, make identities transactional, then make prompt token accounting incremental. Those changes address the most serious correctness risks and the largest measured speed cost while preserving the lean product direction.
