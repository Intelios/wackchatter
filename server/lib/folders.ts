/**
 * Character folders, stored as real directories under data/characters.
 *
 * SillyTavern's folders are an app-level construct: lose your settings and the organisation
 * is gone. Here the folder IS the directory, so it can be made in a file browser as readily
 * as in the app, and copying the data directory carries the organisation with it because the
 * organisation is the file layout.
 *
 * THE RULE THIS MODULE EXISTS TO PROTECT: a character's identity stays its bare PNG filename,
 * never the path. Chats (`chats.character_id`), dialogue colours and chat backups all key on
 * that filename, so if the folder were part of the identity then dragging a card into a folder
 * in Finder — the very thing this feature is for — would orphan every chat with no way to
 * reconnect them. Keeping identity flat makes a move a plain rename(2) with no reference
 * cascade at all: the chats follow for free, whoever did the moving.
 *
 * The price is that names must be unique across the whole tree rather than per folder, which
 * `characterExists` in characters.ts enforces through the existing `uniqueName`.
 *
 * NO PATH CACHE, DELIBERATELY. Anything memoised from PATHS owes a reset wired into
 * `quiesce()` in relocate.ts, and the house rule is that deleting a reset obligation beats
 * adding one. A walk is one readdir per folder and reads no file contents — far cheaper than
 * listCharacters, which already reads and PNG-parses every card on every call — and it
 * self-heals against edits made outside the app for free.
 */

import { type Dirent, existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { withFileLocks, withResourceLock } from './fs.ts';
import { PATHS, safeJoinFolder, sanitizeFilename, sanitizeFolderPath } from './paths.ts';

/**
 * Filename allocation and every file move share this lock. Lives here rather than in
 * characters.ts because folders.ts is the lower module: characters.ts imports this one.
 */
export const CHARACTER_IDENTITIES = 'character-identities';

export interface CharacterFile {
  /** PNG filename including extension — the identity, e.g. "Seraphina.png". */
  avatar: string;
  /** '' at the top level, otherwise a '/'-separated path below data/characters. */
  folder: string;
  /** Absolute path on disk. */
  path: string;
}

/** Folder paths are always '/'-separated over the wire, whatever the platform uses. */
function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function depthOf(folder: string): number {
  return folder ? folder.split('/').length : 0;
}

/**
 * Shallowest first, then alphabetical.
 *
 * This is what makes duplicate basenames resolve deterministically. Duplicates cannot be
 * created through the app — `uniqueName` sees the whole tree — but a file browser can make
 * one, and the same card must not resolve to a different file from one call to the next.
 */
function compareFiles(a: CharacterFile, b: CharacterFile): number {
  return (
    depthOf(a.folder) - depthOf(b.folder) ||
    a.folder.localeCompare(b.folder) ||
    a.avatar.localeCompare(b.avatar)
  );
}

/**
 * One pass over the tree, yielding both the cards and the folders.
 *
 * Symlinks are not followed — Node's recursive readdir does not descend them — which is the
 * safe default here: no cycles, and no way for a link to walk the scan out of the library.
 * Hidden entries are skipped so a `.Spotlight-V100` or a stray dotfile never shows up as a
 * folder the user is invited to rename.
 */
function scanTree(): { files: CharacterFile[]; folders: string[] } {
  const root = PATHS.characters;
  if (!existsSync(root)) return { files: [], folders: [] };

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return { files: [], folders: [] };
  }

  const files: CharacterFile[] = [];
  const folders: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const parent = toPosix(relative(root, entry.parentPath));
    // Defensive: a parent outside the root should be impossible, so treat it as one.
    if (parent.startsWith('..')) continue;
    if (parent.split('/').some((segment) => segment.startsWith('.'))) continue;

    if (entry.isDirectory()) {
      folders.push(parent ? `${parent}/${entry.name}` : entry.name);
    } else if (entry.name.toLowerCase().endsWith('.png')) {
      files.push({
        avatar: entry.name,
        folder: parent,
        path: join(entry.parentPath, entry.name),
      });
    }
  }

  return { files: files.sort(compareFiles), folders: folders.sort((a, b) => a.localeCompare(b)) };
}

/** Every card in the library, wherever it sits. Replaces the old flat readdir. */
export function walkCharacterFiles(): CharacterFile[] {
  return scanTree().files;
}

/**
 * Every folder, including empty ones.
 *
 * Empty folders need no bookkeeping of their own: a recursive readdir lists a directory
 * whether or not anything is in it, so a folder the user made and has not filled yet
 * survives a restart because the directory is the record.
 */
export function listFolders(): string[] {
  return scanTree().folders;
}

/** Locate a card anywhere in the tree by its identity. */
export function resolveCharacterFile(avatar: string): string | null {
  const safe = sanitizeFilename(avatar);
  if (!safe) return null;

  // The overwhelmingly common case, answered without walking anything.
  const direct = join(PATHS.characters, safe);
  if (existsSync(direct)) return direct;

  for (const file of walkCharacterFiles()) {
    if (file.avatar === safe) return file.path;
  }
  return null;
}

/** The folder an absolute card path sits in, relative to the root. '' is the top level. */
export function folderOf(path: string): string {
  const parent = dirname(path);
  if (parent === PATHS.characters) return '';
  return toPosix(relative(PATHS.characters, parent));
}

