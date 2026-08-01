/**
 * The World Info activation engine.
 *
 * Given some lorebooks and a transcript, decides which entries fire and where they go.
 * Pure and synchronous — no I/O, no macros, no tokeniser of its own — so the whole thing
 * is testable without a browser and produces exactly what `assemblePrompt` consumes.
 *
 * ## Why the loop terminates
 *
 * Not because of `maxRecursionSteps`. An entry is removed from consideration the moment
 * it fires and `fired` only ever grows, so the loop can run at most `candidates.length`
 * passes even with every cap removed. The caps are cost control, not a safety net — which
 * is what makes it safe to let a user raise them.
 *
 * ## What is deliberately not implemented
 *
 * `sticky` / `cooldown` / `delay`, outlets, character filters, triggers, min-activations,
 * group scoring, and the six non-chat scan sources. Every one of those can only ever make
 * an entry fire LESS, so ignoring them is noisier than ST but never silently wrong.
 *
 * `vectorized` is the exception and IS honoured: in ST those entries are reachable only
 * by vector search, never by keyword, so treating the flag as absent would make them fire
 * where ST would never fire them.
 *
 * ## Divergences from SillyTavern, on purpose
 *
 * - **Macros are not substituted here.** Assembly does it, once, where the environment
 *   lives. The cost is that the budget is measured pre-substitution.
 * - **Unsupported positions are folded, not dropped** — see `foldPosition`.
 * - **Randomness is seeded**, and a draw is skipped rather than consumed for an entry
 *   that was never going to roll. See rng.ts.
 * - **Only admitted entries feed recursion.** ST also recurses on entries that failed the
 *   budget check, which pushes content into the scan buffer that was never sent.
 */

import type { DepthInjection } from '../prompt/assemble.ts';
import type { ChatMessage } from '../types/chat.ts';
import type {
  WiPosition,
  WorldInfoBook,
  WorldInfoEntry,
  WorldInfoSettings,
} from '../types/worldinfo.ts';
import { WI_POSITION, WI_ROLE_TO_STRING } from '../types/worldinfo.ts';
import {
  type MatchSettings,
  type RegexCache,
  createRegexCache,
  evaluateSecondary,
  matchAny,
  matchSettingsFor,
} from './match.ts';
import { type Rng, createRng, weightedPick } from './rng.ts';
import { ScanBuffer } from './scan.ts';

/**
 * Where a book came from. Also the precedence order for sort ties: a chat-scoped book
 * outranks a global one, which is the cheap version of ST's insertion-strategy setting.
 */
export const SOURCE_ORDER = ['chat', 'persona', 'embedded', 'linked', 'global'] as const;
export type WorldInfoSourceKind = (typeof SOURCE_ORDER)[number];

export interface WorldInfoSource {
  kind: WorldInfoSourceKind;
  /** Shown in the inspector, so "which book was that?" is answerable. */
  name: string;
  book: WorldInfoBook;
}

export interface ActivateOptions {
  sources: WorldInfoSource[];
  /** The transcript, oldest first, including the just-typed user message. */
  messages: ChatMessage[];
  settings: WorldInfoSettings;
  /** Token allowance for lore. See `worldInfoBudget`. */
  budget: number;
  countTokens: (text: string) => number;
  /** Prefix scanned messages with `Name: `. */
  includeNames?: boolean;
  /** Stabilises probability and group rolls. Chat + last user message id. */
  seed?: string;
}

export type ActivationReason = 'constant' | 'keyword' | 'recursion';

export type SkipReason =
  | 'disabled'
  | 'empty'
  | 'vectorized'
  | 'budget'
  | 'probability'
  | 'group'
  | 'delayed';

interface EntryRef {
  uid: number;
  sourceIndex: number;
  sourceKind: WorldInfoSourceKind;
  sourceName: string;
  /** The entry's memo, else its first key, else `#uid` — never blank. */
  label: string;
}

export interface ActivatedEntry extends EntryRef {
  order: number;
  tokens: number;
  placement: 'before' | 'after' | 'depth';
  depth?: number;
  role?: 'system' | 'user' | 'assistant';
  reason: ActivationReason;
  /** Which pass it fired on. 0 is the chat itself; 1+ are recursion. */
  pass: number;
  /** Set when `position` was unsupported and folded — the inspector says so. */
  foldedFrom?: string;
  content: string;
}

export interface SkippedEntry extends EntryRef {
  reason: SkipReason;
  /** Present for `budget`, so the inspector can show what it would have cost. */
  tokens?: number;
}

