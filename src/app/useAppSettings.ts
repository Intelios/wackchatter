/**
 * App settings: loading them, every way they are written, and the local mirrors that keep
 * the open tab in step with cascades the server already made (a rename, a delete).
 */

import {
  type CoCreatorReasoningTarget,
  chatReasoningEffort,
  coCreatorReasoningEffort,
} from '@shared/models/reasoning.ts';
import { type ModelRef, type ModelSlot, sameModelRef } from '@shared/models/slots.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { ReasoningEffort } from '@shared/types/preset.ts';
import type {
  DialogueColorOverride,
  SettingsPatch,
  SettingsResponse,
} from '@shared/types/settings.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { settingsApi } from '../lib/api.ts';
import { useTokenizer } from '../lib/useTokenizer.ts';
import { appSettingsView, resolveAppModels } from './settingsView.ts';
import { applySavedChatModelSettings, createSettingsPainter } from './settingsWrites.ts';

/** Move or drop one key of a record, returning the same record when it has no such key. */
function rekey<T>(record: Record<string, T>, from: string, to: string | null): Record<string, T> {
  if (!Object.hasOwn(record, from)) return record;
  const next = { ...record };
  const value = next[from]!;
  delete next[from];
  if (to !== null) next[to] = value;
  return next;
}

