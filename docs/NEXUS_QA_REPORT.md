# Memory Nexus — QA / Exploration Report

**Tester:** Claude (Opus 5) · **Date:** 2026-09-07 · **Branch:** `dev` (working tree, uncommitted Nexus feature)
**Method:** live browser session against `bun run dev:server` (8787) + `bun run dev:client` (5173),
using the `For Agents to Use` connection (`api.entrim.ai`, `deepseek-ai/DeepSeek-V4-Flash`) for
real paid generations. No source files changed.

> Status: **in progress** — this file is updated as testing proceeds.

## Severity key

| Tag | Meaning |
|---|---|
| **BUG** | Wrong behaviour, data loss risk, or a broken interaction |
| **GAP** | Works, but a quality-of-life hole a user will hit |
| **VIS** | Visual / information-design improvement |
| **LLM** | Something that would help the memory model produce better knowledge |
| **NOTE** | Observation, not necessarily actionable |

---

## Findings

### N-06 · Map wastes most of its canvas — **VIS**

The map `<svg>` is `457 × 787` CSS px with `viewBox="0 0 1000 700"`. With the default
`preserveAspectRatio`, the 1.43 : 1 viewBox is letterboxed into a 0.58 : 1 box, so roughly half
the visible height is permanently empty and every node is squeezed into a central band. On first
open the nodes occupy about a fifth of the pane.

*Fix:* auto-**Fit** on first open (the button exists and works), or compute the viewBox from the
node bounding box instead of hard-coding 1000×700.

### N-07 · Panel shows plumbing, not a knowledge summary — **VIS / GAP**

The Memory panel's Nexus section shows `0 messages awaiting collection` and
`Local index: 26 / 26`, and nothing about what is actually remembered. The explorer's status bar
already computes the useful line — `3 people · 5 places · 4 objects · 0 events`, `12 memories` —
but that never surfaces in the panel, which is where a user decides whether memory is working.

Also: `Local index: 26 / 26` is an embedding-cache counter shown to end users with no
explanation, while the number of memories (12) is nowhere in the panel.

*Fix:* lead the panel with "12 memories · 3 people · 5 places · 4 objects", and demote the index
counter to a subtitle or only show it while indexing is incomplete.

### N-08 · Paused collection has no state, only a verb — **GAP**

When collection is paused, the only signal is that the toggle reads **Resume collection**
([NexusActivity.tsx:52](src/features/nexus/NexusActivity.tsx:52)). There is no "Paused" badge,
no changed styling, and the status line still reads the neutral
`N messages awaiting collection`. A user who paused a week ago and comes back sees a panel that
looks like it is working and silently is not.

*Fix:* when `data.paused`, make the status line say `Paused · N messages awaiting collection`
and mark the section header.

### N-09 · Unpluralised counter — **VIS**

`0 messages awaiting collection` / `1 messages awaiting collection`
([NexusActivity.tsx:11](src/features/nexus/NexusActivity.tsx:11)). Everything else in this
feature is carefully written, so this one stands out.

---

### N-10 · Nexus has no injection controls at all, while Summary has four — **GAP**

`nexusSettings.template`, `.position`, `.depth` and `.role` are persisted, normalised
([settings.ts:20](shared/nexus/settings.ts:20)) and *used* — `useChat.ts:789` passes
`memoryMode === 'nexus' ? nexusSettings : memoryConfigRef.current` straight into
`assemble()`, which resolves the story-memory slot from them
([assemble.ts:487](shared/prompt/assemble.ts:487)).

But `NexusSettings.tsx` renders none of them. Summary mode gets **Injection template /
Position / Role** in the same panel; Nexus mode gets nothing. A user who wants Nexus knowledge
at depth 4 as a `user` message, or who wants to change the
`[Story knowledge. Respect chronology…]` wrapper, has to hand-edit `data/settings.json`.

*Fix:* reuse the same placement block the Summary panel already renders, with `{{memories}}`
as the macro.

