import type { ChatSummary } from '@shared/types/chat.ts';
import {
  emptyGroup,
  type GroupConfig,
  type GroupTemplate,
  groupProblem,
} from '@shared/types/group.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { chatApi, groupApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { GroupEditor, type GroupEditorOptions } from './GroupEditor.tsx';
import type { GroupChatController } from './useGroupChat.ts';

export function GroupsPanel({
  chat,
  onOpen,
  registerPersistence,
  initialGeneration,
  ...options
}: GroupEditorOptions & {
  chat: GroupChatController;
  onOpen(id: string): Promise<void>;
  registerPersistence(c: PersistenceControls | null): void;
  initialGeneration: GroupConfig['generation'];
}) {
  const [groups, setGroups] = useState<GroupTemplate[]>([]);
  const [scenes, setScenes] = useState<ChatSummary[]>([]);
  const [draft, setDraft] = useState<GroupConfig | null>(null);
  const [editing, setEditing] = useState<GroupTemplate | 'scene' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Live validation: the specific reason is shown beside Save and becomes its title —
  // disabled beats refused, and the number ranges the editor can violate are not
  // guessable from a generic "invalid settings".
  const problem = draft ? groupProblem(draft, editing === 'scene' ? 0 : 2) : null;
  const refresh = useCallback(async () => {
    const [g, c] = await Promise.all([groupApi.list(), chatApi.list()]);
    setGroups(g);
    setScenes(c.filter((v) => v.kind === 'group'));
  }, []);
  // The open chat is an intentional trigger: switching scenes must re-list them even
  // though `refresh` itself reads nothing from it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chat.state.chatId is the trigger
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [refresh, chat.state.chatId]);
  const save = useCallback(async () => {
    const value = draftRef.current;
    if (!value) return;
    const problem = groupProblem(value, editingRef.current === 'scene' ? 0 : 2);
    if (problem) throw new Error(problem);
    if (editingRef.current === 'scene') {
      if (chat.busy || chat.nexus.run.running || chat.summaryStatus.running)
        throw new Error('Wait for the exchange and memory operations to finish.');
      chat.updateMetadata({ group: { ...chat.stateRef.current.metadata.group!, ...value } });
      await chat.saveNow();
    } else if (editingRef.current) {
      await groupApi.save(editingRef.current.id, editingRef.current.revision, value);
    } else {
      await groupApi.create(value);
    }
    draftRef.current = null;
    setDraft(null);
    setEditing(null);
    await refresh();
  }, [chat, refresh]);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    registerPersistence({ flush: () => saveRef.current(), retry: () => saveRef.current() });
    return () => registerPersistence(null);
  }, [registerPersistence]);
  const act = (f: () => Promise<unknown>) => {
    setError(null);
    void f().catch((e) => setError(e.message));
  };
  const start = async (g: GroupTemplate) => {
    const { id, revision: _r, created: _c, modified: _m, ...config } = g;
    const scene = await chatApi.create({
      kind: 'group',
      title: g.name,
      metadata: { persona: chat.persona?.id ?? null, group: { ...config, templateId: id } },
    });
    await refresh();
    await onOpen(scene.id);
  };
  return (
    <div className="groups-panel">
      {error ? <p role="alert">{error}</p> : null}
      {draft ? (
        <>
          <div className="group-actions">
            <button
              type="button"
              className="wc-button wc-button--primary"
              disabled={!!problem}
              title={problem ?? undefined}
              onClick={() => act(save)}
            >
              Save
            </button>
            <button
              type="button"
              className="wc-button"
              onClick={() => {
                draftRef.current = null;
                setDraft(null);
                setEditing(null);
              }}
            >
              Discard
            </button>
          </div>
          {problem ? <p role="alert">{problem}</p> : null}
          <GroupEditor
            {...options}
            value={draft}
            onChange={setDraft}
            disabled={
              editing === 'scene' &&
              (chat.busy || chat.nexus.run.running || chat.summaryStatus.running)
            }
          />
        </>
      ) : (
        <>
          <div className="group-actions">
            <button
              type="button"
              className="wc-button wc-button--primary"
              onClick={() => {
                setEditing(null);
                setDraft({ ...emptyGroup(), generation: initialGeneration });
              }}
            >
              New group
            </button>
            {chat.state.chatId ? (
              <button
                type="button"
                className="wc-button"
                disabled={chat.busy}
                onClick={() => {
                  setEditing('scene');
                  setDraft(structuredClone(chat.state.metadata.group!));
                }}
              >
                Edit this scene’s cast
              </button>
            ) : null}
          </div>
          <p className="group-note">
            Reusable casts. Each scene keeps its own settings and history.
          </p>
          {groups.map((g) => (
            <section className="group-card" key={g.id}>
              <h3>{g.name}</h3>
              <p>{g.members.map((m) => m.name).join(' · ')}</p>
              <div className="group-actions">
                <button
                  type="button"
                  className="wc-button wc-button--primary"
                  onClick={() => act(() => start(g))}
                >
                  New scene
                </button>
                <button
                  type="button"
                  className="wc-button"
                  onClick={() => {
                    setEditing(g);
                    const { id: _i, revision: _r, created: _c, modified: _m, ...config } = g;
                    setDraft(config);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="wc-button"
                  onClick={() =>
                    act(async () => {
                      await groupApi.create({ ...g, name: `${g.name} (copy)` });
                      await refresh();
                    })
                  }
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  className="wc-button"
                  onBlur={() => setConfirm(null)}
                  onClick={() =>
                    confirm === g.id
                      ? act(async () => {
                          await groupApi.remove(g.id);
                          await refresh();
                        })
                      : setConfirm(g.id)
                  }
                >
                  {confirm === g.id ? 'Confirm delete' : 'Delete'}
                </button>
              </div>
            </section>
          ))}
          <h3>Scenes</h3>
          {scenes.map((s) => (
            <button
              type="button"
              className="group-scene"
              key={s.id}
              onClick={() => act(() => onOpen(s.id))}
            >
              <strong>{s.title}</strong>
              <span>
                {s.messageCount} messages · {s.lastMessage.slice(0, 90)}
              </span>
            </button>
          ))}
          {!groups.length ? <p>Create a group to bring characters into a shared scene.</p> : null}
        </>
      )}
    </div>
  );
}
