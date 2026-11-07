/**
 * Your background images, and what you do with them: upload, delete, import from
 * SillyTavern. Shared by the 2.x settings panel and the 3.0 Settings tool, so both save the
 * same way. Picking one is a settings patch, which stays with the caller.
 */

import { useCallback, useEffect, useState } from 'react';
import { type BackgroundSummary, backgroundApi } from '../../lib/api.ts';

export function useBackgrounds(options: {
  /** The background in use, `user:<name>` or `builtin:<id>`, or null. */
  selected: string | null;
  onPick: (background: string | null) => void;
}) {
  const { selected, onPick } = options;
  const [uploads, setUploads] = useState<BackgroundSummary[]>([]);
  const [status, setStatus] = useState('');

  const refresh = useCallback(async () => {
    try {
      setUploads(await backgroundApi.list());
    } catch (err) {
      setStatus((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function upload(file: File | undefined) {
    if (!file) return;
    try {
      const saved = await backgroundApi.upload(file);
      await refresh();
      onPick(`user:${saved.name}`);
      setStatus('');
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  async function remove(name: string) {
    try {
      await backgroundApi.remove(name);
      // Clearing the selection in the same action, or the app shows a broken image.
      if (selected === `user:${name}`) onPick(null);
      await refresh();
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  async function importFromSillyTavern() {
    setStatus('Importing…');
    try {
      const result = await backgroundApi.importFromSillyTavern();
      await refresh();
      setStatus(
        result.imported.length === 0
          ? `Nothing new to import — all ${result.skipped.length} already here.`
          : `Imported ${result.imported.length}, skipped ${result.skipped.length} already here.`,
      );
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  return { uploads, status, upload, remove, importFromSillyTavern };
}
