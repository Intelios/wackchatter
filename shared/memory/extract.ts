/**
 * Memory extraction: what the archivist model is sent, and what it is allowed to say back.
 *
 * Pure, like everything else in `shared/` — no I/O, no provider, no React. The run loop
 * lives in `useChat`; this file owns the prompt shape and, more importantly, the contract
 * for reading a reply back.
 *
 * Two rules run through the whole file:
 *
 *  - **The model never sees a global message index.** It is shown a window numbered from
 *    zero and answers in those local numbers, which are then mapped to message ids here.
 *    Ids survive deletion, branching and swiping; indices do not, and a model that could
 *    name a global index could name one that has since moved.
 *  - **The model never names a destructive action.** It writes memories. Which messages
 *    end up hidden is derived from the ranges it wrote, by code, later — so a malformed or
 *    adversarial reply can produce a bad memory but cannot hide the wrong thing.
 */

import type { ApiMessage, ChatMessage, Memory } from '../types/chat.ts';
import { renderMemoryChain } from './render.ts';

/** Resolved character fields. Macros are expanded by the caller, which owns the runtime. */
export interface MemoryCharacterProfile {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
}

export interface MemoryPersonaProfile {
  name: string;
  description?: string;
}

/** A memory as the model described it, already mapped onto real message ids. */
export interface DraftMemory {
  title: string;
  text: string;
  keywords: string[];
  quotes: string[];
  startId: string;
  endId: string;
}

export interface ParsedMemoryResponse {
  memories: DraftMemory[];
  /** Set when the reply could not be read at all. `memories` is empty when present. */
  error?: string;
}

/** Hard caps, applied after parsing. A model that ignores the contract cannot blow the budget. */
const MAX_TITLE_CHARS = 80;
const MAX_KEYWORDS = 12;
const MAX_KEYWORD_CHARS = 60;
const MAX_QUOTES = 2;
const MAX_QUOTE_CHARS = 240;

/**
 * Transcript turns eligible for extraction.
 *
 * Hidden messages are dropped, matching `summaryMessages` and — more to the point —
 * matching `worldinfo/scan.ts`, which refuses to let a hidden message trigger lore. The
 * reasoning is identical: a memory written from a hidden message would put that message's
 * content back into the prompt by proxy, which is precisely what hiding it asked not to
 * happen.
 */
export function memoryMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !message.is_system && message.mes.trim());
}

/**
 * Messages not yet covered by a memory. A missing watermark restarts at the top.
 *
 * Mirrors `summaryBacklog`; kept separate rather than shared because the two features
 * store their checkpoint in different metadata fields and one day only one of them will
 * still exist.
 */
export function memoryBacklog(messages: ChatMessage[], watermark?: string): ChatMessage[] {
  if (!watermark) return messages;
  const index = messages.findIndex((message) => message.id === watermark);
  return index === -1 ? messages : messages.slice(index + 1);
}

/**
 * The output contract, appended to the user's editable prompt rather than living inside it.
 *
 * Separated on purpose: someone rewriting the style guidance must not be able to break
 * parsing, because a reply that no longer parses is the one failure they could not
 * diagnose from the panel.
 */
export const MEMORY_JSON_CONTRACT = `Reply with a single JSON object and nothing else. No prose before or after it, no code fence.

{
  "memories": [
    {
      "title": "First Meeting",
      "text": "Two to four sentences, past tense.",
      "keywords": ["Sera", "the cabin", "the storm"],
      "quotes": ["at most two short lines worth keeping"],
      "startIndex": 0,
      "endIndex": 23
    }
  ]
}

startIndex and endIndex are the numbers in square brackets at the start of each transcript line, and refer to the first and last message of that scene. Ranges must not overlap and must be in order. Omit a trailing scene that has not finished yet — simply do not write a memory for it. If nothing in the excerpt is worth remembering, reply with {"memories": []}.`;

export interface BuildExtractionOptions {
  extractPrompt: string;
  character: MemoryCharacterProfile;
  persona?: MemoryPersonaProfile | null;
  /** The most recent memories already written, oldest first. Keeps the chain continuous. */
  priorMemories: Memory[];
  /** The window being extracted, oldest first. Numbered from zero for the model. */
  window: ChatMessage[];
}

/** One transcript line. Internal newlines are collapsed so the numbering stays unambiguous. */
function formatLine(message: ChatMessage, index: number): string {
  return `[${index}] ${message.name}: ${message.mes.trim().replace(/\s+/g, ' ')}`;
}