export interface ActivationResult {
  /** Ready for `assemblePrompt`'s worldInfoBefore / worldInfoAfter / worldInfoDepth. */
  before: string;
  after: string;
  depth: DepthInjection[];
  activated: ActivatedEntry[];
  skipped: SkippedEntry[];
  /** Tokens charged against the budget. */
  tokens: number;
  budget: number;
  budgetExhausted: boolean;
  passes: number;
}

/**
 * The token allowance for lore: a percentage of the context, optionally hard-capped.
 *
 * A cap of 0 means no cap — the field is not "cap the budget at zero", it is "no cap
 * configured", which is why the guard cannot be a truthiness test on the budget itself.
 */
export function worldInfoBudget(settings: WorldInfoSettings, maxContext: number): number {
  const percentage = Math.round((maxContext * settings.budget) / 100);
  if (settings.budgetCap > 0) return Math.min(percentage, settings.budgetCap);
  return Math.max(0, percentage);
}

/**
 * Positions we don't implement, mapped onto ones we do.
 *
 * Author's Note and Example Messages aren't features here, and outlets need a template
 * system we don't have. Dropping those entries would silently discard somebody's lore;
 * placing it slightly wrong and saying so in the inspector is the better failure.
 */
function foldPosition(position: WiPosition): {
  placement: 'before' | 'after' | 'depth';
  foldedFrom?: string;
} {
  switch (position) {
    case WI_POSITION.before:
      return { placement: 'before' };
    case WI_POSITION.after:
      return { placement: 'after' };
    case WI_POSITION.atDepth:
      return { placement: 'depth' };
    case WI_POSITION.ANTop:
      return { placement: 'before', foldedFrom: "Author's Note top" };
    case WI_POSITION.EMTop:
      return { placement: 'before', foldedFrom: 'Example messages top' };
    case WI_POSITION.outlet:
      return { placement: 'before', foldedFrom: 'Outlet' };
    case WI_POSITION.ANBottom:
      return { placement: 'after', foldedFrom: "Author's Note bottom" };
    case WI_POSITION.EMBottom:
      return { placement: 'after', foldedFrom: 'Example messages bottom' };
    default:
      return { placement: 'before', foldedFrom: `Unknown position ${position}` };
  }
}

/** The earliest pass an entry may fire on. 0 = no delay, `true` means level 1. */
function delayLevel(entry: WorldInfoEntry): number {
  const delay = entry.delayUntilRecursion;
  if (delay === true) return 1;
  if (typeof delay === 'number' && delay > 0) return Math.floor(delay);
  return 0;
}

function labelFor(entry: WorldInfoEntry): string {
  const memo = entry.comment?.trim();
  if (memo) return memo;
  const key = entry.key.find((candidate) => candidate.trim());
  return key?.trim() ?? `#${entry.uid}`;
}

interface Candidate {
  entry: WorldInfoEntry;
  ref: EntryRef;
  match: MatchSettings;
  scanDepth: number;
}

interface Match {
  candidate: Candidate;
  reason: ActivationReason;
}

/** Entries as a flat list, sorted by the rule the whole engine depends on. */
function collectCandidates(sources: WorldInfoSource[], settings: WorldInfoSettings): Candidate[] {
  const globals: MatchSettings = {
    caseSensitive: settings.caseSensitive,
    matchWholeWords: settings.matchWholeWords,
  };

  const candidates: Candidate[] = [];
  sources.forEach((source, sourceIndex) => {
    for (const entry of Object.values(source.book.entries)) {
      candidates.push({
        entry,
        ref: {
          uid: entry.uid,
          sourceIndex,
          sourceKind: source.kind,
          sourceName: source.name,
          label: labelFor(entry),
        },
        match: matchSettingsFor(entry, globals),
        scanDepth: entry.scanDepth ?? settings.depth,
      });
    }
  });

  // Explicit and total. Object.values on a Record with numeric-looking keys iterates in
  // ascending NUMERIC order, not insertion order, so relying on it would be relying on
  // something that isn't the display order and isn't stable across books.
  return candidates.sort(
    (a, b) =>
      b.entry.order - a.entry.order ||
      a.ref.sourceIndex - b.ref.sourceIndex ||
      a.entry.uid - b.entry.uid,
  );
}

/**
 * Resolve inclusion groups, returning the survivors.
 *
 * An entry may belong to several comma-separated groups, and losing any one of them
 * removes it entirely — matching ST, where the loser is spliced out of the shared array.
 */