### N-11 · No "Restore default prompt" for the extraction guidance — **GAP**

The Summary panel has a **Restore default prompt** button. The Nexus **Extraction guidance**
box — a ~1,300-character prompt that is much easier to wreck and much harder to retype — has
none. `NEXUS_PROMPT` is exported from `shared/nexus/types.ts` and already sitting there ready
to be used.

### N-12 · Global settings presented as if they were per-chat — **GAP**

The explorer header reads **Memory Nexus / Nexus verification** (the chat name), and its
**Settings** tab then edits `settings.nexus`, which is **app-wide**. Changing the model or the
recall allowance there silently changes every other Nexus chat. Nothing on the page says so.

*Fix:* a one-line "These apply to every chat that uses Nexus" under the heading.

### N-13 · Explorer's "Recall more" tab starts with an empty search box — **BUG (minor)**

The documented behaviour is that Recall more "starts from the composer draft or recent
conversation". That only happens on the `show('recall', draft)` path used by the composer
button ([useNexus.ts:126](src/features/nexus/useNexus.ts:126)). Clicking the **Recall more**
*tab* inside the explorer calls `n.setSection(v)` directly
([NexusExplorer.tsx:230](src/features/nexus/NexusExplorer.tsx:230)), so the query is left at
whatever it was — empty on a fresh open. Two doors into the same feature, two different
behaviours.

*Fix:* have the tab handler seed the query the same way when moving into `recall` with an
empty query.

### N-14 · Selected findings are silently destroyed by typing — **BUG (high impact)**

Reproduced end to end:

1. Open Recall more, search, get 3 findings, all checked.
2. Press **Use selected findings (3)** — the explorer closes and returns to the chat.
3. Type a message in the composer.
4. Reopen Recall more → **the findings are gone.**

`draftChanged` clears them on any draft change with non-empty text
([useNexus.ts:133](src/features/nexus/useNexus.ts:133)). The staging guard
(`if (!staged.current || text.trim())`) only protects findings *after* `stageForSend()`, which
runs at dispatch.

The natural user flow is "look things up → then write the message that uses them", and that
flow throws the work away. The rule is documented in one line of small print at the bottom of
the Recall panel, and there is no toast, no confirmation, and no undo.

*Fix (any of):* keep findings until the draft changes *materially* (e.g. clear only if the
draft that seeded the search is edited); or stage on **Use selected findings** rather than on
dispatch; or, at minimum, warn ("Typing will clear your 3 selected findings") and offer to
re-run.

### N-15 · No indication that findings are attached to the next request — **GAP**

After **Use selected findings (3)** the composer looks exactly as it did before. The
**Recall more** button carries no count, there is no chip, and nothing in the composer tray
changes ([Composer.tsx:577](src/features/chat/Composer.tsx:577)). Combined with N-14 the user
can neither tell that findings are armed nor that they were just discarded.

*Fix:* badge the button — `Recall more · 3` — and make clicking the badge clear them.

### N-16 · "Save to Nexus" disables itself with no explanation — **GAP**

For a finding whose text exactly matches an existing record, the button is `disabled` with no
title, no `aria-describedby` and no visible reason
([NexusExplorer.tsx:311](src/features/nexus/NexusExplorer.tsx:311)). The user sees a greyed
button and cannot tell whether it is broken or already done.

*Fix:* swap the label to **Already in Nexus** (still disabled), or keep it enabled and let it
select the existing record in the explorer.

### N-17 · Recall more returns near-duplicates of what is already recalled — **LLM / GAP**

Searching *"What does Joe do for a living and where did he grow up?"* against 12 memories
returned three findings:

| # | Finding | |
|---|---|---|
| 1 | "Joe repairs antique watches for a living." | already a record |
| 2 | "Joe said he grew up in London." | already a record |
| 3 | "Narrator: Joe said he is from London." | raw transcript line, same fact as #2 |

