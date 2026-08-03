/**
 * Where the user's library lives, over the wire.
 *
 * Deliberately not part of AppSettings: settings.json lives *inside* the directory being
 * described, so this cannot be a field in the document it would have to be read from.
 */

export type DataDirSource = 'env' | 'pointer' | 'default';
export type UnreachableReason = 'missing' | 'not-a-directory' | 'foreign-contents';

/** Why a chosen directory was refused. */
export type LocationCode =
  | 'not-absolute'
  | 'invalid'
  | 'filesystem-root'
  | 'system-dir'
  | 'home-dir'
  | 'inside-project'
  | 'nested'
  | 'not-a-directory'
  | 'parent-missing'
  | 'not-writable'
  | 'occupied';

/** Something the user should know before committing, but not a reason to refuse. */
export type WarningKind = 'cloud' | 'network-volume' | 'temp-dir' | 'secrets';

export interface LocationWarning {
  kind: WarningKind;
  message: string;
}

export interface LibraryStats {
  /** A library from before markers existed, or hand-copied. Adopting it writes one. */
  markerMissing: boolean;
  characters: number;
  presets: number;
  lorebooks: number;
  hasChats: boolean;
  modified: number | null;
}

/**
 * What a candidate directory is:
 *  - `empty`   nothing there, so the library moves into it
 *  - `library` a WackChatter library already, so it is adopted and nothing is moved
 *  - `same`    already the current folder
 */
export type LocationKind = 'empty' | 'library' | 'same';

export type LocationVerdict =
  | { ok: false; code: LocationCode; message: string; path: string }
  | {
      ok: true;
      kind: LocationKind;
      path: string;
      library: LibraryStats | null;
      /** A rename rather than a copy — instant, and worth saying so before a big move. */
      sameDevice: boolean;
      warnings: LocationWarning[];
      freeBytes: number | null;
    };

export interface LocationInfo {
  root: string;
  source: DataDirSource;
  /** WC_DATA_DIR wins outright, and the UI must not offer to change what it pins. */
  envLocked: boolean;
  defaultRoot: string;
  /** A configured folder that could not be used at boot; the app fell back to the default. */
  unreachable: string | null;
  reason: UnreachableReason | null;
  warnings: LocationWarning[];
  /** False where no native folder chooser exists, so the UI explains the text field. */
  canBrowse: boolean;
  /** Set when a move committed but the server could not reopen — only a restart fixes it. */
  needsRestart: string | null;
  size: { bytes: number; files: number } | null;
}

export interface BrowseResult {
  path: string | null;
  cancelled: boolean;
  timedOut: boolean;
}

export interface SwitchResult {
  root: string;
  source: DataDirSource;
  strategy: 'rename' | 'copy' | 'adopt';
  warnings: string[];
  /** Where the previous library was left, when a cross-disk move kept it. */
  oldPathKept: string | null;
  /** The client should reload: every cached list now points at a different library. */
  reload: true;
}
