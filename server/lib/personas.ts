/**
 * Persona storage. One JSON file per persona in data/personas, avatars alongside in
 * data/personas/avatars.
 *
 * Unlike presets and lorebooks, **the filename stem is an opaque id and `name` is an
 * ordinary editable field**. `ChatMetadata.persona` stores that id, so if renaming moved
 * the file every chat that referenced the persona would be orphaned by a typo fix.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Persona } from '../../shared/types/chat.ts';
import { withFileLock } from './fs.ts';
import { contentTypeFor, isImageFilename } from './images.ts';
import { PATHS, safeJoin } from './paths.ts';

function personaPath(id: string): string | null {
  return safeJoin(PATHS.personas, `${id}.json`);
}

export function avatarPath(filename: string): string | null {
  if (!isImageFilename(filename)) return null;
  return safeJoin(PATHS.personaAvatars, filename);
}

export function avatarContentType(filename: string): string {
  return contentTypeFor(filename);
}

/** Coerce a stored file into a usable persona. Never throws on a bad field. */
function normalizePersona(raw: unknown, id: string): Persona {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const persona: Persona = {
    id,
    name: typeof stored.name === 'string' && stored.name.trim() ? stored.name : id,
    description: typeof stored.description === 'string' ? stored.description : '',
    avatar: typeof stored.avatar === 'string' && stored.avatar ? stored.avatar : null,
  };

  if (typeof stored.depth === 'number' && Number.isFinite(stored.depth)) {
    persona.depth = stored.depth;
  }
  if (
    stored.position === 'inPrompt' ||
    stored.position === 'topAuthorNote' ||
    stored.position === 'bottomAuthorNote' ||
    stored.position === 'atDepth' ||
    stored.position === 'none'
  ) {
    persona.position = stored.position;
  }
  if (stored.role === 'system' || stored.role === 'user' || stored.role === 'assistant') {
    persona.role = stored.role;
  }
  if (typeof stored.lorebookId === 'string' && stored.lorebookId) {
    persona.lorebookId = stored.lorebookId;
  }
  // A variant's link to its base. A self-reference is not a link (a hand edit can produce
  // one); anything else that is not a non-empty string simply means "standalone persona".
  if (typeof stored.variantOf === 'string' && stored.variantOf && stored.variantOf !== id) {
    persona.variantOf = stored.variantOf;
  }
  if (typeof stored.variantLabel === 'string' && stored.variantLabel.trim()) {
    persona.variantLabel = stored.variantLabel.trim();
  }

  return persona;
}