Two of three were already in the Nexus (correctly flagged by the disabled Save button) and
the third restates one of them. The feature's stated purpose is to reach material that
*automatic* recall did not surface — so findings that are already in the automatic selection,
or that duplicate another finding, are pure budget waste at 1,200 tokens.

*Fix:* drop findings whose record is already in the current automatic recall selection, and
de-duplicate transcript passages against record text before presenting them. Optionally tell
the model in the search prompt which record IDs are already loaded.

### N-18 · Editing a checkbox writes a full revision indistinguishable from a text edit — **GAP**

`History (5)` for "Joe said he grew up in London." reads:

```
07/09/2026, 22:06:45 · User edit · active   Joe said he grew up in London.
07/09/2026, 22:06:33 · User edit · active   Joe said he grew up in London.
07/09/2026, 22:06:18 · User edit · active   Joe said he grew up in London.
07/09/2026, 22:05:38 · User edit · active   Joe said he grew up in London.
01/01/1970, 01:00:00 · Generated  · active  Joe said he is from London.
```

Four consecutive revisions with byte-identical text — they are Pin/Enabled/kind toggles, each
appending a revision. Append-only is right for provenance, but the history view is the user's
audit trail and it is now four rows of noise hiding the one real edit.

*Fix:* label what changed (`Pinned`, `Disabled`, `Kind → event`) instead of repeating the
unchanged text, or collapse consecutive same-text revisions into one row with a count.

### N-19 · Missing/zero `created` renders as `01/01/1970` — **BUG (cosmetic, but check migration)**

The seeded revision above has `created: 1` and the history row renders `01/01/1970, 01:00:00`.
Any revision that reaches the UI without a real timestamp will show the Unix epoch rather than
"Unknown". Worth checking that the **legacy scene-memory migration** stamps a plausible
`created` — a library of migrated memories all dated 1 January 1970 would look broken.

### N-20 · ~~Connection pickers are unfiltered~~ — **RETRACTED after testing at scale**

My first read of the 12-node chat suggested the **from/to** `<select>`s enumerated every node.
Re-tested on the 4,000-node *Nexus scale verification* chat: they are capped at 100 options and
they **do** follow the `Find identities` box (typing `Person 12` narrowed both the checkboxes and
both selects). This is correctly bounded — no change needed.

One small residue: with nothing typed, the visible 100 are the first 100 by insertion order,
and the caption *"Showing up to 100 matching identities"* does not say that. *"Showing 100 of
4,000 — type to narrow"* would be clearer.

### N-21 · Three unlabelled dropdowns, two of which show the same word — **VIS**

Each memory card ends with `[fact ▾] [active ▾] [fact ▾]`. The `aria-label`s are correct and
useful (`Memory kind`, `Memory state`, `Evidence attribution`) — screen-reader users are fine.
Sighted users get three bare dropdowns where the first and third both read "fact", with no
visible clue that one is *what kind of memory this is* and the other is *how strongly it is
asserted*. `Evidence attribution` is the single least self-evident concept in the feature and
it has no visible name.

*Fix:* small captions above each select, or at least a `title`.

### N-22 · Explorer opens for non-Nexus chats and dead-ends with no explanation — **BUG**

**Chat options → Memory Nexus** is offered on every chat regardless of its memory mode. On a
Summary-mode chat (tested on *Seraphina — Rendering stress test (500 messages)*) the explorer
opens with the inviting empty state — *"A story worth remembering / Add a person, place, object
or event, or build memories from the conversation"* — and:

- **Build from this conversation** — disabled, no reason given
- **Start from here** — disabled, no reason given
- **Add fact / Add event / Add situation / Add thread** — **enabled**

So the user can hand-author memories into a chat that will never use them, but cannot press
the two buttons the empty state just told them to press, and nothing anywhere says
"switch this chat to Nexus first".

`NexusActivity` renders a reason for `!configured` but never for `!enabled`
([NexusActivity.tsx:20](src/features/nexus/NexusActivity.tsx:20)).

