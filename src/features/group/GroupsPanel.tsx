import type { ChatSummary } from '@shared/types/chat.ts';
import {
  emptyGroup,
  type GroupConfig,
  type GroupTemplate,
  groupProblem,
} from '@shared/types/group.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Menu, type MenuEntry } from '../../components/Menu.tsx';
import { StackedAvatars } from '../../components/StackedAvatars.tsx';
import {
  ChevronLeftIcon,
  CopyIcon,
  EditIcon,
  MessagesIcon,
  MoreIcon,
  PlusIcon,
  TrashIcon,
} from '../../layout/icons.tsx';
import { characterApi, chatApi, groupApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { GroupEditor, type GroupEditorOptions } from './GroupEditor.tsx';
import { filterAndSortGroups, filterAndSortScenes, type GroupSortOption } from './groupList.ts';
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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<GroupSortOption>('recent');
  const [renamingSceneId, setRenamingSceneId] = useState<string | null>(null);
  const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
  const [confirmScene, setConfirmScene] = useState<string | null>(null);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // Live validation: the specific reason is shown beside Save and becomes its title
  const problem = draft ? groupProblem(draft, editing === 'scene' ? 0 : 2) : null;

  const refresh = useCallback(async () => {
    const [g, c] = await Promise.all([groupApi.list(), chatApi.list()]);
    setGroups(g);
    setScenes(c.filter((v) => v.kind === 'group'));
  }, []);

  // The open chat is an intentional trigger: switching scenes must re-list them
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

  const handleRenameScene = async (id: string, newTitle: string) => {
    setRenamingSceneId(null);
    if (!newTitle) return;
    await act(async () => {
      if (chat.state.chatId === id) {
        chat.dispatch({ type: 'chat/renamed', title: newTitle });
        await chat.saveNow();
      } else {
        const current = await chatApi.get(id);
        await chatApi.updateMeta(id, { revision: current.revision, title: newTitle });
      }
      await refresh();
    });
  };

  const handleDeleteScene = async (id: string) => {
    await act(async () => {
      if (chat.state.chatId === id) {
        chat.coordinator?.stopAll();
      }
      await chatApi.remove(id);
      await refresh();
    });
  };

  const discardDraft = () => {
    draftRef.current = null;
    setDraft(null);
    setEditing(null);
  };

  // Active scene check for the highlight banner
  const activeScene =
    chat.state.chatId && chat.state.metadata.group ? chat.state.metadata.group : null;

  const filteredGroups = useMemo(
    () => filterAndSortGroups(groups, query, sort),
    [groups, query, sort],
  );

  const filteredScenes = useMemo(
    () => filterAndSortScenes(scenes, options.characters, query, sort),
    [scenes, options.characters, query, sort],
  );

  if (draft) {
    return (
      <div className="groups-panel group-editor-view">
        <div className="group-editor-header">
          <button
            type="button"
            className="wc-button wc-button--ghost group-editor-header__back"
            onClick={discardDraft}
            title="Back to groups"
          >
            <ChevronLeftIcon />
            <span>Groups</span>
          </button>
          <h2 className="group-editor-header__title">
            {editing === 'scene'
              ? 'Edit Scene Cast'
              : editing
                ? `Edit ${editing.name}`
                : 'New Group'}
          </h2>
        </div>

        <div className="group-editor-scroll">
          {error ? <div className="character-list__error">{error}</div> : null}
          {problem ? (
            <div className="character-list__error" role="alert">
              {problem}
            </div>
          ) : null}
          <GroupEditor
            {...options}
            value={draft}
            onChange={setDraft}
            disabled={
              editing === 'scene' &&
              (chat.busy || chat.nexus.run.running || chat.summaryStatus.running)
            }
          />
        </div>

        <div className="groups-panel__footer group-editor-footer">
          <button
            type="button"
            className="wc-button wc-button--primary"
            disabled={!!problem}
            title={problem ?? undefined}
            onClick={() => act(save)}
          >
            Save
          </button>
          <button type="button" className="wc-button" onClick={discardDraft}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="groups-panel">
      <div className="groups-panel__search">
        <input
          className="wc-input"
          type="search"
          placeholder="Search groups, casts, or scenes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search groups and scenes"
        />
        <select
          className="wc-select groups-panel__sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as GroupSortOption)}
          aria-label="Sort groups and scenes"
          title="Sort groups and scenes"
        >
          <option value="recent">Recent</option>
          <option value="name">Name</option>
          <option value="members">Cast size</option>
        </select>
      </div>

      {error ? <div className="character-list__error">{error}</div> : null}

      <div className="groups-panel__items">
        {activeScene ? (
          <div className="active-scene-banner">
            <div className="active-scene-banner__info">
              <span className="active-scene-banner__badge">Active Scene</span>
              <strong className="active-scene-banner__title">
                {chat.state.title || activeScene.name}
              </strong>
              <span className="active-scene-banner__members">
                {activeScene.members.map((m) => m.name).join(' · ')}
              </span>
            </div>
            <button
              type="button"
              className="wc-button active-scene-banner__edit"
              disabled={chat.busy}
              onClick={() => {
                setEditing('scene');
                setDraft(structuredClone(chat.state.metadata.group!));
              }}
              title="Edit this scene's cast and settings"
            >
              <EditIcon />
              <span>Edit Cast</span>
            </button>
          </div>
        ) : null}

        {filteredGroups.length > 0 ? (
          <section className="groups-panel__section">
            <div className="groups-panel__section-header">
              <span>Group Casts</span>
              <span className="groups-panel__section-count">{filteredGroups.length}</span>
            </div>
            <div className="groups-panel__list">
              {filteredGroups.map((g) => {
                const memberUrls = g.members.map((m) => {
                  const char = options.characters.find((c) => c.avatar === m.characterId);
                  return char ? characterApi.imageUrl(char.avatar, char.modified) : null;
                });
                const memberNames = g.members.map((m) => m.name);

                const menuEntries: MenuEntry[] = [
                  {
                    label: 'New scene',
                    icon: <MessagesIcon />,
                    onSelect: () => act(() => start(g)),
                  },
                  {
                    label: 'Edit cast',
                    icon: <EditIcon />,
                    onSelect: () => {
                      setEditing(g);
                      const { id: _i, revision: _r, created: _c, modified: _m, ...config } = g;
                      setDraft(config);
                    },
                  },
                  {
                    label: 'Duplicate',
                    icon: <CopyIcon />,
                    onSelect: () =>
                      act(async () => {
                        await groupApi.create({ ...g, name: `${g.name} (copy)` });
                        await refresh();
                      }),
                  },
                  { kind: 'separator' },
                  {
                    label: confirmGroup === g.id ? 'Really delete group?' : 'Delete group',
                    icon: <TrashIcon />,
                    danger: true,
                    keepOpen: confirmGroup !== g.id,
                    onSelect: () => {
                      if (confirmGroup === g.id) {
                        act(async () => {
                          await groupApi.remove(g.id);
                          await refresh();
                        });
                      } else {
                        setConfirmGroup(g.id);
                      }
                    },
                  },
                ];

                return (
                  <div className="group-card-row" key={g.id}>
                    <button
                      type="button"
                      className="group-card-row__open"
                      onClick={() => act(() => start(g))}
                      title={`Start new scene with ${g.name}`}
                    >
                      <StackedAvatars urls={memberUrls} names={memberNames} />
                      <span className="group-card-row__text">
                        <span className="group-card-row__name">{g.name}</span>
                        <span className="group-card-row__meta">
                          {g.members.map((m) => m.name).join(' · ')}
                        </span>
                      </span>
                    </button>
                    <Menu
                      label={`Actions for ${g.name}`}
                      icon={<MoreIcon />}
                      placement="bottom-end"
                      className="wc-button wc-button--ghost group-card-row__menu"
                      entries={menuEntries}
                      onOpenChange={(open) => {
                        if (!open) setConfirmGroup(null);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {filteredScenes.length > 0 ? (
          <section className="groups-panel__section">
            <div className="groups-panel__section-header">
              <span>Recent Scenes</span>
              <span className="groups-panel__section-count">{filteredScenes.length}</span>
            </div>
            <div className="groups-panel__list">
              {filteredScenes.map((s) => {
                const memberIds = s.groupMembers ?? [];
                const sceneMemberUrls = memberIds.map((avatarId) => {
                  const char = options.characters.find((c) => c.avatar === avatarId);
                  return char ? characterApi.imageUrl(char.avatar, char.modified) : null;
                });
                const sceneMemberNames = memberIds.map((avatarId) => {
                  const char = options.characters.find((c) => c.avatar === avatarId);
                  return char ? char.name : avatarId;
                });

                const isCurrent = s.id === chat.state.chatId;

                const menuEntries: MenuEntry[] = [
                  {
                    label: 'Open scene',
                    icon: <MessagesIcon />,
                    onSelect: () => act(() => onOpen(s.id)),
                  },
                  {
                    label: 'Rename',
                    icon: <EditIcon />,
                    onSelect: () => setRenamingSceneId(s.id),
                  },
                  { kind: 'separator' },
                  {
                    label: confirmScene === s.id ? 'Really delete scene?' : 'Delete scene',
                    icon: <TrashIcon />,
                    danger: true,
                    keepOpen: confirmScene !== s.id,
                    onSelect: () => {
                      if (confirmScene === s.id) {
                        void handleDeleteScene(s.id);
                      } else {
                        setConfirmScene(s.id);
                      }
                    },
                  },
                ];

                return (
                  <div className="group-scene-row" key={s.id} data-current={isCurrent || undefined}>
                    {renamingSceneId === s.id ? (
                      <div className="group-scene-row__rename-wrap">
                        <StackedAvatars urls={sceneMemberUrls} names={sceneMemberNames} />
                        <RenameField
                          initial={s.title}
                          onCommit={(newTitle) => void handleRenameScene(s.id, newTitle)}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="group-scene-row__open"
                        onClick={() => act(() => onOpen(s.id))}
                        title={`Open scene ${s.title}`}
                      >
                        <StackedAvatars urls={sceneMemberUrls} names={sceneMemberNames} />
                        <span className="group-scene-row__text">
                          <span className="group-scene-row__name">{s.title}</span>
                          <span className="group-scene-row__meta">
                            {s.messageCount} {s.messageCount === 1 ? 'message' : 'messages'}
                            {s.lastMessage ? ` · ${s.lastMessage.slice(0, 70)}` : ''}
                          </span>
                        </span>
                      </button>
                    )}
                    <Menu
                      label={`Actions for ${s.title}`}
                      icon={<MoreIcon />}
                      placement="bottom-end"
                      className="wc-button wc-button--ghost group-scene-row__menu"
                      entries={menuEntries}
                      onOpenChange={(open) => {
                        if (!open) setConfirmScene(null);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {filteredGroups.length === 0 && filteredScenes.length === 0 ? (
          <div className="wc-empty">
            {query ? (
              <span>No groups or scenes match “{query}”.</span>
            ) : (
              <>
                <span>No groups yet.</span>
                <span>Create a group to bring characters into a shared scene.</span>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="groups-panel__footer">
        <button
          type="button"
          className="wc-button wc-button--primary"
          onClick={() => {
            setEditing(null);
            setDraft({ ...emptyGroup(), generation: initialGeneration });
          }}
        >
          <PlusIcon />
          <span>New group</span>
        </button>
      </div>
    </div>
  );
}

/** Inline rename input for a scene, commits on blur or Enter, Escape discards */
function RenameField({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (title: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="wc-input group-scene-row__rename-input"
      value={value}
      aria-label={`Rename ${initial}`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') onCommit('');
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