export function formatWindow(window: ChatMessage[]): string {
  return window.map(formatLine).join('\n');
}

function profileBlock(character: MemoryCharacterProfile): string {
  const parts = [`Name: ${character.name}`];
  if (character.description?.trim()) parts.push(`Description: ${character.description.trim()}`);
  if (character.personality?.trim()) parts.push(`Personality: ${character.personality.trim()}`);
  if (character.scenario?.trim()) parts.push(`Scenario: ${character.scenario.trim()}`);
  return parts.join('\n');
}

/**
 * The full request, hand-built rather than assembled.
 *
 * `assemblePrompt` is deliberately not used: it exists to apply the user's preset, and the
 * whole point of this call is that the preset's main prompt, jailbreak and post-history
 * instructions are absent. The classic summariser goes through assembly and has to open
 * its prompt with "Ignore previous instructions" to claw its way back out from underneath
 * them — that is the wart this replaces, not a pattern to copy.
 */
export function buildExtractionMessages(options: BuildExtractionOptions): ApiMessage[] {
  const { extractPrompt, character, persona, priorMemories, window } = options;

  const messages: ApiMessage[] = [
    { role: 'system', content: `${extractPrompt.trim()}\n\n${MEMORY_JSON_CONTRACT}` },
    { role: 'system', content: `The character in this story:\n${profileBlock(character)}` },
  ];

  if (persona?.name.trim()) {
    const lines = [`Name: ${persona.name.trim()}`];
    if (persona.description?.trim()) lines.push(`Description: ${persona.description.trim()}`);
    messages.push({
      role: 'system',
      content: `The person they are speaking with:\n${lines.join('\n')}`,
    });
  }

  const chain = renderMemoryChain(priorMemories);
  if (chain) {
    messages.push({
      role: 'system',
      content: `Earlier memories from this story, for continuity. Do not repeat them; carry the names and facts forward.\n\n${chain}`,
    });
  }

  messages.push({ role: 'user', content: formatWindow(window) });
  return messages;
}

/**
 * Pull a JSON object out of a reply that may be fenced, prefaced, or trailing-comma'd.
 *
 * Roleplay-tuned models wrap JSON in prose and fences routinely; treating that as a hard
 * failure would make the feature unusable on exactly the models people run it with.
 */
function looseParse(text: string): unknown {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const slice = unfenced.slice(start, end + 1);

  try {
    return JSON.parse(slice);
  } catch {
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

function stringList(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const clean = entry.trim().slice(0, maxChars);
    if (!clean) continue;
    const fingerprint = clean.toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    list.push(clean);
    if (list.length >= max) break;
  }
  return list;
}

function boundedIndex(value: unknown, size: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const index = Math.floor(value);
  if (index < 0 || index >= size) return null;
  return index;
}

/**
 * Read a reply into draft memories, clamped to the window.
 *
 * Every index is validated against the window rather than trusted, and ranges are forced
 * to be ordered and non-overlapping. That last rule is not tidiness: hiding is attributed
 * per memory via `ChatMessage.hiddenBy`, so two memories claiming the same message would
 * make "delete this memory and get its messages back" ambiguous.
 */
export function parseMemoryResponse(text: string, window: ChatMessage[]): ParsedMemoryResponse {
  const parsed = looseParse(text);
  if (!parsed || typeof parsed !== 'object') {
    return { memories: [], error: 'The memory model did not return readable JSON.' };
  }

  const raw = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(raw)) {
    return { memories: [], error: 'The memory model returned JSON without a "memories" list.' };
  }

  const drafts: DraftMemory[] = [];
  let floor = 0;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;

    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const body = typeof record.text === 'string' ? record.text.trim() : '';
    if (!title || !body) continue;

    const start = boundedIndex(record.startIndex, window.length);
    const end = boundedIndex(record.endIndex, window.length);
    if (start === null || end === null || end < start) continue;

    // Ordered and non-overlapping, by construction rather than by trust.
    const from = Math.max(start, floor);
    if (from > end) continue;
    floor = end + 1;

    drafts.push({
      title: title.slice(0, MAX_TITLE_CHARS),
      text: body,
      keywords: stringList(record.keywords, MAX_KEYWORDS, MAX_KEYWORD_CHARS),
      quotes: stringList(record.quotes, MAX_QUOTES, MAX_QUOTE_CHARS),
      startId: window[from]!.id,
      endId: window[end]!.id,
    });
  }

  return { memories: drafts };
}
