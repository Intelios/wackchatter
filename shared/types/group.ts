/** WackChatter-owned scene configuration. Card and preset files stay untouched. */
export interface GroupGeneration {
  connectionId: string;
  model: string;
  presetId: string;
}

export interface GroupMember {
  id: string;
  characterId: string;
  name: string;
  publicProfile: string;
  muted: boolean;
  generation?: Partial<GroupGeneration>;
}

export interface GroupConfig {
  name: string;
  members: GroupMember[];
  scenario: string;
  generation: GroupGeneration;
  director: { connectionId: string; model: string; maxTokens: number; contextTokens: number };
  concurrency: number;
  replyLimit: number;
  lorebookIds: string[];
}

export interface GroupTemplate extends GroupConfig {
  id: string;
  revision: number;
  created: number;
  modified: number;
}

export interface GroupScene extends GroupConfig {
  templateId?: string;
  composerMemberId?: string;
}

export function emptyGroup(): GroupConfig {
  return {
    name: 'New group',
    members: [],
    scenario: '',
    generation: { connectionId: '', model: '', presetId: '' },
    director: { connectionId: '', model: '', maxTokens: 2048, contextTokens: 16384 },
    concurrency: 2,
    replyLimit: 4,
    lorebookIds: [],
  };
}

export function memberLabel(member: GroupMember, members: readonly GroupMember[]): string {
  return members.filter((m) => m.name === member.name).length > 1
    ? `${member.name} [${member.id}]`
    : member.name;
}

/**
 * A new cast member's id: a slug of the character's name, unique among the ids already
 * taken in the scene.
 *
 * The director asks a model to name its pick by id, so the id has to be something a model
 * can copy back exactly — a UUID asked for that, and a one-hex-digit transcription slip
 * used to cost the whole exchange. The slug is also case-folded for the same reason:
 * id matching downstream is case-insensitive, so two ids that differ only by case would
 * be two spellings of one member. Non-Latin names keep their letters; a name with
 * nothing slug-shaped left falls back to `member` rather than an empty id.
 */
export function mintMemberId(name: string, taken: readonly string[]): string {
  const fold = (v: string) => v.trim().toLowerCase();
  const base =
    fold(name)
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'member';
  let id = base;
  let n = 2;
  while (taken.some((v) => fold(v) === id)) id = `${base}-${n++}`;
  return id;
}

/**
 * The first constraint a group breaks, as a sentence for the editor to show.
 *
 * `validateGroup` is derived from this so the two can never disagree. The messages exist
 * because the editor's number boxes commit any typed value — the ranges are real, but a
 * generic "invalid settings" would point the user at the cast when the problem is, say,
 * an output allowance above 8192.
 */
export function groupProblem(value: unknown, minimumMembers = 2): string | null {
  if (!value || typeof value !== 'object') return 'Group settings are missing.';
  const g = value as GroupConfig;
  const strings = (v: unknown): v is Record<string, string> =>
    !!v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'string');
  if (typeof g.name !== 'string' || !g.name.trim()) return 'Give the group a name.';
  if (typeof g.scenario !== 'string') return 'Shared scenario must be text.';
  if (!Array.isArray(g.members)) return 'The cast is invalid.';
  if (g.members.length < minimumMembers && minimumMembers > 0)
    return `Add at least ${minimumMembers} ${minimumMembers === 1 ? 'character' : 'characters'} to the cast.`;
  if (
    !g.members.every(
      (m) =>
        m &&
        typeof m.id === 'string' &&
        !!m.id &&
        typeof m.characterId === 'string' &&
        !!m.characterId &&
        typeof m.name === 'string' &&
        typeof m.publicProfile === 'string' &&
        typeof m.muted === 'boolean' &&
        (m.generation === undefined || strings(m.generation)),
    )
  )
    return 'A cast entry is missing required fields.';
  if (new Set(g.members.map((m) => m.id)).size !== g.members.length)
    return 'The cast contains a duplicate entry.';
  if (new Set(g.members.map((m) => m.characterId)).size !== g.members.length)
    return 'Each character can join the cast once.';
  if (
    !strings(g.generation) ||
    !['connectionId', 'model', 'presetId'].every(
      (k) => typeof g.generation[k as keyof GroupGeneration] === 'string',
    )
  )
    return 'Generation defaults are incomplete.';
  if (
    !g.director ||
    typeof g.director.connectionId !== 'string' ||
    typeof g.director.model !== 'string'
  )
    return 'Choose the director connection and model.';
  if (
    !Number.isInteger(g.director.maxTokens) ||
    g.director.maxTokens < 128 ||
    g.director.maxTokens > 8192
  )
    return 'Director output allowance must be a whole number from 128 to 8192.';
  if (!Number.isInteger(g.director.contextTokens) || g.director.contextTokens > 2000000)
    return 'Director context tokens must be a whole number of at most 2000000.';
  if (!(g.director.contextTokens > g.director.maxTokens))
    return 'Director context tokens must exceed the output allowance.';
  if (!Number.isInteger(g.concurrency) || g.concurrency < 1 || g.concurrency > 4)
    return 'Simultaneous replies must be a whole number from 1 to 4.';
  if (!Number.isInteger(g.replyLimit) || g.replyLimit < 1 || g.replyLimit > 12)
    return 'Replies per exchange must be a whole number from 1 to 12.';
  if (!Array.isArray(g.lorebookIds) || !g.lorebookIds.every((id) => typeof id === 'string'))
    return 'Shared lorebook settings are invalid.';
  return null;
}

/** Strict at the persistence boundary: malformed imports must not start paid work. */
export function validateGroup(value: unknown, minimumMembers = 2): value is GroupConfig {
  return groupProblem(value, minimumMembers) === null;
}