function resolveGroups(
  matches: Match[],
  alreadyActivated: Set<string>,
  rng: Rng,
  skipped: SkippedEntry[],
): Match[] {
  const grouped = new Map<string, Match[]>();
  for (const match of matches) {
    for (const group of match.candidate.entry.group.split(/,\s*/)) {
      const name = group.trim();
      if (!name) continue;
      const list = grouped.get(name) ?? [];
      list.push(match);
      grouped.set(name, list);
    }
  }
  if (grouped.size === 0) return matches;

  const losers = new Set<Match>();

  // Insertion order, like ST — and deterministic, because `matches` arrives already
  // sorted. Which group is resolved first is observable when an entry belongs to two:
  // losing one removes it from the other, so re-ordering here changes who wins where.
  for (const [name, members_] of grouped) {
    const members = members_.filter((match) => !losers.has(match));
    if (members.length === 0) continue;

    // The group already produced a winner on an earlier pass. Everything else in it is
    // out for the rest of the run, or a group would yield one entry per pass.
    if (alreadyActivated.has(name)) {
      for (const member of members) losers.add(member);
      continue;
    }
    if (members.length === 1) continue;

    const prioritised = members.filter((match) => match.candidate.entry.groupOverride);
    const winner = prioritised.length
      ? prioritised[0]
      : weightedPick(members, (match) => match.candidate.entry.groupWeight, rng);

    for (const member of members) {
      if (member !== winner) losers.add(member);
    }
  }

  for (const match of losers) {
    skipped.push({ ...match.candidate.ref, reason: 'group' });
  }
  return matches.filter((match) => !losers.has(match));
}

/**
 * Does this entry pass its probability roll?
 *
 * A draw is taken only when the outcome is actually in doubt. ST rolls for `probability:
 * 0` too, but with a seeded generator every consumed draw shifts every later one, so
 * spending one on a foregone conclusion would mean adding an always-on entry silently
 * changed which entry a group three books away picked.
 */
function passesProbability(entry: WorldInfoEntry, rng: Rng): boolean {
  if (!entry.useProbability) return true;
  if (entry.probability >= 100) return true;
  if (entry.probability <= 0) return false;
  return rng.next() * 100 <= entry.probability;
}

