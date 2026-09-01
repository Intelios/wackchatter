/**
 * Backing the library up, over the wire.
 *
 * Separate from location.ts, which is about where the library *is*. This is about getting
 * a copy of it out — and there is deliberately no restore counterpart: an unzipped backup
 * is a library like any other, so restoring one is the existing adopt flow.
 */

export interface BackupPlan {
  /** What the download will be called. Its stem is the single folder inside the archive. */
  filename: string;
  stem: string;
  files: number;
  /** Uncompressed total, for the button label. The archive itself comes out smaller. */
  bytes: number;
  includesSecrets: boolean;
}

/** Written into the archive as backup.json, so it says what it is without the app. */
export interface BackupManifest extends BackupPlan {
  app: 'wackchatter';
  kind: 'library-backup';
  version: 1;
  created: string;
  appVersion: string;
  /** The chats.db schema this was taken from — see SCHEMA_VERSION in server/lib/db.ts. */
  schemaVersion: number;
  /** Where the library lived when the backup was taken. Informational. */
  source: string;
}
