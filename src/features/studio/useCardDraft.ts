import type { CardDataV2, CardExtensions, CharacterDetail } from '@shared/types/card.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { characterApi } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';

const AUTOSAVE_DELAY_MS = 700;

export type CardSaveState = 'idle' | 'saving' | 'saved' | 'error';
type EditableKey = Exclude<keyof CardDataV2, 'name' | 'character_book'>;

interface UseCardDraftOptions {
  detail: CharacterDetail;
  onSaved: (detail: CharacterDetail) => void;
  onRenamed: (detail: CharacterDetail) => void;
  onDeleted: () => void;
  registerPersistence?: (controls: PersistenceControls | null) => void;
}

function mergePatch(current: Partial<CardDataV2>, patch: Partial<CardDataV2>): Partial<CardDataV2> {
  return {
    ...current,
    ...patch,
    extensions: patch.extensions
      ? { ...(current.extensions ?? {}), ...patch.extensions }
      : current.extensions,
  };
}

/**
 * The one writer for a Studio card. It only ever sends fields changed in this editor and
 * serializes every card-level operation with the embedded-book writer.
 */
export function useCardDraft({
  detail,
  onSaved,
  onRenamed,
  onDeleted,
  registerPersistence,
}: UseCardDraftOptions) {
  const [data, setData] = useState<CardDataV2>(detail.card.data);
  const [folder, setFolder] = useState(detail.folder);
  const [saveState, setSaveState] = useState<CardSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const dataRef = useRef(data);
  const detailRef = useRef(detail);
  const avatarRef = useRef(detail.avatar);
  /**
   * Edits made since the card was opened.
   *
   * Accumulated rather than replaced: each keystroke reschedules, so sending only the most
   * recent field would drop every earlier one. Reset only when the card changes — never on a
   * successful save — because the queue clones each scheduled snapshot, and clearing the
   * accumulation mid-flight would let a later edit reschedule a patch missing fields an
   * older, still-pending snapshot had not yet written.
   */
  const pendingPatchRef = useRef<Partial<CardDataV2>>({});
  const bookPersistenceRef = useRef<PersistenceControls | null>(null);
  const callbacksRef = useRef({ onSaved, onRenamed, onDeleted });
  callbacksRef.current = { onSaved, onRenamed, onDeleted };

  const queueRef = useRef<AutosaveQueue<Partial<CardDataV2>, CharacterDetail> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new AutosaveQueue(
      (avatar, patch) => characterApi.update(avatar, patch),
      AUTOSAVE_DELAY_MS,
      {
        onSaved: (avatar, _patch, saved) => {
          if (avatar !== avatarRef.current) return;
          detailRef.current = saved;
          setSaveState('saved');
          setSaveError(null);
          callbacksRef.current.onSaved(saved);
        },
        onFailed: (avatar, error) => {
          if (avatar !== avatarRef.current) return;
          setSaveState('error');
          setSaveError(error.message);
        },
      },
    );
  }
  const queue = queueRef.current;
  const avatar = detail.avatar;

  // Components are keyed by avatar, but keeping this reset here makes the hook safe for a
  // consumer that chooses to retain it across cards later.
  //
  // The card is the trigger, never `detail`. A successful save hands the parent a fresh
  // detail which comes straight back down as a new object identity, so depending on it ran
  // this reset after every save: it reverted keystrokes typed while the PATCH was in flight,
  // cleared the accumulated patch mid-flight, and wiped the save indicator.
  // biome-ignore lint/correctness/useExhaustiveDependencies: avatar is the card identity
  useEffect(() => {
    avatarRef.current = avatar;
    detailRef.current = detail;
    dataRef.current = detail.card.data;
    pendingPatchRef.current = {};
    setData(detail.card.data);
    setFolder(detail.folder);
    setSaveState('idle');
    setSaveError(null);
  }, [avatar]);

  useEffect(() => {
    return () => {
      void queue.flushAll().catch(() => {});
    };
  }, [queue]);

  const update = useCallback(
    <K extends EditableKey>(key: K, value: CardDataV2[K]) => {
      const next = { ...dataRef.current, [key]: value };
      dataRef.current = next;
      setData(next);
      pendingPatchRef.current = mergePatch(pendingPatchRef.current, { [key]: value });
      setSaveState('saving');
      setSaveError(null);
      queue.schedule(avatar, queue.nextRevision(avatar), pendingPatchRef.current);
    },
    [avatar, queue],
  );

  const updateExtension = useCallback(
    <K extends keyof CardExtensions>(key: K, value: CardExtensions[K] | null) => {
      const extensions = { ...dataRef.current.extensions, [key]: value };
      const next = { ...dataRef.current, extensions };
      dataRef.current = next;
      setData(next);
      pendingPatchRef.current = mergePatch(pendingPatchRef.current, {
        extensions: { [key]: value },
      });
      setSaveState('saving');
      setSaveError(null);
      queue.schedule(avatar, queue.nextRevision(avatar), pendingPatchRef.current);
    },
    [avatar, queue],
  );

  const flush = useCallback(async () => {
    await queue.flush(avatar);
    await bookPersistenceRef.current?.flush();
  }, [avatar, queue]);

  const retry = useCallback(async () => {
    setSaveState('saving');
    try {
      await queue.retry(avatar);
      await bookPersistenceRef.current?.retry();
      setSaveState('saved');
      setSaveError(null);
    } catch (err) {
      setSaveState('error');
      setSaveError((err as Error).message);
      throw err;
    }
  }, [avatar, queue]);

  useEffect(() => {
    registerPersistence?.({ flush, retry });
    return () => registerPersistence?.(null);
  }, [flush, registerPersistence, retry]);

  const serializeCardWrite = useCallback(
    <T>(task: () => Promise<T>) => queue.runSerialized(avatar, task),
    [avatar, queue],
  );

  const registerBookPersistence = useCallback((controls: PersistenceControls | null) => {
    bookPersistenceRef.current = controls;
  }, []);

  const handleBookSaved = useCallback((saved: CharacterDetail) => {
    const reconciled = { ...dataRef.current, character_book: saved.card.data.character_book };
    dataRef.current = reconciled;
    detailRef.current = { ...saved, card: { ...saved.card, data: reconciled } };
    setData(reconciled);
    callbacksRef.current.onSaved(detailRef.current);
  }, []);

  const rename = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === dataRef.current.name) return false;
      setSaveState('saving');
      try {
        await flush();
        const saved = await queue.runSerialized(avatar, () => characterApi.rename(avatar, trimmed));
        queue.discard(avatar);
        setSaveState('saved');
        setSaveError(null);
        callbacksRef.current.onRenamed(saved);
        return true;
      } catch (err) {
        setSaveState('error');
        setSaveError((err as Error).message);
        return false;
      }
    },
    [avatar, flush, queue],
  );

  const moveToFolder = useCallback(
    async (nextFolder: string) => {
      if (nextFolder === folder) return;
      setSaveState('saving');
      try {
        const moved = await queue.runSerialized(avatar, () =>
          characterApi.setFolder(avatar, nextFolder),
        );
        setFolder(moved.folder);
        setSaveState('saved');
        setSaveError(null);
      } catch (err) {
        setSaveState('error');
        setSaveError((err as Error).message);
      }
    },
    [avatar, folder, queue],
  );

  const replaceAvatar = useCallback(
    async (image: File) => {
      setSaveState('saving');
      try {
        const saved = await queue.runSerialized(avatar, () =>
          characterApi.updateWithImage(avatar, {}, image),
        );
        detailRef.current = saved;
        setSaveState('saved');
        setSaveError(null);
        callbacksRef.current.onSaved(saved);
      } catch (err) {
        setSaveState('error');
        setSaveError((err as Error).message);
        throw err;
      }
    },
    [avatar, queue],
  );

  const remove = useCallback(async () => {
    setSaveState('saving');
    try {
      await bookPersistenceRef.current?.flush();
      await queue.runSerialized(avatar, () => characterApi.remove(avatar));
      queue.discard(avatar);
      callbacksRef.current.onDeleted();
      return true;
    } catch (err) {
      setSaveState('error');
      setSaveError((err as Error).message);
      return false;
    }
  }, [avatar, queue]);

  const reportError = useCallback((error: string) => {
    setSaveState('error');
    setSaveError(error);
  }, []);

  const statusLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? 'Saved'
        : saveState === 'error'
          ? (saveError ?? 'Save failed')
          : '';

  return {
    avatar,
    data,
    folder,
    saveState,
    saveError,
    statusLabel,
    update,
    updateExtension,
    flush,
    retry,
    rename,
    moveToFolder,
    replaceAvatar,
    remove,
    reportError,
    serializeCardWrite,
    registerBookPersistence,
    handleBookSaved,
  };
}