export function activateWorldInfo(options: ActivateOptions): ActivationResult {
  const { sources, messages, settings, budget, countTokens } = options;

  const skipped: SkippedEntry[] = [];
  const activated: ActivatedEntry[] = [];

  const buffer = ScanBuffer.fromMessages(messages, { includeNames: options.includeNames });
  const cache: RegexCache = createRegexCache();
  const rng = createRng(options.seed ?? '');

  const candidates = collectCandidates(sources, settings).filter((candidate) => {
    const { entry, ref } = candidate;
    if (entry.disable) {
      skipped.push({ ...ref, reason: 'disabled' });
      return false;
    }
    if (entry.vectorized) {
      // Only reachable by vector search in ST. Letting it match keywords here would fire
      // it in a place ST never would.
      skipped.push({ ...ref, reason: 'vectorized' });
      return false;
    }
    if (!entry.content.trim()) {
      skipped.push({ ...ref, reason: 'empty' });
      return false;
    }
    return true;
  });

  const fired = new Set<Candidate>();
  const activatedGroups = new Set<string>();
  const delayedSeen = new Set<Candidate>();

  let used = 0;
  let budgetExhausted = false;
  let pass = 0;

  const maxPasses = settings.recursive ? Math.max(1, settings.maxRecursionSteps) : 1;

  for (; pass < maxPasses; pass++) {
    const matches: Match[] = [];

    for (const candidate of candidates) {
      if (fired.has(candidate)) continue;
      const { entry } = candidate;

      // Once the budget is exhausted a normal entry can never be admitted, so there is
      // no point matching it — and no point reporting it as budget-skipped on every
      // later pass. `ignoreBudget` entries are the exception: the editor promises they
      // are always includable after the budget is spent, so they keep matching against
      // newly admitted recursive content until none of them can fire.
      if (budgetExhausted && !entry.ignoreBudget) continue;

      // Recursion gating. `excludeRecursion` means the entry may only ever be triggered
      // by the chat itself, never by text an earlier pass admitted.
      if (pass > 0 && entry.excludeRecursion) continue;

      // `delayUntilRecursion` is the mirror image: not before the given recursion level.
      // ST advances its levels lazily rather than tracking the pass counter; we key off
      // the pass, which fires a level-3 entry on pass 1 if nothing else is pending.
      const delay = delayLevel(entry);
      if (delay > pass) {
        if (!delayedSeen.has(candidate)) {
          delayedSeen.add(candidate);
          skipped.push({ ...candidate.ref, reason: 'delayed' });
        }
        continue;
      }

      if (entry.constant) {
        // No keyword scan, so nothing about a later pass could change the answer.
        if (pass === 0) matches.push({ candidate, reason: 'constant' });
        continue;
      }

      if (entry.key.length === 0) continue;

      const haystack = buffer.get(candidate.scanDepth);
      if (!haystack) continue;
      if (!matchAny(haystack, entry.key, candidate.match, cache)) continue;
      if (
        entry.selective &&
        !evaluateSecondary(
          haystack,
          entry.keysecondary,
          entry.selectiveLogic,
          candidate.match,
          cache,
        )
      ) {
        continue;
      }

      matches.push({ candidate, reason: pass === 0 ? 'keyword' : 'recursion' });
    }

    if (matches.length === 0) break;

    const survivors = resolveGroups(matches, activatedGroups, rng, skipped);
    const recursionText: string[] = [];

    for (const match of survivors) {
      const { candidate } = match;
      const { entry, ref } = candidate;

      // Marked fired whatever happens next: a losing probability roll must not be
      // re-rolled on the next pass, or a 10% entry would creep towards certainty.
      fired.add(candidate);

      if (!passesProbability(entry, rng)) {
        skipped.push({ ...ref, reason: 'probability' });
        continue;
      }

      const tokens = countTokens(entry.content);

      if (!entry.ignoreBudget) {
        if (budgetExhausted || used + tokens > budget) {
          budgetExhausted = true;
          skipped.push({ ...ref, reason: 'budget', tokens });
          continue;
        }
        used += tokens;
      }

      const { placement, foldedFrom } = foldPosition(entry.position);
      activated.push({
        ...ref,
        order: entry.order,
        tokens,
        placement,
        ...(placement === 'depth'
          ? { depth: entry.depth, role: WI_ROLE_TO_STRING[entry.role] ?? 'system' }
          : {}),
        reason: match.reason,
        pass,
        ...(foldedFrom ? { foldedFrom } : {}),
        content: entry.content,
      });

      for (const group of entry.group.split(/,\s*/)) {
        const name = group.trim();
        if (name) activatedGroups.add(name);
      }

      if (!entry.preventRecursion) recursionText.push(entry.content);
    }

    // Nothing new can be triggered by content nobody admitted. Budget exhaustion no
    // longer ends the loop on its own: normal entries are skipped from matching once the
    // budget is gone, so the only thing that can still fire is an `ignoreBudget` entry
    // keyed by newly admitted recursive content — and if none does, `matches` is empty
    // and the loop ends on the next pass's empty-match break above.
    if (!settings.recursive || recursionText.length === 0) break;
    for (const text of recursionText) buffer.addRecursed(text);
  }

  return {
    ...emit(activated),
    activated,
    skipped,
    tokens: used,
    budget,
    budgetExhausted,
    passes: Math.min(pass + 1, maxPasses),
  };
}

/**
 * Activated entries into the three shapes assembly wants.
 *
 * Order matters and is the reverse of what reading the sort suggests: entries are walked
 * in DESCENDING `order` and unshifted, so the emitted block ends up ascending with the
 * highest `order` last — closest to the chat. That is ST's behaviour (world-info.js:5084
 * sorts descending, then unshifts) and it is why a higher `order` feels "more important".
 */
function emit(activated: ActivatedEntry[]): {
  before: string;
  after: string;
  depth: DepthInjection[];
} {
  const before: string[] = [];
  const after: string[] = [];
  const depth: DepthInjection[] = [];

  // Sorted across ALL passes, not just within one. An entry that fired on recursion is
  // placed by its `order` like any other, so a copy is sorted here rather than relying on
  // the activation sequence — which is grouped by pass and would put a low-order
  // recursion hit after a high-order one from the chat.
  const ordered = [...activated].sort(
    (a, b) => b.order - a.order || a.sourceIndex - b.sourceIndex || a.uid - b.uid,
  );

  for (const entry of ordered) {
    if (entry.placement === 'before') before.unshift(entry.content);
    else if (entry.placement === 'after') after.unshift(entry.content);
    else {
      depth.push({
        depth: entry.depth ?? 0,
        order: entry.order,
        role: entry.role ?? 'system',
        content: entry.content,
      });
    }
  }

  return { before: before.join('\n'), after: after.join('\n'), depth };
}