*Fix:* when `memoryMode !== 'nexus'`, replace the two disabled buttons with a single
**Use Nexus for this chat** button (or say why they are disabled), and disable the Add-record
buttons for consistency.

### N-23 · A reasoning memory model can never finish, at any allowed setting — **BUG (blocking)**

Reproduced with the repo's own agent connection (`api.entrim.ai`, provider `custom`) and
`deepseek-ai/DeepSeek-V4-Flash` as the Nexus model, on a 5-message excerpt:

| Output allowance | Result |
|---|---|
| 2048 (default) | `finish_reason: length`, `reasoning_tokens: 2052`, **`text_tokens: 0`** |
| 8192 | `finish_reason: length`, all budget spent reasoning, `content: ""` |
| 16384 (**the maximum the field accepts**) | same |

The model reasons its way through the whole task — its trace shows a complete, well-formed
plan of 14 records — and then has no budget left to emit the JSON. The UI's advice,
*"Increase the Nexus output allowance and retry"*, is unachievable: 16384 is the cap
([settings.ts:17](shared/nexus/settings.ts:17)).

The cause is that nothing turns reasoning down. `useNexus.request` sets
`connection: { ...connection, showReasoning: false }`
([useNexus.ts:326](src/features/nexus/useNexus.ts:326)), but `showReasoning` is only consulted
on the **openrouter** branch of `buildRequestBody`
([request.ts:205](shared/providers/request.ts:205)) as `reasoning.exclude`. On a `custom`
provider it is inert, and `reasoning_effort` is never set because the synthetic
`createDefaultPreset()` has none.

Switching to `Qwen/Qwen3.6-35B-A3B` on the same connection succeeded first try.

