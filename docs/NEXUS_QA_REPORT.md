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
