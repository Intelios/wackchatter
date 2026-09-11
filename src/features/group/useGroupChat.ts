import { directorMessages, parseDirector, publicCast } from '@shared/group/director.ts';
import type { NexusSettings } from '@shared/nexus/types.ts';
import { resolveOutgoingMacros } from '@shared/prompt/outgoing.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type {
  ChatMetadata,
  ChatSaveSnapshot,
  MacroVariableMap,
  MessageExtra,
  Persona,
} from '@shared/types/chat.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { SummarySettings } from '@shared/types/settings.ts';
import { DEFAULT_GUIDANCE } from '@shared/types/settings.ts';
import type { WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { chatApi, streamGenerate } from '../../lib/api.ts';
import { encodingForModel, loadCounter } from '../../lib/tokenizer.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import { ChatSaveQueue } from '../chat/chatPersistence.ts';
import type { ChatState, PromptInspection } from '../chat/state/chatReducer.ts';
import { createStreamStore, type StreamStore } from '../chat/state/streamStore.ts';
import { useNexus } from '../nexus/useNexus.ts';
import { GroupCoordinator, type GroupJob } from './coordinator.ts';
import { assembleMember, directorBody, groupConnection, memberResources } from './generation.ts';
import {
  completedGroupMessages,
  type GroupAction,
  type GroupState,
  groupReducer,
  initialGroupState,
  persistedGroupMessages,
} from './groupReducer.ts';
import { useGroupSummary } from './useGroupSummary.ts';

export interface GroupChatOptions {
  chatId: string | null;
  connections: Connection[];
  characterIds: string[];
  personas: Persona[];
  personaId: string | null;
  onPersonaSwitch(id: string | null): void;
  globalVariables: MacroVariableMap;
  commitGlobalVariables(value: MacroVariableMap): Promise<void>;
  globalBookIds: string[];
  worldInfoSettings: WorldInfoSettings;
  regexScripts: readonly RegexScript[];
  summarySettings: SummarySettings;
  summaryConnection: Connection | null;
  nexusSettings: NexusSettings;
  nexusConnection: Connection | null;
  streamingFps: number;
  tokenizerEncoding?: string;
  onOpenChat(id: string): void;
}
export function useGroupChat(options: GroupChatOptions) {
  const opts = useRef(options);
  opts.current = options;
  const [state, rawDispatch] = useReducer(groupReducer, initialGroupState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const coordinator = useRef<GroupCoordinator | null>(null);
  const streams = useRef(new Map<string, StreamStore>());
  const [loading, setLoading] = useState(false);
  const [inspections, setInspections] = useState<Record<string, PromptInspection>>({});
  const [directorInspection, setDirectorInspection] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const guidance = useRef('');
  const nextMode = useRef<'send' | 'swipe'>('send');
  const globalRef = useRef(options.globalVariables);
  globalRef.current = options.globalVariables;
  const dispatch = useCallback((action: GroupAction) => {
    stateRef.current = groupReducer(stateRef.current, action);
    rawDispatch(action);
  }, []);
  const persistence = useMemo(
    () =>
      new ChatSaveQueue(chatApi.save, 250, {
        onSaved: (s) => {
          rawDispatch({ type: 'chat/saved', chatId: s.chatId, revision: s.revision });
          setSaveError(null);
        },
        onFailed: (_id, e) => setSaveError(e.message),
        onPendingChange: setSaving,
      }),
    [],
  );
  const captureSnapshot = useCallback(
    (s: ChatState): ChatSaveSnapshot | null =>
      s.chatId
        ? {
            chatId: s.chatId,
            revision: s.revision,
            title: s.title,
            metadata: s.metadata,
            messages: persistedGroupMessages(s as GroupState),
          }
        : null,
    [],
  );
  const persona = options.personas.find((p) => p.id === state.metadata.persona) ?? null;
  const memoryMode: 'classic' | 'nexus' | 'off' =
    state.metadata.memoryMode === 'nexus'
      ? 'nexus'
      : state.metadata.memoryMode === 'off'
        ? 'off'
        : 'classic';
  const nexusCounter = useTokenizer(options.nexusSettings.model, options.tokenizerEncoding);
  const nexus = useNexus({
    state,
    stateRef,
    dispatch: rawDispatch,
    settings: options.nexusSettings,
    connection: options.nexusConnection,
    counter: nexusCounter,
    enabled: memoryMode === 'nexus',
    profile: state.metadata.group
      ? `${publicCast(state.metadata.group)}\n${state.metadata.group.scenario}`
      : '',
    captureSnapshot,
    persistence,
  });
  const nexusRef = useRef(nexus);
  nexusRef.current = nexus;

  // The transcript minus any message a job is still streaming into. Derived per render
  // would copy every message through `toChatMessage` on each of the exchange's frequent
  // state changes, so it is keyed on the only two inputs it reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projection of messages and jobs only
  const messages = useMemo(() => completedGroupMessages(state), [state.messages, state.jobs]);

  useEffect(() => {
    if (state.revision > state.persistedRevision) {
      const snapshot = captureSnapshot(state);
      if (snapshot) persistence.schedule(snapshot);
    }
  }, [state, captureSnapshot, persistence]);

  const saveNow = useCallback(async () => {
    const snapshot = captureSnapshot(stateRef.current);
    if (snapshot) {
      persistence.schedule(snapshot);
      await persistence.flush(snapshot.chatId);
    }
  }, [captureSnapshot, persistence]);

  const summary = useGroupSummary(
    state,
    stateRef,
    dispatch,
    options.summarySettings,
    options.summaryConnection,
    saveNow,
  );
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const assemble = useCallback(async (memberId: string, signal?: AbortSignal, preview = false) => {
    const captured = structuredClone(stateRef.current);
    const scene = captured.metadata.group!;
    const member = scene.members.find((m) => m.id === memberId);
    if (!member) throw new Error('This member is no longer in the scene.');
    const o = opts.current;
    const resources = await memberResources(scene, member, o.connections, o.tokenizerEncoding);
    const messages = completedGroupMessages(captured);
    const activePersona = o.personas.find((p) => p.id === captured.metadata.persona) ?? null;
    const recall =
      captured.metadata.memoryMode === 'nexus'
        ? await nexusRef.current.preview(
            messages,
            o.nexusSettings.budgetTokens,
            resources.counter,
            preview ? 'Preview' : 'Request',
            signal,
          )
        : undefined;
    const assembled = await assembleMember(
      resources,
      scene,
      memberId,
      {
        messages,
        generationType: nextMode.current === 'swipe' ? 'swipe' : 'normal',
        memoryMode:
          captured.metadata.memoryMode === 'nexus'
            ? 'nexus'
            : captured.metadata.memoryMode === 'off'
              ? 'off'
              : 'classic',
        memoryText: recall?.text,
        memorySettings: o.nexusSettings,
        summary: captured.metadata.summary,
        summarySettings: o.summarySettings,
        authorNote: captured.metadata.authorNote,
        guides: captured.metadata.guides,
        guidance: guidance.current,
        guidanceSettings: DEFAULT_GUIDANCE,
        localVariables: captured.metadata.variables,
        globalVariables: globalRef.current,
        regexScripts: o.regexScripts,
        seed: captured.chatId!,
      },
      o.globalBookIds,
      activePersona,
      o.worldInfoSettings,
      captured.chatId!,
    );
    if (!assembled.ok)
      throw new Error(
        'This member’s prompt exceeds the available context. Inspect their preset and profile.',
      );
    const body = buildRequestBody({
      messages: assembled.messages,
      preset: resources.preset,
      connection: resources.connection,
      completions: 1,
      stream: resources.preset.stream_openai !== false,
    });
    const inspection: PromptInspection = {
      at: Date.now(),
      generationType: nextMode.current === 'swipe' ? 'swipe' : 'normal',
      messages: assembled.messages,
      body,
      tokenCounts: assembled.tokenCounts,
      totalTokens: assembled.totalTokens,
      droppedMessages: assembled.droppedMessages,
      macroWarnings: assembled.macroWarnings,
      nexusRecall: recall,
    };
    return {
      ...resources,
      scene,
      member,
      assembled,
      body,
      inspection,
      recall,
      chatId: captured.chatId!,
    };
  }, []);

  const prepare = useCallback(
    async (job: GroupJob): Promise<() => Promise<void>> => {
      const chatId = stateRef.current.chatId;
      const scene = stateRef.current.metadata.group!;
      const member = scene.members.find((m) => m.id === job.memberId)!;
      const mode = nextMode.current;
      nextMode.current = 'send';
      const stream = createStreamStore(opts.current.streamingFps);
      streams.current.set(job.id, stream);
      dispatch({
        type: 'group/start',
        jobId: job.id,
        memberId: member.id,
        characterId: member.characterId,
        name: member.name,
        mode,
      });
      let text = '';
      let reasoning = '';
      let extra: MessageExtra = { generation_id: job.id };
      const owns = () => stateRef.current.chatId === chatId && !!stateRef.current.jobs[job.id];
      const settle = (truncated: boolean) => {
        stream.end();
        if (owns())
          dispatch({
            type: 'group/settle',
            jobId: job.id,
            text,
            extra: {
              ...extra,
              ...(reasoning ? { reasoning } : {}),
              ...(truncated ? { truncated: true } : {}),
            },
          });
        streams.current.delete(job.id);
      };
      try {
        const prepared = await assemble(job.memberId, job.controller.signal);
        if (job.controller.signal.aborted || !owns())
          throw new DOMException('Cancelled', 'AbortError');
        guidance.current = '';
        const updates = prepared.assembled.variableUpdates;
        if (updates.localChanged)
          dispatch({ type: 'chat/metadata', patch: { variables: updates.local } });
        if (updates.globalChanged) {
          await opts.current.commitGlobalVariables(updates.global);
          globalRef.current = updates.global;
        }
        if (job.controller.signal.aborted || !owns())
          throw new DOMException('Cancelled', 'AbortError');
        extra = {
          ...extra,
          api: prepared.connection.provider,
          model: prepared.connection.model,
          connection_id: prepared.connection.id,
          preset_id: prepared.presetId,
          nexusRecall: prepared.recall,
        };
        setInspections((all) => ({ ...all, [job.memberId]: prepared.inspection }));
        if (prepared.recall) {
          nexusRef.current.setRecall(prepared.recall);
          nexusRef.current.consume();
        }
        stream.begin('', prepared.preset.stream_openai !== false);
        return async () => {
          try {
            const final = await streamGenerate(
              prepared.body,
              job.controller.signal,
              {
                onTick: (value) => {
                  if (owns()) {
                    text = value.content;
                    reasoning = value.reasoning;
                    stream.set(text, reasoning);
                  }
                },
              },
              '',
              prepared.connection.id,
              {
                feature: 'chat',
                generationId: job.id,
                sessionId: chatId!,
                character: member.characterId,
                countText: prepared.counter.countText,
              },
            );
            text = final.content;
            reasoning = final.reasoning;
            extra = {
              ...extra,
              model: final.model ?? extra.model,
              token_count: final.usage?.completion_tokens ?? prepared.counter.countText(text),
              prompt_tokens: final.usage?.prompt_tokens,
              usage_reported: !!final.usage?.completion_tokens,
            };
            settle(final.finishReason === 'length');
          } catch (error) {
            settle(true);
            throw error;
          }
        };
      } catch (error) {
        settle(true);
        throw error;
      }
    },
    [assemble, dispatch],
  );

  useEffect(() => {
    if (!options.chatId) {
      dispatch({ type: 'chat/closed' });
      return;
    }
    const id = options.chatId;
    let cancelled = false;
    let c: GroupCoordinator | null = null;
    setLoading(true);
    setInspections({});
    void chatApi
      .get(id)
      .then((chat) => {
        if (cancelled) return;
        if (chat.kind !== 'group' || !chat.metadata.group)
          throw new Error('This is not a group scene.');
        persistence.adopt(id, chat.revision);
        dispatch({
          type: 'chat/loaded',
          chat,
          personaId: chat.metadata.persona ?? opts.current.personaId,
        });
        opts.current.onPersonaSwitch(chat.metadata.persona ?? null);
        setSelectedMemberId(
          chat.metadata.group.composerMemberId ??
            chat.metadata.group.members.find((m) => !m.muted)?.id ??
            '',
        );
        c = new GroupCoordinator({
          limits: () => stateRef.current.metadata.group!,
          eligible: () =>
            stateRef.current.metadata
              .group!.members.filter(
                (m) => !m.muted && opts.current.characterIds.includes(m.characterId),
              )
              .map((m) => m.id),
          changed: () => {
            if (!cancelled)
              dispatch({
                type: 'group/running',
                running: !!c?.running || !!c?.selecting || !!c?.jobs.size,
              });
          },
          error: (message) => {
            if (!cancelled) dispatch({ type: 'group/error', message });
          },
          prepare,
          select: async (pending, eligible, capacity, remaining, signal) => {
            const scene = structuredClone(stateRef.current.metadata.group!);
            const o = opts.current;
            const connection = groupConnection(
              o.connections,
              scene.director.connectionId,
              scene.director.model,
            );
            const counter = await loadCounter(
              encodingForModel(connection.model, o.tokenizerEncoding),
            );
            const history = completedGroupMessages(stateRef.current);
            const memory =
              stateRef.current.metadata.memoryMode === 'classic'
                ? (stateRef.current.metadata.summary?.text ?? '')
                : stateRef.current.metadata.memoryMode === 'nexus'
                  ? (
                      await nexusRef.current.preview(
                        history,
                        o.nexusSettings.budgetTokens,
                        counter,
                        'Preview',
                        signal,
                      )
                    ).text
                  : '';
            const messages = directorMessages(
              scene,
              history,
              pending,
              eligible,
              capacity,
              remaining,
              memory,
              counter,
            );
            const body = directorBody(scene, connection, messages);
            if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
            setDirectorInspection(body);
            const result = await streamGenerate(body, signal, { onTick() {} }, '', connection.id, {
              feature: 'groupDirector',
              sessionId: id,
              countText: counter.countText,
            });
            // An empty reply cut off at the token limit would read as "the model refused
            // to pick" when the real cause is the output allowance — name it instead.
            if (!result.content.trim() && result.finishReason === 'length')
              throw new Error(
                'The director ran out of output room before it answered. Give the director a larger output allowance in group settings.',
              );
            return parseDirector(result.content, eligible, capacity, scene.members);
          },
        });
        coordinator.current = c;
      })
      .catch((error) => {
        if (!cancelled) dispatch({ type: 'group/error', message: (error as Error).message });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      void c?.close();
      if (coordinator.current === c) coordinator.current = null;
    };
  }, [options.chatId, dispatch, persistence, prepare]);

  const flushSaves = useCallback(async () => {
    coordinator.current?.stopAll();
    nexusRef.current.cancel();
    summaryRef.current.cancelSummary();
    // close drains preparations and streams so partial replies are settled before saving.
    await coordinator.current?.drain();
    await saveNow();
  }, [saveNow]);
  useEffect(() => {
    const pagehide = () => {
      coordinator.current?.stopAll();
      for (const [id, stream] of streams.current) {
        const live = stream.end();
        dispatch({
          type: 'group/settle',
          jobId: id,
          text: live.text,
          extra: { reasoning: live.reasoning, truncated: true, generation_id: id },
        });
      }
      const snapshot = captureSnapshot(stateRef.current);
      if (snapshot) persistence.schedule(snapshot);
      persistence.flushForPagehide();
    };
    window.addEventListener('pagehide', pagehide);
    return () => window.removeEventListener('pagehide', pagehide);
  }, [captureSnapshot, dispatch, persistence]);

  const send = useCallback(
    async (draft: string): Promise<boolean> => {
      const c = coordinator.current;
      if (!c || nexusRef.current.run.running || summaryRef.current.summaryAbort.current)
        return false;
      c.invalidate();
      try {
        await c.serialize(async () => {
          const current = stateRef.current;
          const scene = current.metadata.group!;
          const member = scene.members.find((m) => m.id === selectedMemberId);
          if (!member) throw new Error('Select a character for composer macros.');
          const o = opts.current;
          const resources = await memberResources(
            scene,
            member,
            o.connections,
            o.tokenizerEncoding,
          );
          const resolved = resolveOutgoingMacros(draft, {
            character: resources.card,
            preset: resources.preset,
            persona: o.personas.find((p) => p.id === current.metadata.persona),
            messages: completedGroupMessages(current),
            metadata: current.metadata,
            globalVariables: globalRef.current,
            seed: current.chatId!,
          });
          if (resolved.localChanged)
            dispatch({ type: 'chat/metadata', patch: { variables: resolved.local } });
          if (resolved.globalChanged) {
            await o.commitGlobalVariables(resolved.global);
            globalRef.current = resolved.global;
          }
          if (!resolved.text.trim()) return;
          dispatch({
            type: 'message/appendUser',
            id: crypto.randomUUID(),
            name: o.personas.find((p) => p.id === current.metadata.persona)?.name ?? 'User',
            personaId: current.metadata.persona ?? null,
            text: resolved.text,
          });
          c.start();
        });
        return true;
      } catch (error) {
        dispatch({ type: 'group/error', message: (error as Error).message });
        return false;
      }
    },
    [dispatch, selectedMemberId],
  );
  const guide = useCallback(
    async (text: string) => {
      if (!text.trim() || stateRef.current.status !== 'idle') return;
      guidance.current = text;
      coordinator.current?.manual(selectedMemberId);
    },
    [selectedMemberId],
  );
  const updateMetadata = useCallback(
    (patch: Partial<ChatMetadata>) => dispatch({ type: 'chat/metadata', patch }),
    [dispatch],
  );
  const openChat = useCallback(
    async (id: string) => {
      await flushSaves();
      opts.current.onOpenChat(id);
    },
    [flushSaves],
  );
  const branch = useCallback(
    async (messageId: string, reroll = false) => {
      if (stateRef.current.status !== 'idle') return;
      await saveNow();
      const branch = await chatApi.branch(stateRef.current.chatId!, messageId);
      if (reroll) sessionStorage.setItem('group-reroll', branch.id);
      await openChat(branch.id);
    },
    [saveNow, openChat],
  );
  useEffect(() => {
    if (
      !loading &&
      state.chatId &&
      coordinator.current &&
      sessionStorage.getItem('group-reroll') === state.chatId
    ) {
      sessionStorage.removeItem('group-reroll');
      const m = state.messages.at(-1);
      if (m?.memberId) {
        nextMode.current = 'swipe';
        coordinator.current.manual(m.memberId);
      }
    }
  }, [loading, state.chatId, state.messages]);
  const reroll = useCallback(
    (id: string) => {
      if (stateRef.current.status !== 'idle') return;
      const last = stateRef.current.messages.at(-1);
      if (last?.id !== id) {
        void branch(id, true);
        return;
      }
      if (last.memberId) {
        nextMode.current = 'swipe';
        coordinator.current?.manual(last.memberId);
      }
    },
    [branch],
  );
  const preview = useCallback(
    async (memberId: string) => {
      const p = await assemble(memberId, undefined, true);
      return p.inspection;
    },
    [assemble],
  );
  return {
    ...summary,
    busy: state.status !== 'idle',
    state,
    stateRef,
    messages,
    persona,
    memoryMode,
    nexus,
    loading,
    saving,
    saveError,
    saveNow,
    flushSaves,
    updateMetadata,
    openChat,
    branch,
    reroll,
    send,
    guide,
    dispatch,
    streams: streams.current,
    coordinator: coordinator.current,
    inspections,
    directorInspection,
    preview,
    selectedMemberId,
    selectMember: (id: string) => {
      setSelectedMemberId(id);
      updateMetadata({ group: { ...stateRef.current.metadata.group!, composerMemberId: id } });
    },
    setPersona: (id: string | null) => {
      updateMetadata({ persona: id });
      opts.current.onPersonaSwitch(id);
    },
  };
}
export type GroupChatController = ReturnType<typeof useGroupChat>;