export function useAppSettings(onError: (message: string) => void) {
  const [settings, setSettingsState] = useState<SettingsResponse | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [chatModelSaving, setChatModelSaving] = useState(false);
  const [chatModelError, setChatModelError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const chatModelWrite = useRef(false);
  const clearChatModelError = useCallback(() => setChatModelError(null), []);
  const [coCreatorReasoningSaving, setCoCreatorReasoningSaving] = useState(false);
  const [coCreatorReasoningError, setCoCreatorReasoningError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const coCreatorReasoningWrite = useRef(false);
  const clearCoCreatorReasoningError = useCallback(() => setCoCreatorReasoningError(null), []);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [setSettings] = useState(() => createSettingsPainter(setSettingsState));

  useEffect(() => {
    settingsApi
      .get()
      .then(setSettings)
      .catch((err) => onErrorRef.current((err as Error).message));
  }, [setSettings]);

  const view = useMemo(() => appSettingsView(settings), [settings]);
  const models = useMemo(() => resolveAppModels(settings), [settings]);

  // Exact for GPT and o-series, an estimate elsewhere — the same position ST is in.
  const encoding = settings?.tokenizerEncoding;
  const countTokens = useTokenizer(models.chat.model?.model ?? '', encoding);
  const summaryCountTokens = useTokenizer(models.summary.model?.model ?? '', encoding);
  const nexusCountTokens = useTokenizer(models.nexus.model?.model ?? '', encoding);

  const writeSettings = useCallback(
    async (patch: SettingsPatch) => {
      const saved = await settingsApi.save(patch);
      setSettings(saved);
      return saved;
    },
    [setSettings],
  );

  /** A write whose failure the caller handles. */
  const saveSettingsStrict = useCallback(
    async (patch: SettingsPatch) => {
      try {
        return await writeSettings(patch);
      } catch (err) {
        onErrorRef.current((err as Error).message);
        throw err;
      }
    },
    [writeSettings],
  );

  /** A fire-and-forget write: its failure is already shown in the app shell. */
  const patchSettings = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        await saveSettingsStrict(patch);
      } catch {
        // Ordinary UI autosaves must not create an unhandled rejected promise.
      }
    },
    [saveSettingsStrict],
  );

  /**
   * User Settings edits apply immediately and persist on a debounce.
   *
   * Dragging a blur slider at 60fps through `patchSettings` would issue ~60 atomic writes a
   * second, and worse, the value driving the CSS would be whatever the last round-trip
   * returned — so the image would visibly lag the thumb. The optimistic local update is what
   * makes the slider feel attached to the picture. Pending patches merge, so nudging blur and
   * then dim inside the window saves both.
   */
  const userTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userPending = useRef<Record<string, unknown>>({});

  const patchUserSettings = useCallback(
    (patch: Record<string, unknown>) => {
      setSettingsState((current) => (current ? { ...current, ...patch } : current));
      userPending.current = { ...userPending.current, ...patch };
      if (userTimer.current) clearTimeout(userTimer.current);
      userTimer.current = setTimeout(() => {
        const pending = userPending.current;
        userPending.current = {};
        void patchSettings(pending);
      }, 200);
    },
    [patchSettings],
  );

  useEffect(() => {
    return () => {
      if (userTimer.current) clearTimeout(userTimer.current);
      const pending = userPending.current;
      userPending.current = {};
      if (Object.keys(pending).length > 0) void patchSettings(pending);
    };
  }, [patchSettings]);

  /**
   * Write-through patch of the chat model's connection, for the Generation panel's
   * provider-behaviour toggles. Connection settings save immediately — they are not part of
   * the preset draft. Goes through the per-connection endpoint, never a wholesale array, so
   * a stale snapshot here cannot drop another connection.
   */
  const chatConnectionId = models.chat.model?.id ?? null;
  const patchChatConnection = useCallback(
    (patch: Partial<Connection>) => {
      if (!chatConnectionId) return;
      settingsApi
        .patchConnection(chatConnectionId, patch)
        .then(setSettings)
        .catch((err) => onErrorRef.current((err as Error).message));
    },
    [chatConnectionId, setSettings],
  );

  /** Pick one slot's model. Field-wise on the server, so no other slot moves. */
  const setModelSlot = useCallback(
    (slot: ModelSlot, ref: ModelRef | null) => void patchSettings({ models: { [slot]: ref } }),
    [patchSettings],
  );

  const saveChatModelSettings = useCallback(
    async (patch: SettingsPatch, title: string): Promise<boolean> => {
      if (chatModelWrite.current) return false;
      chatModelWrite.current = true;
      setChatModelSaving(true);
      setChatModelError(null);
      try {
        const saved = await writeSettings(patch);
        setSettingsState((current) =>
          current ? applySavedChatModelSettings(current, saved, patch) : saved,
        );
        return true;
      } catch (error) {
        setChatModelError({ title, message: (error as Error).message });
        return false;
      } finally {
        chatModelWrite.current = false;
        setChatModelSaving(false);
      }
    },
    [writeSettings],
  );

  const pickChatModel = useCallback(
    (ref: ModelRef | null) => {
      if (chatModelWrite.current) return Promise.resolve(false);
      if (sameModelRef(settingsRef.current?.models.chat, ref)) return Promise.resolve(true);
      return saveChatModelSettings({ models: { chat: ref } }, 'Model not changed');
    },
    [saveChatModelSettings],
  );

  const setChatReasoningEffort = useCallback(
    (ref: ModelRef, effort: ReasoningEffort | null) => {
      if (chatModelWrite.current) return Promise.resolve(false);
      const current = chatReasoningEffort(settingsRef.current?.chatReasoningEfforts ?? {}, ref);
      if (current === (effort ?? undefined)) return Promise.resolve(true);
      return saveChatModelSettings(
        { chatReasoningEfforts: { [ref.connectionId]: { [ref.modelId]: effort } } },
        'Reasoning effort not saved',
      );
    },
    [saveChatModelSettings],
  );

  const setCoCreatorReasoningEffort = useCallback(
    async (
      target: CoCreatorReasoningTarget,
      ref: ModelRef,
      effort: ReasoningEffort | null,
    ): Promise<boolean> => {
      if (coCreatorReasoningWrite.current) return false;
      const current = coCreatorReasoningEffort(
        settingsRef.current?.coCreatorReasoningEfforts,
        target,
        ref,
      );
      if (current === (effort ?? undefined)) return true;
      coCreatorReasoningWrite.current = true;
      setCoCreatorReasoningSaving(true);
      setCoCreatorReasoningError(null);
      const patch: SettingsPatch = {
        coCreatorReasoningEfforts: { [target]: { [ref.connectionId]: { [ref.modelId]: effort } } },
      };
      try {
        const saved = await writeSettings(patch);
        setSettingsState((prev) =>
          prev ? applySavedChatModelSettings(prev, saved, patch) : saved,
        );
        return true;
      } catch (error) {
        setCoCreatorReasoningError({
          title: 'Reasoning effort not saved',
          message: (error as Error).message,
        });
        return false;
      } finally {
        coCreatorReasoningWrite.current = false;
        setCoCreatorReasoningSaving(false);
      }
    },
    [writeSettings],
  );

  const rememberModels = useCallback(
    (recentModels: ModelRef[]) => void patchSettings({ recentModels }),
    [patchSettings],
  );

  const setFavoriteModels = useCallback(
    (favoriteModels: ModelRef[]) => void patchSettings({ favoriteModels }),
    [patchSettings],
  );

  const setModelPickerGroups = useCallback(
    (modelPickerGroups: Record<string, boolean>) => void patchSettings({ modelPickerGroups }),
    [patchSettings],
  );

  const { dialogueColors, characterRatings, characterCrops } = view;

  const patchCharacterDialogueColor = useCallback(
    (avatar: string, value: DialogueColorOverride | undefined) => {
      if (!settings) return;
      const characters = { ...dialogueColors.characters };
      if (value === undefined) delete characters[avatar];
      else characters[avatar] = value;
      void patchSettings({ dialogueColors: { ...dialogueColors, characters } });
    },
    [dialogueColors, patchSettings, settings],
  );

  const patchPersonaDialogueColor = useCallback(
    (id: string, value: DialogueColorOverride | undefined) => {
      if (!settings) return;
      const personas = { ...dialogueColors.personas };
      if (value === undefined) delete personas[id];
      else personas[id] = value;
      void patchSettings({ dialogueColors: { ...dialogueColors, personas } });
    },
    [dialogueColors, patchSettings, settings],
  );

  const patchCharacterRating = useCallback(
    (avatar: string, value: number | undefined) => {
      if (!settings) return;
      const ratings = { ...characterRatings };
      if (value === undefined) delete ratings[avatar];
      else ratings[avatar] = value;
      void patchSettings({ characterRatings: ratings });
    },
    [characterRatings, patchSettings, settings],
  );

  /** Where a face strip is cut; undefined goes back to the automatic crop. */
  const patchCharacterCrop = useCallback(
    (avatar: string, value: number | undefined) => {
      if (!settings) return;
      const crops = { ...characterCrops };
      if (value === undefined) delete crops[avatar];
      else crops[avatar] = value;
      void patchSettings({ characterCrops: crops });
    },
    [characterCrops, patchSettings, settings],
  );

  const commitGlobalVariables = useCallback(
    async (variables: SettingsResponse['variables']) => {
      await saveSettingsStrict({ variables });
    },
    [saveSettingsStrict],
  );

  /**
   * The server re-keyed (or, with `to` null, dropped) a character's dialogue colour and
   * rating along with the card. Mirror it, so this tab does not keep a stale key.
   */
  const followCharacter = useCallback((from: string, to: string | null) => {
    setSettingsState((current) => {
      if (!current) return current;
      const characters = rekey(current.dialogueColors.characters, from, to);
      const characterRatings = rekey(current.characterRatings, from, to);
      const characterCrops = rekey(current.characterCrops ?? {}, from, to);
      if (
        characters === current.dialogueColors.characters &&
        characterRatings === current.characterRatings &&
        characterCrops === current.characterCrops
      ) {
        return current;
      }
      return {
        ...current,
        dialogueColors: { ...current.dialogueColors, characters },
        characterRatings,
        characterCrops,
      };
    });
  }, []);

  /**
   * Mirrors what `cascadePersonaDelete` has already done on the server, so the open tab does
   * not keep showing a colour and a recent slot for a persona that is gone.
   */
  const forgetPersona = useCallback((id: string) => {
    setSettingsState((current) => {
      if (!current) return current;
      const hasColor = Object.hasOwn(current.dialogueColors.personas, id);
      const recentPersonaIds = current.recentPersonaIds.filter((entry) => entry !== id);
      if (!hasColor && recentPersonaIds.length === current.recentPersonaIds.length) {
        return current;
      }
      return {
        ...current,
        dialogueColors: {
          ...current.dialogueColors,
          personas: rekey(current.dialogueColors.personas, id, null),
        },
        recentPersonaIds,
      };
    });
  }, []);

  return {
    settings,
    setSettings,
    view,
    models,
    countTokens,
    summaryCountTokens,
    nexusCountTokens,
    saveSettingsStrict,
    patchSettings,
    patchUserSettings,
    patchChatConnection,
    setModelSlot,
    pickChatModel,
    setChatReasoningEffort,
    chatModelSaving,
    chatModelError,
    clearChatModelError,
    setCoCreatorReasoningEffort,
    coCreatorReasoningSaving,
    coCreatorReasoningError,
    clearCoCreatorReasoningError,
    rememberModels,
    setFavoriteModels,
    setModelPickerGroups,
    patchCharacterDialogueColor,
    patchPersonaDialogueColor,
    patchCharacterRating,
    patchCharacterCrop,
    commitGlobalVariables,
    followCharacter,
    forgetPersona,
  };
}

export type AppSettingsControls = ReturnType<typeof useAppSettings>;
