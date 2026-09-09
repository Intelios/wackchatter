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

### N-31 · Suggested contract/prompt changes to help the memory model — **LLM (summary)**

Items 1–5 (demand relations, event-node rule, require cues, the `group` kind, the excerpt
boundary) landed with the N-25–N-28 fixes. Still open:

1. **Accept the valid subset of a batch.** `parseExtraction` is strictly all-or-nothing —
   one bad `kind`, one out-of-range source index or one unknown node ref throws and the whole
   batch is discarded ([extract.ts:173](shared/nexus/extract.ts:173)). With 48 records allowed
   per batch, one malformed entry from a small model costs the user a paid call and all 47 good
   records. Collecting per-record errors and applying the rest — reporting *"3 of 21 memories
   were rejected"* — would make Nexus far more usable on cheap models, which is exactly the
   market for a background extraction model.
2. **Nudge against low-value nodes.** The original run created a node for `Satchel`. A line
   such as *"Only create a node for something that will be referred to again"* would help.

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