/** Create a folder, and any missing parents. Returns its normalised path. */
export function createFolder(folder: string): string | null {
  // A falsy result covers both an unusable path and '', since "create the root" is meaningless.
  const normalized = sanitizeFolderPath(folder);
  if (!normalized) return null;

  const path = safeJoinFolder(PATHS.characters, normalized);
  if (!path) return null;

  mkdirSync(path, { recursive: true });
  return normalized;
}

/**
 * Rename a folder, or move it under a different parent — `to` is a full path, so both are
 * the same operation. Nothing cascades: no card's identity contains its folder.
 */
export function renameFolder(from: string, to: string): Promise<string | null> {
  const source = sanitizeFolderPath(from);
  const target = sanitizeFolderPath(to);
  if (!source || !target) return Promise.resolve(null);

  return withResourceLock(CHARACTER_IDENTITIES, async () => {
    const sourcePath = safeJoinFolder(PATHS.characters, source);
    const targetPath = safeJoinFolder(PATHS.characters, target);
    if (!sourcePath || !targetPath) return null;
    if (!isDirectory(sourcePath)) return null;
    if (sourcePath === targetPath) return target;

    if (targetPath.startsWith(`${sourcePath}/`)) {
      throw new Error('A folder cannot be moved inside itself.');
    }
    // On a case-insensitive filesystem "Fav" -> "fav" reports the target as existing when it
    // is the source. rename(2) handles that fine; only a genuine collision is refused.
    const caseOnly = sourcePath.toLowerCase() === targetPath.toLowerCase();
    if (!caseOnly && existsSync(targetPath)) {
      throw new Error(`A folder named "${target}" already exists.`);
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    await rename(sourcePath, targetPath);
    return target;
  });
}

export interface DeleteFolderResult {
  /** Cards lifted to the top level. */
  moved: number;
  /** Cards left where they were because the name was already taken at the top level. */
  skipped: string[];
  /** False when something that is not a card kept the directory alive. */
  removed: boolean;
}

/**
 * Remove a folder, lifting every card beneath it to the top level rather than deleting them.
 *
 * Safe precisely because identity is flat: the cards keep their filenames, so their chats,
 * dialogue colours and backups are untouched, and the move cannot collide with an existing
 * card because names are already unique library-wide.
 */
export function deleteFolder(folder: string): Promise<DeleteFolderResult | null> {
  const normalized = sanitizeFolderPath(folder);
  if (!normalized) return Promise.resolve(null);

  return withResourceLock(CHARACTER_IDENTITIES, async () => {
    const path = safeJoinFolder(PATHS.characters, normalized);
    if (!path || !isDirectory(path)) return null;

    const prefix = `${normalized}/`;
    const contained = walkCharacterFiles().filter(
      (file) => file.folder === normalized || file.folder.startsWith(prefix),
    );

    let moved = 0;
    const skipped: string[] = [];
    for (const file of contained) {
      const destination = join(PATHS.characters, file.avatar);
      // Only reachable via a duplicate basename made outside the app. Leaving the file put
      // is the honest outcome; overwriting would destroy a card to tidy a folder.
      if (existsSync(destination)) {
        skipped.push(file.avatar);
        continue;
      }
      await rename(file.path, destination);
      moved += 1;
    }

    return { moved, skipped, removed: await removeIfEmpty(path) };
  });
}

/**
 * Move one card into a folder. `folder` of '' means the top level.
 *
 * This is the whole feature in one function, and the reason it is this short is the identity
 * rule: a card's folder is where its file sits and nothing else refers to it, so there is no
 * cascade to run and nothing to roll back beyond the rename itself.
 */
export function moveCharacterToFolder(avatar: string, folder: string): Promise<string | null> {
  const safeAvatar = sanitizeFilename(avatar);
  const target = sanitizeFolderPath(folder);
  if (!safeAvatar || target === null) return Promise.resolve(null);

  return withResourceLock(CHARACTER_IDENTITIES, async () => {
    const source = resolveCharacterFile(safeAvatar);
    if (!source) return null;

    const directory = safeJoinFolder(PATHS.characters, target);
    if (!directory) return null;

    const destination = join(directory, safeAvatar);
    if (destination === source) return target;
    if (existsSync(destination)) {
      throw new Error(`"${safeAvatar}" already exists in that folder.`);
    }

    // Both paths locked for the move, as renameCharacter does, so an autosave in flight
    // against the card cannot land in the file we are moving out from under it.
    return withFileLocks([source, destination], async () => {
      if (!existsSync(source)) return null;
      mkdirSync(directory, { recursive: true });
      await rename(source, destination);
      return target;
    });
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Remove a directory tree bottom-up, stopping at anything that is not a directory.
 *
 * rmdir's refusal to delete a non-empty directory is the check we want rather than an
 * obstacle: "delete this folder" promised to remove a container, not to destroy notes or
 * artwork the user parked next to their cards. `.DS_Store` is the exception — macOS drops one
 * into every folder that has ever been looked at, and treating it as content would make most
 * folders on a Mac permanently undeletable.
 */
async function removeIfEmpty(dir: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  let empty = true;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!(await removeIfEmpty(join(dir, entry.name)))) empty = false;
    } else if (entry.name === '.DS_Store') {
      await unlink(join(dir, entry.name)).catch(() => {
        empty = false;
      });
    } else {
      empty = false;
    }
  }
  if (!empty) return false;

  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}
