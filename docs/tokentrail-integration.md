# WackChatter / TokenTrail integration

TokenTrail owns Stats. WackChatter owns its library and the usage ledger. All reads of
WackChatter files are read-only; TokenTrail never stores transcript or reasoning text.
Library statistics describe current transcripts; usage describes recorded generations.

## Usage v2

`~/.wackchatter/usage/v2/YYYY-MM/<writer-uuid>.jsonl` retains complete newline-terminated
JSON records indefinitely. Fields retain the v1 usage contract (ISO `ts`, additive
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`; reasoning is
inside output), with `v: 2`, `library_id`, optional `provider_name`, and `outcome`.
Outcome is completed, failed, cancelled, or unknown. A UUID is minted per generation;
retries of delivery and transcript copies preserve it. No prompts, replies, reasoning,
endpoint URLs, credentials, or character descriptions are exported. `estimated` counts
are separate from measured counts and never priced. Costs are API-equivalent estimates.

Recording defaults on when absent and respects explicit false. It does not enable
provider reporting. Failures do not interrupt generation. Legacy usage.jsonl and its
retained .1 rotation remain readable; lost older non-chat generations cannot be recovered.
Measured data outranks estimated data; at equal quality ledger counts outrank transcript
counts. Transcript metadata fills missing attribution without erasing ledger information.
Generation identity is independent of its memberships in libraries and conversations.

## Identity and navigation

Library identity is the `created` string in `.wackchatter`, with canonical directory as a
legacy fallback. Character identity is its bare PNG filename, qualified by library.
Persona identity is its opaque filename stem. Group replies use message character_id.

`tokentrail://wackchatter?library=<id>&character=<optional-id>` opens the Stats destination.
`~/.wackchatter/runtime.json` contains `{version:1, libraryId, apiUrl, frontendUrl}` for
the running normal library. It is separate from library.json, follows relocation, and
is never published by WC_DATA_DIR scratch launches. GET /api/integration returns the
same identity. TokenTrail validates loopback URLs and the live library identity before
opening `<frontendUrl>/?ttLibrary=<id>&ttChat=<id>` or `&ttCharacter=<id>`.
Navigation never switches libraries, creates chats, or invokes a model. Missing apps and
wrong libraries are explicit unavailable states, not empty statistics.