*Fix (in order of value):*
1. Send `reasoning_effort: 'low'` (or the provider's "off"/`chat_template_kwargs.thinking:false`)
   for Nexus extraction — it is a structured-output task, not one that benefits from long CoT.
2. Detect `text_tokens === 0` / empty content with `finish_reason: length` and say what actually
   happened: *"The memory model spent its entire output budget on reasoning. Choose a
   non-reasoning model, or lower its reasoning effort."*
3. Surface reasoning effort in Nexus settings.

### N-24 · Following the error message's advice produces a second, unrelated error — **BUG**

The transcript budget is `inputTokens − outputTokens − 128`
([extract.ts:87](shared/nexus/extract.ts:87)). Both defaults are in the same panel with no
stated relationship, and the field validation lets output ≥ context.

Do exactly what the first error says — leave **Memory model context** at its default 8192 and
raise **Memory model output** to 8192 — and the budget goes to **−128**, producing:

> *Nexus instructions and existing context exceed the configured context limit. Increase the
> limit or shorten the extraction prompt.*

Two errors, neither mentioning the other field, and a user following the instructions
faithfully lands in the second.

*Fix:* clamp `outputTokens` to leave a workable transcript budget (or validate on entry), and
have the first error name both numbers: *"Output allowance 2048 of a 8192 context leaves 6064
for the transcript."*

### N-25 · Real extraction produces a graph with **zero** connections — **BUG / VIS (headline)**

The most important result of this session. A fresh Seraphina chat, five substantive messages
dense with explicit relationships, extracted by a real model:

- **10 nodes**, **13 records**, **0 edges**
- footer reads `4 people · 3 places · 3 objects · 0 events`
- the map is ten unconnected dots under the caption *"Your story, connected"*

The transcript stated, in plain language: Tomas is *from* Vellmoor; Ines is Tomas's *sister*;
Ruven Hask is the guild's *factor*; Ines *gave* Tomas the astrolabe; the Sunken Bell lies
*under* the old riverbed. The model recorded every one of those as record **text** and did not
emit a single `relation`.

Three compounding causes:

1. **`relation` is optional and unexemplified in practice.** The contract mentions it once in a
   dense one-line schema ([extract.ts:22](shared/nexus/extract.ts:22)); the extraction prompt
   says only "connect people, places, objects and events only where supported by the
   transcript" — which reads as a caution, not an instruction.
2. **Event-participation edges need an `event` *node*, and the model creates none.**
   `nexusGraph` only builds participation edges when a record's `nodeIds` contains a node whose
   kind is `event` ([graph.ts:19](src/features/nexus/graph.ts:19)). Nothing in the contract
   tells the model when to make an event node, so `0 events` and therefore no edges from the
   eight `kind: "event"` records either.
3. **Co-mention is not an edge** (see N-05).

*Fix:* all three are worth doing, but the cheapest big win is (3) — draw implicit co-mention
edges — plus a worked `relation` example in the contract. See N-31 for prompt wording.

### N-26 · The model emitted no search cues at all — **LLM**

All 13 records came back with `cues: []`, despite the prompt's *"Give facts useful search
cues"* and `cues` being in the schema. Cues are a live retrieval signal
(`searchDocuments` ranks on them), so a whole ranking channel is inert in real use.

*Fix:* make `cues` non-optional in the contract with a concrete example and a stated count
("2–4 cues: names, places, topics — not words already in the text"), and consider rejecting a
record with no cues at parse time rather than silently accepting the empty array.

### N-27 · Node kinds have no slot for groups, factions or creatures — **LLM**

Captured verbatim from the model's own reasoning trace while extracting:

> "The allowed kinds are limited. We can create node for 'Vellmoor guild' as 'place'? Not
> appropriate. Maybe skip node for guild, mention in record text."

and again for the beasts:

> "Beasts are creatures, not person. Could use object? Not ideal. … skip node for beasts."

`NexusNodeKind` is `person | place | object | event`
([types.ts:3](shared/nexus/types.ts:3)). Guilds, orders, houses, companies, armies, species and
monster groups are everywhere in roleplay, and every one of them is currently either dropped or
mis-typed. Two entities were dropped from this five-message excerpt alone.

*Fix:* add `group` (organisations, factions, families, species) and possibly `concept` (lore,
prophecies, rules). Both are additive to the node schema; the map already colours by kind.

### N-28 · The extraction prompt makes the model litigate what counts as evidence — **LLM**

The reasoning trace spends several hundred tokens on this, twice:

> "The scenario is not in excerpt? … The instructions say profiles are for interpretation, not
> evidence. The scenario is part of the prompt? … So ignore scenario? But we can use line 0…"

The profile block is sent as a second `system` message headed *"Profiles for interpretation,
not evidence:"* ([extract.ts:83](shared/nexus/extract.ts:83)), and the excerpt arrives as an
unlabelled `user` message of `[n] Name: text` lines. The boundary is real but implicit, and the
model burns budget (and, on a smaller model, accuracy) rediscovering it.

*Fix:* label the excerpt explicitly — e.g. prefix the user message with
`TRANSCRIPT EXCERPT — the only evidence. Cite line numbers from this block only.` — and state
once in the system prompt that character cards, scenario and existing records are never
citable.

### N-29 · Progress reads `0 / 5` for the entire run — **VIS**

`Remembering… 0 / 5` is shown for the whole extraction — 30–60 s against a real model — because
`processed` only advances when a batch is accepted, and a 5-message excerpt is one batch. There
is no spinner, no elapsed time, and no phase ("sending", "waiting", "checking"). During the
failed reasoning runs it sat at `0 / 5` for a minute and then produced an error, which reads
exactly like a hang.

*Fix:* show an indeterminate state while a batch is in flight, and name the phase.

### N-30 · No legend for node colour, and 7px labels — **VIS**

Nodes are ringed green / blue / orange by kind, which is genuinely useful, but nothing on the
page says what the colours mean. The status bar has the counts
(`4 people · 3 places · 3 objects · 0 events`) and is the obvious place to carry the swatches.
Node captions render at roughly 7 px at the default zoom and are hard to read on a normal
display.

### N-31 · Suggested contract/prompt changes to help the memory model — **LLM (summary)**

Consolidating what the traces and results above point at, in the order I would do them:

1. **Demand relations.** Add to the guidance: *"Whenever the transcript states how two
   entities stand to each other — kinship, origin, employment, ownership, location — emit a
   `relation` on the record, with a short verb-phrase label ('is sister of', 'is from',
   'works for', 'lies under')."* Put one filled-in `relation` in the schema example.
2. **Say when to create an `event` node.** *"Create an `event` node for any named or
   referable happening that several memories will point at (a battle, a bargain, a journey);
   attach its participants through `nodeRefs`."* Without this the participation-edge half of
   `nexusGraph` is unreachable.
3. **Require `cues`** (N-26).
4. **Add `group` to node kinds** (N-27).
5. **Mark the excerpt boundary explicitly** (N-28).
6. **Accept the valid subset of a batch.** `parseExtraction` is strictly all-or-nothing —
   one bad `kind`, one out-of-range source index or one unknown node ref throws and the whole
   batch is discarded ([extract.ts:173](shared/nexus/extract.ts:173)). With 48 records allowed
   per batch, one malformed entry from a small model costs the user a paid call and all 47 good
   records. Collecting per-record errors and applying the rest — reporting *"3 of 21 memories
   were rejected"* — would make Nexus far more usable on cheap models, which is exactly the
   market for a background extraction model.
7. **Nudge against low-value nodes.** This run created a node for `Satchel`. A line such as
   *"Only create a node for something that will be referred to again"* would help.

### N-32 · The Recall allowance barely does anything — **BUG (design) / GAP**

`buildRecall` picks candidates *before* the token budget is ever consulted, and the candidate
set is hard-capped ([retrieve.ts:199](shared/nexus/retrieve.ts:199)):

```
const candidates = new Map(ranked.slice(0, 3).map(...))   // top 3 ranked
... .slice(0, 2) seeds → neighbours .slice(-2)            // + up to 2 graph neighbours
... + pinned records + active situations + selected findings
```

So automatic recall considers **three ranked memories plus two neighbours**, whatever the
allowance says. Measured on the 13-memory Seraphina chat:

| Recall allowance | Memories included | Tokens used |
|---|---|---|
| 1,200 (default) | 6 of 13 | **112** |
| 12,000 | 6 of 13 | **112** |

Seven memories — about 130 tokens of them — were never candidates, with ~1,090 tokens of the
default allowance unspent. The Inspect report reflects this honestly: every hit says
*Included*, because nothing ever reached the budget stage to be excluded.

"Recall allowance (tokens)" is the most prominent number in Nexus settings and is presented as
the thing that governs how much memory is used. On any Nexus below a few hundred records it
governs nothing.

*Fix:* let ranking produce many more candidates (`searchDocuments` already returns 24) and let
the token budget do the cutting — which is what the user is being asked to tune. Keep the
**graph expansion** bounded exactly as it is; that is the part that must not explode, and the
comment on line 200 is defending the right thing, just in the wrong place.

### N-33 · A deleted memory is still fully editable and is labelled "Edited" — **BUG (minor)**

Deleting a memory (with a proper **Confirm deletion** step — good) and then ticking **Deleted**
in the toolbar shows the tombstone. On that card:

- the kicker reads `fact · Edited` — there is no "Deleted" word anywhere
  ([NexusExplorer.tsx:911](src/features/nexus/NexusExplorer.tsx:911) only renders
  `kind · Legacy event · Edited`);
- `data-disabled="true"` is the same attribute used for a merely *disabled* record, so a
  deleted memory and a switched-off one are visually identical;
- the text area, all three selects and both **Pin** and **Enabled** checkboxes are still live,
  so you can pin, re-word and re-categorise a deleted memory, appending revisions to a
  tombstone.

*Fix:* add `· Deleted` / `· Disabled` to the kicker, give the tombstone its own styling, and
make the editing controls read-only until it is restored.

### N-34 · Core pipeline verified working — **NOTE (positive)**

Worth recording because it is the part that matters most, and it is solid:

1. Extraction on a real model produced 13 accurate, well-attributed records from 5 messages —
   private knowledge kept private ("Tomas has not told anyone, including Ines"), suspicion
   marked `claim`, promises marked `intention`.
2. Automatic recall answered a targeted question correctly: asking *"who gave me the astrolabe,
   and what did I promise you?"* pulled exactly the astrolabe fact and both promises
   (5 memories, 89 tokens).
3. The **Nexus request** report in Inspect matched the raw request body byte for byte — the
   knowledge really did ship, wrapped in the configured template:

```
"role": "system",
"content": "[Story knowledge. Respect chronology, attribution and who knows each fact.
• Tomas's left shoulder still burns from the attack.
• Tomas has not told anyone, including Ines, about the guild's commission.
• [Intention] Tomas promises to help clear beasts from the eastern path in four days…
• [Intention] Seraphina agrees to let Tomas rest for four days and will keep watch.
• Ines gave Tomas a brass astrolabe before she left for the coast.]"
```

4. The reply used it correctly and named Ruven Hask, the Sunken Bell and the four days.

The `[Intention]` / `[Reported claim]` prefixes on recalled lines are a genuinely good idea —
they carry the attribution the extraction worked to preserve all the way into the prompt.

### N-35 · List view leaves half the screen empty — **VIS**

In **List view** the memory cards stay in the left column at map width while the right pane
still shows the map's copy — *"Your story, connected / Explore the Nexus / Select a node to see
what it connects…"* — which is meaningless in a list. Long memory texts wrap in a ~390 px
column beside 370 px of unused space.

*Fix:* let List view use the full width (and move the collection controls into the toolbar), or
give the right pane a list-appropriate role such as the selected memory's provenance.

### N-36 · Search does not highlight what it matched — **VIS**

Typing `astrolabe` correctly narrows both the identity chips and the memory cards, but the
matched term is not highlighted in the memory text, so on a long memory you have to re-read the
sentence to see why it matched. `searchDocuments` already computes `matched` terms for its
`Text match: …` reason string.

### N-37 · Node captions and both panels at once — **VIS**

With Inspect open on the left and Memory open on the right, the chat column collapses to a
~30 px strip of single letters at the default window size. Nexus actively encourages this
combination (read the recall report, then adjust the memory), so it is worth either enforcing a
minimum chat width or making the two panels mutually exclusive.

### N-38 · "Jump to message" does nothing when the message is already loaded — **BUG**

Measured in the Seraphina chat (8 messages, all within the loaded window):

```
chat-view__scroll.scrollTop before jump: 1590
chat-view__scroll.scrollTop after jump:  1590   (scrollHeight 2358)
```

The explorer closes and the view does not move. The target message was near the top of the
scroll area, well off screen.

`Jump to message` sets `nexus.setJumpId(...)` and closes
([NexusExplorer.tsx:859](src/features/nexus/NexusExplorer.tsx:859)); `ChatView` turns that into
`jumpTo(index)`, which computes `windowForJump` and calls `setWindow`
([ChatView.tsx:234](src/features/chat/ChatView.tsx:234)). The centring is done by a
`useLayoutEffect` that the code's own comment says is *"Keyed on the window bounds, by design —
a jump is a window change"*. When the target is already inside the current window the bounds do
not change, the layout effect never runs, and nothing scrolls.

This is the *common* case for Nexus: memories are usually extracted from recent messages, which
are the ones already in the window.

*Fix:* scroll to the target unconditionally when it is already mounted, rather than only as a
side effect of a window change.

### N-39 · A jumped-to message is not highlighted — **GAP**

Even when the jump does move the view, nothing marks which message was the source. The user
arrives at a wall of text with no indication of what they came to see.

*Fix:* a brief flash/outline on the target message (the app already has an `is-highlighted`
style vocabulary elsewhere).

### N-40 · The explorer says `aria-modal="true"` but does not trap focus — **BUG (a11y)**

The explorer is a proper dialog: `role="dialog"`, `aria-modal="true"`,
`aria-label="Memory Nexus"`, Escape closes it, focus lands inside on open and returns to the
trigger on close. All good. But the chat is deliberately kept mounted (the documented
full-screen exception), and nothing is made `inert`:

```
focusable inside the dialog:   49
focusable behind it, still tabbable: 39   (Connections, Prompts, Generation, Inspect, Characters, …)
```

A keyboard user tabbing through the explorer falls out of it into controls hidden behind the
overlay. `aria-modal="true"` tells a screen reader the background is unavailable while the
keyboard says otherwise.

*Fix:* set `inert` on the app root while the explorer is open — the chat stays mounted (which is
the point of the exception) and simply stops being reachable.

### N-41 · The Motion toggle looks identical on and off — **VIS**

`Motion` in the explorer toolbar is a ghost button whose only state signal is `aria-pressed`.
Computed styles are byte-identical in both states:

```
off → bg rgba(0,0,0,0) · colour rgb(234,234,236) · border rgba(0,0,0,0) · opacity 1
on  → bg rgba(0,0,0,0) · colour rgb(234,234,236) · border rgba(0,0,0,0) · opacity 1
```

Its neighbour, **Deleted**, is a real checkbox. Two toggles side by side, one visible and one
not. (It also writes to the app-wide `nexus.motion` — see N-12.)

### N-42 · Evidence warning cannot say *why* the evidence is invalid — **GAP**

Hiding a source message correctly invalidated its four memories (verified: recall dropped from
6 memories / 112 tokens to 3 / 69, and the four cards showed a warning). The warning reads:

> *Evidence is outdated or unavailable. Review before recall.*

and the Sources block says *"Source changed, hidden or removed"*. But `evidenceValidator`
distinguishes all three cases internally — message missing, `m.hidden`, and
`fingerprint !== e.fingerprint` ([state.ts:61](shared/nexus/state.ts:61)) — and then collapses
them to a boolean. The user hid one message on purpose and gets a warning that reads like data
corruption, on four memories, with no pointer back to the cause.

*Fix:* return the reason, not a boolean, and say it: *"Its source message is hidden from the
prompt"* / *"Its source message was edited after this memory was made"* / *"Its source message
was deleted"*. The first two are recoverable in one click and the user should be told which.

### N-43 · Nothing tells you how much of the Nexus is currently unusable — **GAP**

With four of thirteen memories invalidated, the header still read **13 memories** and the status
bar still read `4 people · 3 places · 3 objects · 0 events`. The only way to discover that
almost a third of the story memory had stopped working was to scroll the list looking for
warning text.

*Fix:* `13 memories · 4 need review` in the header, and a filter for them.

### N-44 · A source excerpt is the whole message, not the supporting line — **GAP / LLM**

`Sources (1)` for *"Ines gave Tomas a brass astrolabe before she left for the coast"* shows the
entire 600-character user message, of which one clause is the actual evidence. `sources()`
stores `excerpt: item.text.slice(0, 600)` ([extract.ts:177](shared/nexus/extract.ts:177)) — the
extraction window, not a quote.

For short messages this is fine; on the long paragraphs a roleplay actually produces it makes
verification a reading exercise, which is the opposite of what the provenance feature is for.

*Fix:* add an optional `quote` to the record contract (≤200 chars, must appear verbatim in the
cited line — cheap to validate at parse time) and show that, with the full excerpt behind a
disclosure. The legacy Summary prompt already asks the model for verbatim lines, so this is a
pattern the project has used before.

---

## Test log
| # | Area | What was done | Result |
|---|---|---|---|