/** Every persona, in full — they are small enough that a summary type would be noise. */
export function listPersonas(): Persona[] {
  if (!existsSync(PATHS.personas)) return [];

  return readdirSync(PATHS.personas)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => {
      const id = basename(file, '.json');
      try {
        return normalizePersona(JSON.parse(readFileSync(join(PATHS.personas, file), 'utf8')), id);
      } catch {
        // A corrupt persona still appears, so it can be seen and fixed rather than
        // silently vanishing from the list.
        return normalizePersona(null, id);
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getPersona(id: string): Persona | null {
  const path = personaPath(id);
  if (!path || !existsSync(path)) return null;

  try {
    return normalizePersona(JSON.parse(readFileSync(path, 'utf8')), id);
  } catch (error) {
    throw new Error(`Persona "${id}" could not be read: ${(error as Error).message}`);
  }
}

export async function savePersona(
  id: string,
  patch: Partial<Persona>,
  allowCreate = false,
): Promise<Persona> {
  const path = personaPath(id);
  if (!path) throw new Error(`"${id}" is not a usable persona id.`);

  return withFileLock(path, async (replace) => {
    // The read belongs inside the same lock as the replacement: persona autosave and a
    // lorebook-reference cascade may update different fields at the same time.
    const stored = getPersona(id);
    if (!stored && !allowCreate) throw new Error('Persona not found.');
    const current = stored ?? normalizePersona(null, id);
    const next = normalizePersona({ ...current, ...patch }, id);

    await replace(`${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export async function createPersona(name: string): Promise<Persona> {
  // An opaque id, because the name is editable and must be free to collide.
  const id = crypto.randomUUID();
  return savePersona(id, { name: name.trim() || 'You', description: '', avatar: null }, true);
}

/**
 * The first label a new variant can take, given its siblings'. "Variant", then "Variant 2",
 * "Variant 3"…, skipping anything already in use (case-insensitively) and filling gaps.
 */
export function nextVariantLabel(existing: readonly string[]): string {
  const taken = new Set(existing.map((label) => label.trim().toLowerCase()));
  if (!taken.has('variant')) return 'Variant';
  for (let n = 2; ; n++) {
    const candidate = `Variant ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Create a variant of a persona: a full copy sharing the base's name, linked by `variantOf`.
 *
 * A variant is a whole persona of its own — its own file and id, so chats, messages and
 * settings record exactly which one was used — grouped under the base only by this link.
 * One level, always: a variant of a variant joins the same base, so a group can never grow
 * into a chain. Deleting the base severs the link rather than cascading; the variant then
 * stands alone, the same way an orphaned `ChatMetadata.persona` does.
 */
export async function createVariant(baseId: string, label?: string): Promise<Persona> {
  const base = getPersona(baseId);
  if (!base) throw new Error('Persona not found.');

  const target = base.variantOf ?? base.id;
  const siblings = listPersonas().filter((persona) => persona.variantOf === target);
  const variantLabel =
    typeof label === 'string' && label.trim()
      ? label.trim()
      : nextVariantLabel(siblings.map((persona) => persona.variantLabel ?? ''));

  const id = crypto.randomUUID();

  // The avatar is copied, not shared: an avatar file belongs to the id it is named for, and
  // a variant replacing its face must not delete the base's. A missing file degrades to none.
  let avatar: string | null = null;
  if (base.avatar) {
    const source = avatarPath(base.avatar);
    if (source && existsSync(source)) {
      const filename = `${id}${extname(base.avatar)}`;
      const destination = avatarPath(filename);
      if (destination) {
        await Bun.write(destination, Bun.file(source));
        avatar = filename;
      }
    }
  }

  const { id: _baseId, variantOf: _baseLink, variantLabel: _baseLabel, ...copy } = base;
  return savePersona(id, { ...copy, avatar, variantOf: target, variantLabel }, true);
}

export function deletePersona(id: string): boolean {
  const path = personaPath(id);
  if (!path || !existsSync(path)) return false;

  // Remove the avatar too, or the directory accumulates orphans nothing can reach.
  const persona = getPersona(id);
  if (persona?.avatar) {
    const avatar = avatarPath(persona.avatar);
    if (avatar && existsSync(avatar)) unlinkSync(avatar);
  }

  unlinkSync(path);
  return true;
}

/** Update persona links when a standalone lorebook is renamed or removed. */
export async function updatePersonaLorebookReferences(
  currentId: string,
  nextId: string | null,
): Promise<() => Promise<void>> {
  const affected = listPersonas().filter((persona) => persona.lorebookId === currentId);
  const changed: string[] = [];
  try {
    for (const persona of affected) {
      const current = getPersona(persona.id);
      if (current?.lorebookId !== currentId) continue;
      await savePersona(persona.id, { lorebookId: nextId });
      changed.push(persona.id);
    }
  } catch (error) {
    try {
      await restorePersonaLorebookReferences(changed, nextId, currentId);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Persona reference rollback failed.');
    }
    throw error;
  }

  return () => restorePersonaLorebookReferences(changed, nextId, currentId);
}

async function restorePersonaLorebookReferences(
  ids: string[],
  expected: string | null,
  next: string | null,
): Promise<void> {
  for (const id of [...ids].reverse()) {
    const current = getPersona(id);
    if (!current || (current.lorebookId ?? null) !== expected) continue;
    await savePersona(id, { lorebookId: next });
  }
}

/** Store an uploaded avatar and point the persona at it. */
export async function setPersonaAvatar(id: string, file: File): Promise<Persona> {
  const extension = extname(file.name).toLowerCase();
  if (!isImageFilename(file.name)) {
    throw new Error(`"${extension || file.name}" is not a supported image type.`);
  }

  const persona = getPersona(id);
  if (!persona) throw new Error('Persona not found.');

  // Named after the persona so the file is identifiable on disk, and overwritten in place
  // so replacing an avatar never leaves the old one behind.
  const filename = `${id}${extension}`;
  const path = avatarPath(filename);
  if (!path) throw new Error('Could not write the avatar.');

  if (persona.avatar && persona.avatar !== filename) {
    const previous = avatarPath(persona.avatar);
    if (previous && existsSync(previous)) unlinkSync(previous);
  }

  await Bun.write(path, await file.arrayBuffer());
  return savePersona(id, { avatar: filename });
}
