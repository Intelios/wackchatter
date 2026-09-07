import { applyExtraction, buildNexusExtraction, parseExtraction } from '@shared/nexus/extract.ts';
import {
  memoryDocuments,
  recallQuery,
  retrieveNexus,
  searchDocuments,
  transcriptDocuments,
} from '@shared/nexus/retrieve.ts';
import {
  emptyNexus,
  evidenceFor,
  fingerprint,
  messageFingerprint,
  pendingMessages,
  validEvidence,
} from '@shared/nexus/state.ts';
import type {
  NexusEmbedding,
  NexusFinding,
  NexusRecall,
  NexusRevision,
  NexusSettings,
  NexusState,
} from '@shared/nexus/types.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { looseParseJson } from '@shared/providers/looseJson.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { ApiMessage, ChatMessage, ChatSaveSnapshot } from '@shared/types/chat.ts';
import {
  type Dispatch,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { streamGenerate } from '../../lib/api.ts';
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  toChatMessages,
} from '../chat/state/chatReducer.ts';
import { embed, embedDocument, loadIndex, saveIndex } from './embeddings.ts';

interface Options {
  state: ChatState;
  stateRef: RefObject<ChatState>;
  dispatch: Dispatch<ChatAction>;
  settings: NexusSettings;
  connection: Connection | null;
  counter: TokenCounter;
  enabled: boolean;
  profile: string;
  captureSnapshot: (state: ChatState) => ChatSaveSnapshot | null;
  persistence: {
    schedule: (snapshot: ChatSaveSnapshot) => void;
    flush: (chatId: string) => Promise<void>;
  };
}
const EMPTY = emptyNexus();
export function useNexus(options: Options) {
  const { state, enabled, settings } = options;
  const opts = useRef(options);
  opts.current = options;
  const nexus = state.metadata.nexus ?? EMPTY;
  // biome-ignore lint/correctness/useExhaustiveDependencies: projection depends only on immutable messages
  const messages = useMemo(() => toChatMessages(state), [state.messages]);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<'explore' | 'recall' | 'settings'>('explore');
  const [jumpId, setJumpId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const draftRef = useRef('');
  const [findings, setFindings] = useState<NexusFinding[]>([]);
  const findingsRef = useRef(findings);
  findingsRef.current = findings;
  const staged = useRef<NexusFinding[] | null>(null);
  const [recall, setRecall] = useState<NexusRecall | null>(null);
  const [run, setRun] = useState({
    running: false,
    processed: 0,
    total: 0,
    error: null as string | null,
    kind: 'collection' as 'collection' | 'recall',
  });
  const abort = useRef<AbortController | null>(null);
  const [indexStatus, setIndexStatus] = useState({
    done: 0,
    total: 0,
    error: null as string | null,
  });
  const vectors = useRef(new Map<string, NexusEmbedding>());
  const [indexVersion, setIndexVersion] = useState(0);
  const [loadedChat, setLoadedChat] = useState<string | null>(null);
  const docs = useMemo(
    () => [...memoryDocuments(nexus, messages), ...transcriptDocuments(messages)],
    [nexus, messages],
  );
  const identity = state.chatId;

  const update = useCallback((transform: (current: NexusState) => NexusState) => {
    const o = opts.current;
    const current = o.stateRef.current;
    if (!current.chatId) return;
    const action: ChatAction = {
      type: 'chat/metadata',
      patch: { nexus: transform(current.metadata.nexus ?? emptyNexus()) },
    };
    o.stateRef.current = chatReducer(current, action);
    o.dispatch(action);
  }, []);
  const setMode = useCallback((mode: 'classic' | 'nexus' | 'off') => {
    const o = opts.current;
    const current = o.stateRef.current;
    if (!current.chatId) return;
    if (mode !== 'nexus') abort.current?.abort();
    const action: ChatAction = { type: 'chat/metadata', patch: { memoryMode: mode } };
    o.stateRef.current = chatReducer(current, action);
    o.dispatch(action);
  }, []);
  const seedRecallQuery = useCallback(
    () => setQuery(draftRef.current || recallQuery(toChatMessages(opts.current.stateRef.current))),
    [],
  );
  const show = useCallback(
    (part: 'explore' | 'recall' | 'settings' = 'explore', draft?: string) => {
      if (draft !== undefined) draftRef.current = draft;
      if (part === 'recall') seedRecallQuery();
      setSection(part);
      setOpen(true);
    },
    [seedRecallQuery],
  );
  const enterSection = useCallback(
    (part: 'explore' | 'recall' | 'settings') => {
      // The explorer tab is the second door into recall (show() is the composer's, and
      // always reseeds): fill the query only when it is empty, so switching tabs never
      // clobbers a search already typed.
      if (part === 'recall' && !query) seedRecallQuery();
      setSection(part);
    },
    [query, seedRecallQuery],
  );
  const draftChanged = useCallback((text: string) => {
    if (text !== draftRef.current) {
      draftRef.current = text;
      // Composer clears optimistically during send; keep its already reviewed selection until dispatch.
      if (!staged.current || text.trim()) {
        setFindings([]);
        staged.current = null;
      }
    }
  }, []);
  const stageForSend = useCallback(() => {
    staged.current = structuredClone(findingsRef.current);
  }, []);
  const consume = useCallback(() => {
    staged.current = null;
    setFindings([]);
  }, []);
  const cancel = useCallback(() => {
    abort.current?.abort();
  }, []);

  useEffect(() => {
    setOpen(false);
    setFindings([]);
    staged.current = null;
    setRecall(null);
    setLoadedChat(null);
    setRun({ running: false, processed: 0, total: 0, error: null, kind: 'collection' });
    vectors.current = new Map();
    setIndexStatus({ done: 0, total: 0, error: null });
    let cancelled = false;
    if (identity)
      void loadIndex(identity)
        .then((entries) => {
          if (!cancelled) vectors.current = new Map(entries.map((e) => [e.documentId, e]));
        })
        .catch((error) => {
          if (!cancelled)
            setIndexStatus((s) => ({ ...s, error: `Index cache unavailable: ${error.message}` }));
        })
        .finally(() => {
          if (!cancelled) {
            setLoadedChat(identity);
            setIndexVersion((v) => v + 1);
          }
        });
    return () => {
      cancelled = true;
      abort.current?.abort();
      abort.current = null;
    };
  }, [identity]);

  useEffect(() => {
    if (!enabled) {
      abort.current?.abort();
      setFindings([]);
      staged.current = null;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !identity || loadedChat !== identity) return;
    let cancelled = false;
    const missing = docs.filter((d) => vectors.current.get(d.id)?.fingerprint !== d.fingerprint);
    setIndexStatus((s) => ({ ...s, done: docs.length - missing.length, total: docs.length }));
    if (!missing.length) return;
    void (async () => {
      let pending: NexusEmbedding[] = [];
      const flush = async () => {
        if (!pending.length) return;
        const batch = pending;
        pending = [];
        try {
          await saveIndex(identity, batch);
        } catch (error) {
          if (!cancelled)
            setIndexStatus((s) => ({
              ...s,
              error: `Embedding cache could not save: ${(error as Error).message}`,
            }));
        }
      };
      try {
        for (const doc of missing) {
          if (cancelled) break;
          const entry = await embedDocument(doc);
          if (cancelled) break;
          vectors.current.set(entry.documentId, entry);
          pending.push(entry);
          setIndexStatus((s) => ({ ...s, done: s.done + 1 }));
          if (pending.length >= 16) {
            await flush();
            setIndexVersion((v) => v + 1);
          }
        }
        if (!cancelled) {
          await flush();
          setIndexVersion((v) => v + 1);
        }
      } catch (error) {
        if (!cancelled)
          setIndexStatus((s) => ({
            ...s,
            error: `Semantic search unavailable: ${(error as Error).message}`,
          }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docs, identity, loadedChat, enabled]);

  useEffect(() => {
    setFindings((current) =>
      current.every((f) => validEvidence(f.evidence, messages)) ? current : [],
    );
  }, [messages]);
  const preview = useCallback(
    async (
      history: ChatMessage[],
      budget: number,
      counter: TokenCounter,
      label: NexusRecall['label'] = 'Preview',
      signal?: AbortSignal,
    ): Promise<NexusRecall> => {
      const captured = structuredClone(
        opts.current.stateRef.current.metadata.nexus ?? emptyNexus(),
      );
      const selected = structuredClone(staged.current ?? findingsRef.current);
      const query = recallQuery(
        history,
        '',
        captured.nodes.flatMap((n) => {
          const v = n.versions.at(-1)!;
          return [v.name, ...v.aliases];
        }),
      );
      let queryVector: number[] | undefined;
      let warning: string | undefined;
      if (captured.records.length) {
        try {
          queryVector = await Promise.race([
            embed(query, true),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
          ]);
          if (!queryVector)
            warning = 'Local model is warming up; this selection uses text and graph search.';
        } catch {
          warning = 'Semantic search is unavailable; this selection uses text and graph search.';
        }
      }
      const documents = memoryDocuments(captured, history);
      if (
        queryVector &&
        documents.some((d) => vectors.current.get(d.id)?.fingerprint !== d.fingerprint)
      )
        warning =
          'Semantic indexing is incomplete; unindexed memories remain available through text and graph search.';
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      return {
        ...retrieveNexus({
          nexus: captured,
          messages: history,
          query,
          budget,
          countTokens: counter.countText,
          embeddings: [...vectors.current.values()],
          queryVector,
          findings: selected,
          label,
        }),
        warning,
      };
    },
    [],
  );

  const request = useCallback(async (apiMessages: ApiMessage[], controller: AbortController) => {
    const o = opts.current;
    const connection = o.connection;
    if (!connection?.baseUrl || !connection.model)
      throw new Error('Choose a saved connection and a model for Nexus in Settings.');
    const preset = createDefaultPreset();
    preset.temperature = o.settings.temperature;
    preset.openai_max_context = o.settings.inputTokens;
    preset.openai_max_tokens = o.settings.outputTokens;
    preset.top_p = 1;
    preset.presence_penalty = 0;
    preset.frequency_penalty = 0;
    preset.stream_openai = false;
    const body = buildRequestBody({
      messages: apiMessages,
      preset,
      connection: { ...connection, showReasoning: false },
      stream: false,
      maxTokens: o.settings.outputTokens,
    });
    const result = await streamGenerate(
      body,
      controller.signal,
      { onTick: () => {} },
      '',
      connection.id,
      {
        feature: 'memory',
        sessionId: o.stateRef.current.chatId ?? undefined,
        character: o.stateRef.current.characterId ?? undefined,
        countText: o.counter.countText,
      },
    );
    if (result.finishReason === 'length')
      throw new Error(
        'The memory model reached its output limit. Increase the Nexus output allowance and retry.',
      );
    if (!result.content.trim()) throw new Error('The memory model returned no content.');
    return result;
  }, []);
  const collect = useCallback(
    async (all = false) => {
      if (abort.current) return;
      const o = opts.current;
      const chatId = o.stateRef.current.chatId;
      if (!chatId || !o.enabled) return;
      const controller = new AbortController();
      abort.current = controller;
      let processed = 0;
      const total = pendingMessages(
        o.stateRef.current.metadata.nexus ?? emptyNexus(),
        toChatMessages(o.stateRef.current),
      ).length;
      setRun({ running: true, processed, total, error: null, kind: 'collection' });
      try {
        do {
          const current = opts.current.stateRef.current;
          if (current.chatId !== chatId || controller.signal.aborted) return;
          const snapshot = current.metadata.nexus ?? emptyNexus();
          const history = toChatMessages(current);
          if (!pendingMessages(snapshot, history).length) break;
          const batch = buildNexusExtraction(
            snapshot,
            history,
            opts.current.settings,
            opts.current.counter,
            opts.current.profile,
          );
          const model = opts.current.connection?.model ?? '';
          const result = await request(batch.messages, controller);
          if (controller.signal.aborted || opts.current.stateRef.current.chatId !== chatId) return;
          const live = toChatMessages(opts.current.stateRef.current);
          if (
            !validEvidence(
              batch.items.map((i) => evidenceFor(i.message)),
              live,
            )
          )
            throw new Error(
              'The source changed while this batch was being read. Retry to use the current conversation.',
            );
          const parsed = parseExtraction(result.content, batch, snapshot);
          update((n) => applyExtraction(n, parsed, batch, result.model ?? model));
          const save = opts.current.captureSnapshot(opts.current.stateRef.current);
          if (save) {
            opts.current.persistence.schedule(save);
            await opts.current.persistence.flush(chatId);
          }
          processed += Object.keys(batch.progress).filter(
            (id) => !batch.progress[id]!.includes('@'),
          ).length;
          setRun({ running: true, processed, total, error: null, kind: 'collection' });
        } while (all && !controller.signal.aborted);
      } catch (error) {
        if (!controller.signal.aborted) setRun((s) => ({ ...s, error: (error as Error).message }));
      } finally {
        if (abort.current === controller) {
          abort.current = null;
          setRun((s) => ({ ...s, running: false }));
        }
      }
    },
    [request, update],
  );

  const build = useCallback(() => {
    update((n) => ({ ...n, initialized: true, paused: false, processed: {} }));
    void collect(true);
  }, [update, collect]);
  const startHere = useCallback(() => {
    update((n) => ({
      ...n,
      initialized: true,
      paused: false,
      processed: Object.fromEntries(
        toChatMessages(opts.current.stateRef.current)
          .filter((m) => !m.is_system && m.mes.trim())
          .map((m) => [m.id, messageFingerprint(m)]),
      ),
    }));
  }, [update]);
  const autoArm = useRef(false);
  const previousStatus = useRef(state.status);
  useEffect(() => {
    if (previousStatus.current !== 'idle' && state.status === 'idle') autoArm.current = true;
    previousStatus.current = state.status;
    if (
      !autoArm.current ||
      !enabled ||
      !nexus.initialized ||
      nexus.paused ||
      !settings.autoInterval ||
      run.error
    )
      return;
    autoArm.current = false;
    if (pendingMessages(nexus, messages).length >= settings.autoInterval && !abort.current)
      void collect();
  }, [state.status, enabled, nexus, settings.autoInterval, messages, collect, run.error]);

  const deeper = useCallback(
    async (search: string) => {
      if (abort.current || !search.trim()) return;
      const o = opts.current;
      const chatId = o.stateRef.current.chatId;
      if (!chatId || !o.enabled) return;
      const history = toChatMessages(o.stateRef.current);
      const sourceFingerprint = fingerprint(
        JSON.stringify(history.map((m) => [m.id, messageFingerprint(m), m.is_system])),
      );
      const controller = new AbortController();
      abort.current = controller;
      setFindings([]);
      setRun({ running: true, processed: 0, total: 1, error: null, kind: 'recall' });
      try {
        let vector: number[] | undefined;
        try {
          vector = await embed(search, true);
        } catch {}
        const current = o.stateRef.current.metadata.nexus ?? emptyNexus();
        const available = [...memoryDocuments(current, history), ...transcriptDocuments(history)];
        const ranked = searchDocuments(
          available,
          search,
          [...vectors.current.values()],
          vector,
        ).slice(0, 24);
        const selected: typeof ranked = [];
        const system =
          'Find information relevant to the user’s story question using only the supplied sources. Do not invent an answer. Reply ONLY with JSON {"findings":[{"text":"concise attributed finding","sources":[0]}]}. Sources are the zero-based numbers below. If no source supports an answer return {"findings":[]}. Preserve uncertainty and chronology. At most 8 findings.';
        const make = (): ApiMessage[] => [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `Question: ${search}\n\n${selected.map((r, i) => `[${i}] ${r.doc.text}`).join('\n\n')}`,
          },
        ];
        for (const r of ranked) {
          selected.push(r);
          if (
            o.counter.countChat(make()) >
            o.settings.inputTokens - o.settings.outputTokens - 128
          ) {
            selected.pop();
            break;
          }
        }
        if (!selected.length) {
          setRun((s) => ({
            ...s,
            error:
              'No relevant source passages were found. Try a name, place, or a more specific question.',
          }));
          return;
        }
        const result = await request(make(), controller);
        if (controller.signal.aborted || opts.current.stateRef.current.chatId !== chatId) return;
        const fresh = toChatMessages(opts.current.stateRef.current);
        if (
          sourceFingerprint !==
          fingerprint(JSON.stringify(fresh.map((m) => [m.id, messageFingerprint(m), m.is_system])))
        )
          throw new Error(
            'The conversation changed during this search. Search again for the current version.',
          );
        const parsed = looseParseJson(result.content) as { findings?: unknown };
        if (!Array.isArray(parsed?.findings) || parsed.findings.length > 8)
          throw new Error('The model did not return valid sourced findings.');
        const found: NexusFinding[] = parsed.findings.map((f: unknown) => {
          const v = f as { text?: unknown; sources?: unknown };
          if (
            typeof v?.text !== 'string' ||
            !v.text.trim() ||
            v.text.length > 2000 ||
            !Array.isArray(v.sources) ||
            !v.sources.length ||
            v.sources.some((i) => !Number.isInteger(i) || !selected[i])
          )
            throw new Error('A finding was missing text or cited an invalid source.');
          const docs = v.sources.map((i) => selected[i]!.doc);
          return {
            id: crypto.randomUUID(),
            text: v.text,
            evidence: docs.flatMap((d) => d.evidence),
            nodeIds: [...new Set(docs.flatMap((d) => d.nodeIds))],
            selected: true,
          };
        });
        setFindings(found);
        setRun((s) => ({
          ...s,
          processed: 1,
          error: found.length ? null : 'No supported answer was found in the retrieved passages.',
        }));
      } catch (error) {
        if (!controller.signal.aborted) setRun((s) => ({ ...s, error: (error as Error).message }));
      } finally {
        if (abort.current === controller) {
          abort.current = null;
          setRun((s) => ({ ...s, running: false }));
        }
      }
    },
    [request],
  );
  const saveFinding = useCallback(
    (finding: NexusFinding) => {
      update((n) => {
        const revision: NexusRevision = {
          text: finding.text,
          kind: 'fact',
          assertion: 'claim',
          status: 'active',
          nodeIds: finding.nodeIds,
          evidence: finding.evidence,
          anchorId: opts.current.stateRef.current.messages.at(-1)?.id,
          created: Date.now(),
          enabled: true,
          pinned: false,
          deleted: false,
          manual: true,
          cues: [],
        };
        return {
          ...n,
          records: [...n.records, { id: crypto.randomUUID(), revisions: [revision] }],
        };
      });
    },
    [update],
  );

  return {
    data: nexus,
    open,
    setOpen,
    section,
    enterSection,
    show,
    jumpId,
    setJumpId,
    query,
    setQuery,
    findings,
    setFindings,
    saveFinding,
    deeper,
    run,
    cancel,
    collect,
    build,
    startHere,
    update,
    setMode,
    preview,
    recall,
    setRecall,
    indexStatus,
    indexVersion,
    draftChanged,
    stageForSend,
    consume,
    pending: pendingMessages(nexus, messages).length,
  };
}
export type NexusController = ReturnType<typeof useNexus>;
