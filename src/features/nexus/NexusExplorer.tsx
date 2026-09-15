import {
  canonicalNode,
  describeRevisionChange,
  latest,
  liveRecords,
  mergeNodes,
  nodeVersion,
  reviseNode,
  reviseRecord,
  textKey,
  validEvidence,
} from '@shared/nexus/state.ts';
import type {
  NexusEvidence,
  NexusKind,
  NexusNodeKind,
  NexusRecord,
  NexusRevision,
} from '@shared/nexus/types.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Popover } from '../../components/Popover.tsx';
import { type HighlightPart, highlightParts } from '../chat/cardSearch.ts';
import type { UseChat } from '../chat/useChat.ts';
import { type Camera, fitCamera, screenPoint, VIEW_H, VIEW_W, Z_MAX, Z_MIN } from './camera.ts';
import { layoutEdgeLabels } from './edgeLabels.ts';
import { nexusGraph, nodePosition } from './graph.ts';
import { NexusActivity } from './NexusActivity.tsx';
import { NexusCosmicCanvas } from './NexusCosmicCanvas.tsx';
import { NexusNodeArt } from './NexusNodeArt.tsx';
import { NexusReport } from './NexusReport.tsx';
import { NexusSettings, type NexusSettingsProps } from './NexusSettings.tsx';
import { MIN_HIGHLIGHT_QUERY, matchRanges } from './searchHighlight.ts';
import { nexusCounts, nexusSummaryLine, plural, revisionDateLabel } from './summaryLine.ts';
import './Nexus.css';

type Props = NexusSettingsProps & {
  chat: Pick<UseChat, 'nexus' | 'state' | 'memoryMode' | 'messages' | 'saving' | 'saveError'>;
};
const KINDS = ['person', 'place', 'object', 'event', 'group', 'concept'] as const;
const RECORD_KINDS = ['fact', 'event', 'situation', 'thread'] as const;
const TITLE = {
  person: 'People',
  place: 'Places',
  object: 'Objects',
  event: 'Events',
  group: 'Groups',
  concept: 'Concepts',
};
const SYMBOL = { person: '◎', place: '⌖', object: '◇', event: '✦', group: '⬡', concept: '❖' };
/** The floating node card's width, matching `--wc-nexus-card`. */
const CARD_WIDTH = 380;
export function NexusExplorer({ chat, ...config }: Props) {
  const n = chat.nexus;
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<NexusNodeKind | 'all'>('all');
  const [view, setView] = useState<'map' | 'list'>('map');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const selectNode = useCallback((id: string | null) => {
    setSelected(id);
    setEditing(null);
  }, []);
  const closeEditor = useCallback(() => {
    setEditing(null);
    editButton.current?.focus({ preventScroll: true });
  }, []);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, z: 1 });
  const [introActive, setIntroActive] = useState(false);
  const [introProgress, setIntroProgress] = useState(0);
  const introRaf = useRef<number | null>(null);
  const [archived, setArchived] = useState(false);
  const [limit, setLimit] = useState(80);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<NexusNodeKind>('person');
  const [mergeTarget, setMergeTarget] = useState('');
  const [confirm, setConfirm] = useState('');
  const [activityOpen, setActivityOpen] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  // The rendered map's pixel size, for anchoring the node card to its node. The SVG
  // letterboxes its viewBox, so element size — not window size — is what projection needs.
  const [viewport, setViewport] = useState({ width: VIEW_W, height: VIEW_H });
  const root = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(
    null,
  );
  const anchor = chat.messages.at(-1)?.id;

  const skipIntro = useCallback(() => {
    if (introRaf.current !== null) {
      cancelAnimationFrame(introRaf.current);
      introRaf.current = null;
    }
    setIntroActive(false);
    setIntroProgress(1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: camera and selection belong to the chat identity
  useEffect(() => {
    selectNode(null);
    setCamera({ x: 0, y: 0, z: 1 });
    setSearch('');
    setConfirm('');
    skipIntro();
  }, [chat.state.chatId, skipIntro]);

  useEffect(() => {
    return () => {
      if (introRaf.current !== null) {
        cancelAnimationFrame(introRaf.current);
        introRaf.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const listener = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, []);
  useEffect(() => {
    if (!n.open) return;
    const opener = document.activeElement as HTMLElement | null;
    const shell = document.getElementById('root');
    const wasInert = shell?.inert;
    if (shell) shell.inert = true;
    root.current?.querySelector<HTMLButtonElement>('[data-close]')?.focus({ preventScroll: true });
    return () => {
      if (shell) shell.inert = wasInert ?? false;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [n.open]);
  useEffect(() => {
    if (!n.open) return;
    const key = (e: KeyboardEvent) => {
      if (introActive && e.key !== 'Tab') {
        skipIntro();
        if (e.key !== 'Escape') return;
      }
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        // The activity popover's own Escape only runs when focus sits inside its popup;
        // the whisper trigger keeps focus, so its layer is peeled back here. Same
        // layering for the node card, then the explorer itself.
        if (activityOpen) setActivityOpen(false);
        else if (editing) closeEditor();
        else if (selected) selectNode(null);
        else n.setOpen(false);
      }
      if (e.key === 'Tab') {
        const controls = [
          ...(root.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
          ) ?? []),
        ].filter((el) => el.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
    };
  }, [
    n.open,
    n.setOpen,
    introActive,
    skipIntro,
    selected,
    activityOpen,
    editing,
    closeEditor,
    selectNode,
  ]);
  useEffect(() => {
    if (editing && view === 'map' && n.section === 'explore') {
      root.current
        ?.querySelector<HTMLInputElement>('.nexus-nodecard__name')
        ?.focus({ preventScroll: true });
    }
  }, [editing, view, n.section]);
  // The node card anchors to the selected node in pixel space, so it needs the rendered
  // map's size. Re-subscribes when the map mounts or unmounts (view/section switches).
  useEffect(() => {
    const el = svg.current;
    if (!el || !n.open || n.section !== 'explore' || view !== 'map') return;
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [n.open, n.section, view]);
  const graph = useMemo(() => nexusGraph(n.data, chat.messages), [n.data, chat.messages]);
  const positions = useMemo(
    () => new Map(n.data.nodes.map((v, i) => [v.id, nodePosition(i)])),
    [n.data.nodes],
  );
  const active = useMemo(
    () => new Set(liveRecords(n.data, chat.messages).map((r) => r.record.id)),
    [n.data, chat.messages],
  );
  const nodeById = useMemo(() => new Map(n.data.nodes.map((v) => [v.id, v])), [n.data.nodes]);
  const selectedNode = selected ? nodeById.get(selected) : undefined;
  const node = selectedNode && nodeVersion(selectedNode);
  const matches = (text: string) => text.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const matchingRecords = n.data.records.filter((r) => {
    const v = latest(r);
    return (
      (archived || !v.deleted) &&
      (!selected || v.nodeIds.some((id) => canonicalNode(n.data, id) === selected)) &&
      (kind === 'all' ||
        v.nodeIds.some(
          (id) => nodeById.get(canonicalNode(n.data, id))?.versions.at(-1)?.kind === kind,
        )) &&
      matches(
        `${v.text} ${v.cues.join(' ')} ${v.nodeIds.map((id) => nodeById.get(id)?.versions.at(-1)?.name).join(' ')}`,
      )
    );
  });
  const matchedIds = new Set(
    matchingRecords.flatMap((r) => latest(r).nodeIds.map((id) => canonicalNode(n.data, id))),
  );
  const visibleNodes = (
    archived ? n.data.nodes.filter((v) => !nodeVersion(v).mergedInto) : graph.nodes
  ).filter(
    (v) =>
      (kind === 'all' || nodeVersion(v).kind === kind) &&
      (!search ||
        matches(nodeVersion(v).name) ||
        nodeVersion(v).aliases.some(matches) ||
        matchedIds.has(v.id)),
  );
  const neighbours = new Set(
    graph.edges
      .filter((e) => e.from === selected || e.to === selected)
      .flatMap((e) => [e.from, e.to]),
  );
  const drawn = [...visibleNodes]
    .sort(
      (a, b) =>
        Number(b.id === selected || neighbours.has(b.id)) -
        Number(a.id === selected || neighbours.has(a.id)),
    )
    .slice(0, 180);
  const drawnIds = new Set(drawn.map((v) => v.id));
  const drawnEdges = graph.edges
    .filter((e) => drawnIds.has(e.from) && drawnIds.has(e.to))
    .slice(0, 500);
  const drawnEdgeIds = new Set(drawnEdges.map((e) => e.id));
  const edgeLabels = useMemo(() => {
    if (!selected) return [];
    const context = document.createElement('canvas').getContext('2d');
    const font = getComputedStyle(document.documentElement)
      .getPropertyValue('--wc-font-sans')
      .trim();
    if (context) context.font = `11px ${font}`;
    return layoutEdgeLabels(
      graph.edges.filter((e) => e.from === selected || e.to === selected),
      graph.nodes.map((n) => {
        const name = nodeVersion(n).name;
        return {
          id: n.id,
          ...positions.get(n.id)!,
          name: name.length > 24 ? `${name.slice(0, 23)}…` : name,
        };
      }),
      (text) => context?.measureText(text).width ?? text.length * 7,
    );
  }, [graph, positions, selected]);
  // Fit once per open, when the map is actually on screen: show() can open
  // straight to Recall or Settings, and the map renders only in Explore.
  const fittedOpen = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit runs once per open, over that render's nodes
  useEffect(() => {
    if (!n.open) {
      fittedOpen.current = false;
      skipIntro();
      return;
    }
    if (fittedOpen.current || n.section !== 'explore' || view !== 'map') return;
    fittedOpen.current = true;
    fit(true);
  }, [n.open, n.section, view, skipIntro]);
  const recalled = new Set(
    n.recall?.hits.filter((h) => h.included).flatMap((h) => h.nodeIds) ?? [],
  );
  const configured = Boolean(
    config.connections.some((c) => c.id === config.settings.connectionId) && config.settings.model,
  );
  // Hand-authored records are real writes to the chat; on a Summary/off chat they would
  // never be recalled, so the add affordances wait for the mode switch instead.
  const nexusMode = chat.memoryMode === 'nexus';
  function changeNode(patch: Partial<NonNullable<typeof node>>) {
    if (selected) n.update((s) => reviseNode(s, selected, patch, anchor));
  }
  function addRecord(kind: NexusKind) {
    const id = crypto.randomUUID();
    n.update((s) => ({
      ...s,
      records: [
        ...s.records,
        {
          id,
          revisions: [
            {
              text: '',
              kind,
              assertion: kind === 'event' ? 'event' : 'fact',
              status: 'active',
              nodeIds: selected ? [selected] : [],
              evidence: [],
              anchorId: anchor,
              created: Date.now(),
              enabled: true,
              pinned: false,
              deleted: false,
              manual: true,
              cues: [],
            },
          ],
        },
      ],
    }));
    setView('list');
  }
  function centre() {
    const p = selected && positions.get(selected);
    if (p) setCamera((c) => ({ ...c, x: VIEW_W / 2 - p.x * c.z, y: VIEW_H / 2 - p.y * c.z }));
  }
  function fit(animateIntro = false) {
    const rect = svg.current?.getBoundingClientRect();
    const dest = fitCamera(
      [
        ...drawn.map((v) => positions.get(v.id)!),
        ...edgeLabels
          .filter((label) => drawnEdgeIds.has(label.id))
          .flatMap((label) => [
            { x: label.x - label.width / 2, y: label.y - label.height / 2 },
            { x: label.x + label.width / 2, y: label.y + label.height / 2 },
          ]),
      ],
      rect ? { width: rect.width, height: rect.height } : { width: VIEW_W, height: VIEW_H },
    );

    const motionPref = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const allowMotion = Boolean(config.settings.motion) && !hidden && !motionPref;

    if (!animateIntro || !allowMotion) {
      skipIntro();
      setCamera(dest);
      return;
    }

    if (introRaf.current !== null) {
      cancelAnimationFrame(introRaf.current);
    }
    setIntroActive(true);
    setIntroProgress(0);

    const startCam: Camera = {
      x: VIEW_W / 2 - (VIEW_W / 2 - dest.x) * 0.4,
      y: VIEW_H / 2 - (VIEW_H / 2 - dest.y) * 0.4,
      z: Math.max(Z_MIN, dest.z * 0.35),
    };
    setCamera(startCam);

    const startTime = performance.now();
    const duration = 2000;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      setIntroProgress(progress);

      if (elapsed >= 350) {
        const swoopT = Math.min(1, (elapsed - 350) / 1500);
        const ease = 1 - (1 - swoopT) ** 3;
        setCamera({
          x: startCam.x + (dest.x - startCam.x) * ease,
          y: startCam.y + (dest.y - startCam.y) * ease,
          z: startCam.z + (dest.z - startCam.z) * ease,
        });
      }

      if (progress < 1) {
        introRaf.current = requestAnimationFrame(tick);
      } else {
        setCamera(dest);
        setIntroActive(false);
        introRaf.current = null;
      }
    };
    introRaf.current = requestAnimationFrame(tick);
  }
  // Collection ("Add to Nexus", "Latest request memories") lives in the activity popover
  // the status whisper opens — the one place, reachable from every section and view.
  const collection = (
    <>
      <details open={!n.data.nodes.length}>
        <summary>Add to Nexus</summary>
        {!nexusMode ? (
          <p role="status">
            Switch this chat to Nexus memory before adding by hand — records here are only recalled
            in Nexus mode.
          </p>
        ) : null}
        <form
          className="nexus-settings"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim() || !nexusMode) return;
            const id = crypto.randomUUID();
            n.update((s) => ({
              ...s,
              nodes: [
                ...s.nodes,
                {
                  id,
                  versions: [
                    {
                      name: newName.trim(),
                      kind: newKind,
                      aliases: [],
                      manual: true,
                      evidence: [],
                      anchorId: anchor,
                    },
                  ],
                },
              ],
            }));
            setNewName('');
            selectNode(id);
          }}
        >
          <input
            className="wc-input"
            aria-label="New node name"
            placeholder="Name…"
            value={newName}
            disabled={!nexusMode}
            onChange={(e) => setNewName(e.target.value)}
          />
          <select
            className="wc-input"
            aria-label="New node category"
            value={newKind}
            disabled={!nexusMode}
            onChange={(e) => setNewKind(e.target.value as NexusNodeKind)}
          >
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <button
            type="submit"
            className="wc-button"
            disabled={!newName.trim() || !nexusMode}
            title={nexusMode ? undefined : 'Switch this chat to Nexus memory first.'}
          >
            Add node
          </button>
        </form>
        <div className="nexus-actions">
          {RECORD_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className="wc-button"
              disabled={!nexusMode}
              title={nexusMode ? undefined : 'Switch this chat to Nexus memory first.'}
              onClick={() => addRecord(k)}
            >
              Add {k}
            </button>
          ))}
        </div>
      </details>
      <details>
        <summary>Latest request memories</summary>
        <NexusReport recall={n.recall} />
      </details>
    </>
  );
  if (!n.open) return null;
  // The status whisper (bottom left): the collection/recall run while one is in flight,
  // otherwise the library line plus the index/save state the old footer carried.
  const whisper = n.run.running
    ? `${n.run.kind === 'collection' ? 'Remembering' : 'Searching'}… ${n.run.processed} / ${n.run.total}`
    : [
        nexusSummaryLine(nexusCounts(n.data)),
        n.data.paused ? 'Paused' : null,
        chat.saveError
          ? `Save failed: ${chat.saveError}`
          : chat.saving
            ? 'Saving…'
            : n.indexStatus.error
              ? 'Text and graph search'
              : `Index ${n.indexStatus.done}/${n.indexStatus.total}`,
      ]
        .filter(Boolean)
        .join(' · ');
  // The node card anchors beside its node in pixel space: screenPoint is the
  // letterbox-aware projection, and the box is flipped and clamped to stay on the map.
  // The height keeps clear of the command dock strip at the bottom (dock + 2× margin);
  // longer content scrolls inside the card instead of sliding underneath the dock.
  const anchorPos = selected ? positions.get(selected) : undefined;
  const cardAnchor = selectedNode && anchorPos ? screenPoint(anchorPos, camera, viewport) : null;
  let cardBox: { left: number; top: number; width: number; maxHeight: number } | null = null;
  if (selectedNode && cardAnchor) {
    const width = Math.min(CARD_WIDTH, Math.max(280, viewport.width - 24));
    let left = cardAnchor.x + 32;
    if (left + width > viewport.width - 12) left = Math.max(12, cardAnchor.x - 32 - width);
    const top = Math.min(Math.max(cardAnchor.y - 36, 12), Math.max(12, viewport.height - 240));
    cardBox = { left, top, width, maxHeight: Math.max(240, viewport.height - top - 78) };
  }
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="Memory Nexus"
      className="nexus"
      data-motion={config.settings.motion && !hidden}
      data-intro={introActive || undefined}
    >
      {n.section === 'settings' ? (
        <div className="nexus-page">
          <h2>Nexus settings</h2>
          <p>These settings apply to every chat that uses Nexus, not just this conversation.</p>
          <NexusSettings {...config} />
          <NexusActivity chat={chat} configured={configured} />
        </div>
      ) : n.section === 'recall' ? (
        <div className="nexus-page">
          <h2>Recall more</h2>
          <p>
            Search story memories and eligible older conversation passages. Review the findings
            before including them in your next request.
          </p>
          <label>
            Search for
            <textarea
              className="wc-input"
              value={n.query}
              onChange={(e) => n.setQuery(e.target.value)}
              rows={3}
            />
          </label>
          <div className="nexus-actions">
            <button
              type="button"
              className="wc-button wc-button--primary"
              disabled={!configured || n.run.running || !nexusMode || !n.query.trim()}
              title={
                nexusMode
                  ? undefined
                  : 'Switch this chat to Nexus memory first — “Use Nexus for this chat” on the Explore tab, or Chat context.'
              }
              onClick={() => void n.deeper(n.query)}
            >
              Search with memory model
            </button>
            {n.run.running ? (
              <button type="button" className="wc-button" onClick={n.cancel}>
                Cancel
              </button>
            ) : null}
          </div>
          {!configured ? <p>Configure a connection and model in Settings first.</p> : null}
          {!nexusMode ? <p>Switch this chat to Nexus memory to search with the model.</p> : null}
          {n.run.error ? <p role="status">{n.run.error}</p> : null}
          {n.findings.map((f) => {
            const existing = n.data.records.some(
              (r) => !latest(r).deleted && textKey(latest(r).text) === textKey(f.text),
            );
            return (
              <article className="nexus-card" key={f.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={f.selected}
                    onChange={(e) =>
                      n.setFindings((fs) =>
                        fs.map((v) => (v.id === f.id ? { ...v, selected: e.target.checked } : v)),
                      )
                    }
                  />{' '}
                  Include in next request
                </label>
                <p>{f.text}</p>
                <Sources evidence={f.evidence} chat={chat} />
                <button
                  type="button"
                  className="wc-button"
                  disabled={existing}
                  title={existing ? 'This fact is already saved as a memory.' : undefined}
                  onClick={() => n.saveFinding(f)}
                >
                  {existing ? 'Already in Nexus' : 'Save to Nexus'}
                </button>
              </article>
            );
          })}
          {n.droppedFindings ? (
            <p className="nexus-muted">
              {plural(n.droppedFindings, 'finding', 'findings')} restated memories this request
              already loads and were hidden.
            </p>
          ) : null}
          {n.findings.length ? (
            <button
              type="button"
              className="wc-button wc-button--primary"
              disabled={!n.findings.some((f) => f.selected)}
              onClick={() => {
                n.stageForSend();
                n.setOpen(false);
              }}
            >
              Use selected findings ({n.findings.filter((f) => f.selected).length})
            </button>
          ) : null}
          <p>
            Findings stay outside the transcript and attach to your next request. Use selected
            findings keeps them attached while you write; sending consumes them. A new search or a
            change to the conversation clears them. Saving permanently is a separate action.
          </p>
        </div>
      ) : (
        <div className="nexus-stage">
          {view === 'map' ? (
            <div className="nexus-map" onPointerDown={skipIntro}>
              <NexusCosmicCanvas
                introActive={introActive}
                introProgress={introProgress}
                motion={Boolean(config.settings.motion)}
                hidden={hidden}
              />
              {/* biome-ignore lint/a11y/useSemanticElements: SVG map contains keyboard-accessible interactive nodes */}
              <svg
                ref={svg}
                viewBox="0 0 1000 700"
                role="group"
                aria-label="Connected memory map. Use Tab to select nodes, or switch to List view."
                onWheel={(e) => {
                  if (introActive) skipIntro();
                  setCamera((c) => {
                    const z = Math.max(Z_MIN, Math.min(Z_MAX, c.z * (e.deltaY > 0 ? 0.9 : 1.1)));
                    return {
                      z,
                      x: VIEW_W / 2 - ((VIEW_W / 2 - c.x) * z) / c.z,
                      y: VIEW_H / 2 - ((VIEW_H / 2 - c.y) * z) / c.z,
                    };
                  });
                }}
                onPointerDown={(e) => {
                  if (introActive) skipIntro();
                  if ((e.target as Element).closest('[data-node]')) return;
                  drag.current = {
                    x: e.clientX,
                    y: e.clientY,
                    cx: camera.x,
                    cy: camera.y,
                    moved: false,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!drag.current) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const scale = Math.min(rect.width / VIEW_W, rect.height / VIEW_H);
                  const d = drag.current;
                  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
                  setCamera((c) => ({
                    ...c,
                    x: d.cx + (e.clientX - d.x) / scale,
                    y: d.cy + (e.clientY - d.y) / scale,
                  }));
                }}
                onPointerUp={() => {
                  // A still click on the background is a deselect; a drag is a pan.
                  if (drag.current && !drag.current.moved) selectNode(null);
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
              >
                <title>Memory Nexus map</title>
                <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.z})`}>
                  {!drawn.length ? (
                    <g
                      className="nexus-beacon"
                      transform={`translate(${VIEW_W / 2} ${VIEW_H / 2})`}
                    >
                      <circle className="nexus-beacon-pulse" r="54" />
                      <circle className="nexus-beacon-ring" r="36" />
                      <circle className="nexus-beacon-core" r="16" />
                      <text className="nexus-beacon-symbol" y="6">
                        ✦
                      </text>
                    </g>
                  ) : null}
                  {drawnEdges.map((e) => {
                    const a = positions.get(e.from)!,
                      b = positions.get(e.to)!;
                    const dx = b.x - a.x,
                      dy = b.y - a.y,
                      len = Math.hypot(dx, dy) || 1;
                    const distA = Math.hypot(a.x - VIEW_W / 2, a.y - VIEW_H / 2);
                    const distB = Math.hypot(b.x - VIEW_W / 2, b.y - VIEW_H / 2);
                    const edgeDelay = Math.round(
                      Math.max(360 + (distA / 600) * 380, 360 + (distB / 600) * 380) - 60,
                    );
                    return (
                      <g
                        key={e.id}
                        className="nexus-edge"
                        style={
                          {
                            '--intro-delay': `${edgeDelay}ms`,
                            '--edge-len': Math.ceil(len),
                          } as React.CSSProperties
                        }
                        data-implicit={e.implicit || undefined}
                        data-lit={e.from === selected || e.to === selected}
                        data-recalled={recalled.has(e.from) && recalled.has(e.to)}
                      >
                        <title>{e.label}</title>
                        {/* Non-scaling: the camera zooms 0.15–4, and a 1.5px stroke
                                  shared with the min zoom renders at ~0.23px — invisible. */}
                        <line
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          vectorEffect="non-scaling-stroke"
                        />
                      </g>
                    );
                  })}
                  {edgeLabels
                    .filter((label) => drawnEdgeIds.has(label.id))
                    .map((label) => (
                      <g key={label.id} className="nexus-edge-label" pointerEvents="none">
                        <path d={`M${label.anchor.x} ${label.anchor.y} L${label.x} ${label.y}`} />
                        <rect
                          x={label.x - label.width / 2}
                          y={label.y - label.height / 2}
                          width={label.width}
                          height={label.height}
                          rx="5"
                        />
                        <text
                          x={label.x}
                          y={label.y - (label.lines.length - 1) * 7}
                          dominantBaseline="middle"
                        >
                          {label.lines.map((line, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: static wrapped text fragments have no identity or state.
                            <tspan key={`${i}:${line}`} x={label.x} dy={i ? 14 : 0}>
                              {line}
                            </tspan>
                          ))}
                        </text>
                      </g>
                    ))}
                  {drawn.map((v) => {
                    const p = positions.get(v.id)!,
                      info = nodeVersion(v);
                    const dx = p.x - VIEW_W / 2;
                    const dy = p.y - VIEW_H / 2;
                    const dist = Math.hypot(dx, dy) || 1;
                    const pullback = Math.min(260, dist * 0.75);
                    const blastX = -(dx / dist) * pullback;
                    const blastY = -(dy / dist) * pullback;
                    const delay = Math.round(360 + (dist / 600) * 380);
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: SVG nodes cannot be HTML buttons
                      <g
                        key={v.id}
                        data-node
                        data-kind={info.kind}
                        data-selected={v.id === selected}
                        data-recalled={recalled.has(v.id)}
                        className="nexus-node"
                        style={
                          {
                            '--intro-delay': `${delay}ms`,
                            '--blast-x': `${Math.round(blastX)}px`,
                            '--blast-y': `${Math.round(blastY)}px`,
                          } as React.CSSProperties
                        }
                        role="button"
                        tabIndex={0}
                        aria-label={`${info.name}, ${info.kind}`}
                        aria-pressed={v.id === selected}
                        transform={`translate(${p.x} ${p.y})`}
                        onClick={() => {
                          selectNode(v.id);
                          setConfirm('');
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            selectNode(v.id);
                          }
                        }}
                      >
                        <g className="nexus-node-blossom">
                          <NexusNodeArt kind={info.kind} />
                          <text className="nexus-node-label" y="40">
                            {info.name.length > 24 ? `${info.name.slice(0, 23)}…` : info.name}
                          </text>
                        </g>
                      </g>
                    );
                  })}
                </g>
              </svg>
              {!drawn.length ? (
                <div className="nexus-empty">
                  <h2>{n.data.nodes.length ? 'No matching nodes' : 'A story worth remembering'}</h2>
                  <p>
                    Add a person, place, object, event, group or concept, or build memories from the
                    conversation.
                  </p>
                  <button type="button" className="wc-button" onClick={() => setActivityOpen(true)}>
                    Open memory activity
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="nexus-list">
              <div className="nexus-actions">
                <button className="wc-button" type="button" onClick={() => selectNode(null)}>
                  All memories
                </button>
                {visibleNodes.slice(limit - 80, limit).map((v) => {
                  const name = nodeVersion(v).name;
                  return (
                    <button
                      className="wc-button wc-button--ghost"
                      type="button"
                      key={v.id}
                      aria-pressed={selected === v.id}
                      onClick={() => selectNode(v.id)}
                    >
                      {SYMBOL[nodeVersion(v).kind]}{' '}
                      <Marked parts={highlightParts(name, matchRanges(name, search))} />
                    </button>
                  );
                })}
              </div>
              {matchingRecords.slice(limit - 80, limit).map((r) => (
                <RecordEditor
                  key={r.id}
                  record={r}
                  chat={chat}
                  valid={active.has(r.id)}
                  query={search}
                />
              ))}
              {limit > 80 ? (
                <button
                  type="button"
                  className="wc-button"
                  onClick={() => setLimit((l) => Math.max(80, l - 80))}
                >
                  Previous page
                </button>
              ) : null}
              {matchingRecords.length > limit || visibleNodes.length > limit ? (
                <button type="button" className="wc-button" onClick={() => setLimit((l) => l + 80)}>
                  Next page
                </button>
              ) : null}
              {!matchingRecords.length ? (
                <p>No matching memories. Add one or build from this conversation.</p>
              ) : null}
            </div>
          )}
          {view === 'map' && editing === selected && selectedNode && node && cardBox ? (
            <section
              key={selected}
              className="nexus-nodecard"
              id="nexus-node-editor"
              style={cardBox}
              aria-label={`${node.name} details`}
            >
              <header className="nexus-nodecard__head">
                <select
                  className="wc-input nexus-nodecard__kind"
                  aria-label="Node category"
                  value={node.kind}
                  onChange={(e) => changeNode({ kind: e.target.value as NexusNodeKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
                <input
                  key={`${selected}:${node.name}`}
                  className="wc-input nexus-nodecard__name"
                  aria-label="Node name"
                  defaultValue={node.name}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== node.name)
                      changeNode({ name: e.target.value.trim() });
                  }}
                />
                <button
                  type="button"
                  className="wc-button wc-button--ghost"
                  aria-label="Centre map on this identity"
                  title="Centre map on this identity"
                  onClick={centre}
                >
                  ⌖
                </button>
                <button
                  type="button"
                  className="wc-button wc-button--ghost"
                  aria-label="Close editor"
                  title="Close editor (Escape)"
                  onClick={closeEditor}
                >
                  ×
                </button>
              </header>
              <div className="nexus-nodecard__body">
                <label>
                  Aliases
                  <input
                    key={`${selected}:${node.aliases.join()}`}
                    className="wc-input"
                    defaultValue={node.aliases.join(', ')}
                    onBlur={(e) => {
                      const aliases = e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean);
                      if (aliases.join() !== node.aliases.join()) changeNode({ aliases });
                    }}
                  />
                </label>
                {!validEvidence(node.evidence, chat.messages) ||
                (node.anchorId && !chat.messages.some((m) => m.id === node.anchorId)) ? (
                  <p>
                    Node evidence needs review.{' '}
                    <button
                      type="button"
                      className="wc-button"
                      onClick={() => changeNode({ evidence: [] })}
                    >
                      Keep as user-authored identity
                    </button>
                  </p>
                ) : null}
                <p className="nexus-kicker">
                  {plural(matchingRecords.length, 'memory', 'memories')}
                </p>
                {matchingRecords.slice(0, 12).map((r) => (
                  <RecordEditor
                    key={r.id}
                    record={r}
                    chat={chat}
                    valid={active.has(r.id)}
                    query={search}
                  />
                ))}
                {matchingRecords.length > 12 ? (
                  <button type="button" className="wc-button" onClick={() => setView('list')}>
                    See all {matchingRecords.length} in List view
                  </button>
                ) : null}
                {!matchingRecords.length ? (
                  <p className="nexus-muted">No memories attach to this identity yet.</p>
                ) : null}
                <Sources evidence={node.evidence} chat={chat} />
                <details>
                  <summary>Merge duplicate</summary>
                  <p>
                    Only merge identities you know are the same. Their facts and revision history
                    are retained.
                  </p>
                  <select
                    className="wc-input"
                    aria-label="Merge into"
                    value={mergeTarget}
                    onChange={(e) => {
                      setMergeTarget(e.target.value);
                      setConfirm('');
                    }}
                  >
                    <option value="">Choose identity</option>
                    {graph.nodes
                      .filter((v) => v.id !== selected)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {nodeVersion(v).name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="wc-button"
                    disabled={!mergeTarget}
                    onClick={() => {
                      if (confirm === 'merge') {
                        n.update((s) => mergeNodes(s, selected!, mergeTarget, anchor));
                        selectNode(mergeTarget);
                        setMergeTarget('');
                        setConfirm('');
                      } else setConfirm('merge');
                    }}
                  >
                    {confirm === 'merge' ? 'Confirm merge' : 'Merge'}
                  </button>
                </details>
                <button
                  type="button"
                  className="wc-button wc-button--ghost"
                  onClick={() => {
                    if (node.deleted) {
                      changeNode({ deleted: false });
                      setConfirm('');
                    } else if (confirm === 'delete-node') {
                      changeNode({ deleted: true });
                      setConfirm('');
                      setView('list');
                      setArchived(true);
                    } else setConfirm('delete-node');
                  }}
                >
                  {node.deleted
                    ? 'Restore node'
                    : confirm === 'delete-node'
                      ? 'Confirm node deletion'
                      : 'Delete node'}
                </button>
                {confirm === 'delete-node' ? (
                  <p>
                    The node leaves the map. Its memories and history stay available in List view.
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      )}
      {n.section === 'explore' ? (
        <div className="nexus-hud nexus-hud--search">
          <input
            className="wc-input"
            type="search"
            aria-label="Search Nexus"
            placeholder="Search names, aliases, memories…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLimit(80);
            }}
          />
          <select
            className="wc-input"
            aria-label="Category"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="all">All categories</option>
            {KINDS.map((v) => (
              <option key={v} value={v}>
                {TITLE[v]}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/useSemanticElements: a floating HUD cluster, not a form grouping */}
      <div className="nexus-hud nexus-hud--views" role="group" aria-label="Nexus views">
        {n.section === 'explore' ? (
          <>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              aria-pressed={view === 'list'}
              onClick={() => setView((v) => (v === 'map' ? 'list' : 'map'))}
            >
              {view === 'map' ? 'List' : 'Map'}
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              aria-pressed={archived}
              onClick={() => setArchived((a) => !a)}
            >
              Deleted
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="wc-button wc-button--ghost"
          aria-pressed={n.section === 'recall'}
          onClick={() => n.enterSection(n.section === 'recall' ? 'explore' : 'recall')}
        >
          Recall more
        </button>
        <button
          type="button"
          className="wc-button wc-button--ghost"
          aria-pressed={n.section === 'settings'}
          onClick={() => n.enterSection(n.section === 'settings' ? 'explore' : 'settings')}
        >
          Settings
        </button>
      </div>
      <Popover
        label="Memory activity"
        icon={null}
        open={activityOpen}
        onOpenChange={setActivityOpen}
        placement="top-start"
        className="nexus-whisper-anchor"
        popupClassName="nexus-pop"
        renderTrigger={(props) => (
          <button
            {...props}
            type="button"
            className="nexus-whisper"
            data-error={chat.saveError || n.run.error ? '' : undefined}
            onClick={() => setActivityOpen(!activityOpen)}
          >
            <span aria-hidden="true" className="nexus-whisper__star">
              ✦
            </span>
            <span className="nexus-whisper__text" role="status">
              {whisper}
            </span>
          </button>
        )}
      >
        <div className="nexus-pop__body">
          <NexusActivity chat={chat} configured={configured} />
          {collection}
        </div>
      </Popover>
      <div className="nexus-dock">
        {n.section === 'explore' && view === 'map' ? (
          <>
            <button type="button" className="wc-button" onClick={() => fit(false)}>
              Fit
            </button>
            <button
              type="button"
              className="wc-button"
              aria-label="Zoom out"
              onClick={() => setCamera((c) => ({ ...c, z: Math.max(Z_MIN, c.z / 1.2) }))}
            >
              −
            </button>
            <button
              type="button"
              className="wc-button"
              aria-label="Zoom in"
              onClick={() => setCamera((c) => ({ ...c, z: Math.min(Z_MAX, c.z * 1.2) }))}
            >
              +
            </button>
            <span className="nexus-dock__count">
              {drawn.length}/{graph.nodes.length} nodes
            </span>
            {selectedNode && node ? (
              <>
                <span className="nexus-dock__sep" aria-hidden="true" />
                <button
                  ref={editButton}
                  type="button"
                  className="wc-button"
                  aria-label={`Edit ${node.name}`}
                  aria-expanded={editing === selected}
                  aria-controls={editing === selected ? 'nexus-node-editor' : undefined}
                  onClick={() => (editing === selected ? closeEditor() : setEditing(selected))}
                >
                  Edit{' '}
                  <span className="nexus-dock__name" title={node.name}>
                    {node.name}
                  </span>
                </button>
              </>
            ) : null}
            <span className="nexus-dock__sep" aria-hidden="true" />
          </>
        ) : null}
        <button
          type="button"
          className="wc-button nexus-exit"
          data-close
          onClick={() => n.setOpen(false)}
        >
          Exit ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}

function Sources({
  evidence,
  chat,
}: {
  evidence: NexusEvidence[];
  chat: Pick<UseChat, 'nexus' | 'state' | 'memoryMode' | 'messages' | 'saving' | 'saveError'>;
}) {
  if (!evidence.length) return <p className="nexus-muted">No transcript source attached</p>;
  return (
    <details>
      <summary>Sources ({evidence.length})</summary>
      {evidence.map((e) => (
        <div key={`${e.messageId}:${e.fingerprint}:${e.excerpt}`} className="nexus-source">
          <p>{e.excerpt}</p>
          <p>
            {validEvidence([e], chat.messages)
              ? 'Source matches'
              : 'Source changed, hidden or removed'}
          </p>
          <button
            type="button"
            className="wc-button wc-button--ghost"
            disabled={!chat.messages.some((m) => m.id === e.messageId)}
            onClick={() => {
              chat.nexus.setJumpId(e.messageId);
              chat.nexus.setOpen(false);
            }}
          >
            Jump to message
          </button>
        </div>
      ))}
    </details>
  );
}
/** `highlightParts` runs as plain spans and `<mark>`s — one renderer so every search
 * surface (memory text, identity chips) marks the query identically. */
function Marked({ parts }: { parts: HighlightPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: text runs have no other identity
          <mark key={index}>{part.text}</mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: text runs have no other identity
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function RecordEditor({
  record,
  chat,
  valid,
  query,
}: {
  record: NexusRecord;
  chat: Pick<UseChat, 'nexus' | 'state' | 'memoryMode' | 'messages' | 'saving' | 'saveError'>;
  valid: boolean;
  /** The toolbar search, so live matches are marked in the memory text. */
  query: string;
}) {
  const r = latest(record);
  // A tombstone is closed for editing: any control left live here would append revisions
  // to a deleted record (re-wording, re-categorising, pinning a memory that is gone).
  // Restore is the one way back in. A merely disabled record stays fully editable — it
  // is live data, switched off.
  const locked = r.deleted;
  const [text, setText] = useState(r.text);
  const [confirm, setConfirm] = useState<'delete' | 'reassert' | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [nodeSearch, setNodeSearch] = useState('');
  const [historyLimit, setHistoryLimit] = useState(20);
  const [relation, setRelation] = useState(r.relation ?? { from: '', to: '', label: '' });
  // The mirror is a second copy of the text; it must scroll with the control over it.
  const mirrorRef = useRef<HTMLDivElement>(null);
  const searching = query.trim().length >= MIN_HIGHLIGHT_QUERY;
  const parts = highlightParts(text, matchRanges(text, query));
  useEffect(() => setText(r.text), [r.text]);
  useEffect(() => setRelation(r.relation ?? { from: '', to: '', label: '' }), [r.relation]);
  const patch = (p: Partial<NexusRevision>) =>
    chat.nexus.update((s) => reviseRecord(s, record.id, p, chat.messages.at(-1)?.id));
  const matchingNodes = chat.nexus.data.nodes
    .filter(
      (n) =>
        !nodeVersion(n).mergedInto &&
        !nodeVersion(n).deleted &&
        (n.id === relation.from ||
          n.id === relation.to ||
          nodeVersion(n).name.toLowerCase().includes(nodeSearch.toLowerCase()) ||
          nodeVersion(n).aliases.some((a) => a.toLowerCase().includes(nodeSearch.toLowerCase()))),
    )
    .sort(
      (a, b) =>
        Number(r.nodeIds.includes(b.id) || b.id === relation.from || b.id === relation.to) -
        Number(r.nodeIds.includes(a.id) || a.id === relation.from || a.id === relation.to),
    );
  const nodes = matchingNodes.slice(0, 100);
  return (
    <article
      className="nexus-card"
      data-disabled={!r.enabled || r.deleted}
      data-deleted={r.deleted || undefined}
      data-searching={searching || undefined}
    >
      <div className="nexus-actions">
        <span className="nexus-kicker">
          {r.kind}
          {r.legacy ? ' · Legacy event' : ''}
          {r.manual ? ' · Edited' : ''}
          {r.deleted ? ' · Deleted' : !r.enabled ? ' · Disabled' : ''}
        </span>
        <label>
          <input
            type="checkbox"
            checked={r.pinned}
            disabled={locked}
            onChange={(e) => patch({ pinned: e.target.checked })}
          />{' '}
          Pin
        </label>
        <label>
          <input
            type="checkbox"
            checked={r.enabled}
            disabled={locked}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />{' '}
          Enabled
        </label>
      </div>
      {!valid && r.enabled && !r.deleted ? (
        <p role="status">Evidence is outdated or unavailable. Review before recall.</p>
      ) : null}
      <div className="nexus-card__field">
        {searching ? (
          <div ref={mirrorRef} className="nexus-card__text nexus-card__mirror" aria-hidden="true">
            <Marked parts={parts} />
            {/* A trailing newline has no height of its own in a block, so without this
                the mirror scrolls one line shorter than the textarea it must match. */}
            {text.endsWith('\n') ? ' ' : null}
          </div>
        ) : null}
        <textarea
          className="nexus-card__text nexus-card__input"
          aria-label="Memory text"
          maxLength={2000}
          rows={3}
          value={text}
          readOnly={locked}
          onChange={(e) => setText(e.target.value)}
          onScroll={(e) => {
            if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onBlur={() => {
            if (text !== r.text) patch({ text });
          }}
        />
      </div>
      <div className="nexus-actions">
        <label className="nexus-select">
          <span className="nexus-select__label">Kind</span>
          <select
            className="wc-input"
            aria-label="Memory kind"
            value={r.kind}
            disabled={locked}
            onChange={(e) => patch({ kind: e.target.value as NexusKind })}
          >
            {RECORD_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="nexus-select">
          <span className="nexus-select__label">State</span>
          <select
            className="wc-input"
            aria-label="Memory state"
            value={r.status}
            disabled={locked}
            onChange={(e) => patch({ status: e.target.value as NexusRevision['status'] })}
          >
            {['active', 'resolved', 'historical', 'conflict'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="nexus-select">
          <span className="nexus-select__label">Attribution</span>
          <select
            className="wc-input"
            aria-label="Evidence attribution"
            value={r.assertion}
            disabled={locked}
            onChange={(e) => patch({ assertion: e.target.value as NexusRevision['assertion'] })}
          >
            {['fact', 'claim', 'intention', 'event'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>
      <details onToggle={(e) => setConnectionsOpen(e.currentTarget.open)}>
        <summary>Identities and connections</summary>
        {connectionsOpen ? (
          <>
            <input
              className="wc-input"
              aria-label="Find identities"
              placeholder="Search all names and aliases…"
              value={nodeSearch}
              disabled={locked}
              onChange={(e) => setNodeSearch(e.target.value)}
            />
            <p>
              {matchingNodes.length > nodes.length
                ? `Showing ${nodes.length} of ${matchingNodes.length.toLocaleString()} matching identities — type to narrow.`
                : `Showing all ${plural(matchingNodes.length, 'matching identity', 'matching identities')}.`}
            </p>
            <div className="nexus-attachments">
              {nodes.map((n) => (
                <label key={n.id}>
                  <input
                    type="checkbox"
                    checked={r.nodeIds.some((id) => canonicalNode(chat.nexus.data, id) === n.id)}
                    disabled={locked}
                    onChange={(e) =>
                      patch({
                        nodeIds: e.target.checked
                          ? [...r.nodeIds, n.id]
                          : r.nodeIds.filter((id) => canonicalNode(chat.nexus.data, id) !== n.id),
                      })
                    }
                  />
                  {nodeVersion(n).name}
                </label>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  relation.from &&
                  relation.to &&
                  relation.from !== relation.to &&
                  relation.label.trim()
                )
                  patch({
                    relation,
                    nodeIds: [...new Set([...r.nodeIds, relation.from, relation.to])],
                  });
              }}
            >
              {(['from', 'to'] as const).map((k) => (
                <select
                  key={k}
                  className="wc-input"
                  aria-label={`Connection ${k}`}
                  value={relation[k]}
                  disabled={locked}
                  onChange={(e) => setRelation((v) => ({ ...v, [k]: e.target.value }))}
                >
                  <option value="">{k}</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {nodeVersion(n).name}
                    </option>
                  ))}
                </select>
              ))}
              <input
                className="wc-input"
                aria-label="Connection label"
                placeholder="Relationship, e.g. is from"
                value={relation.label}
                disabled={locked}
                onChange={(e) => setRelation((v) => ({ ...v, label: e.target.value }))}
              />
              <button type="submit" className="wc-button" disabled={locked}>
                Save connection
              </button>
              {r.relation ? (
                <button
                  type="button"
                  className="wc-button"
                  disabled={locked}
                  onClick={() => patch({ relation: undefined })}
                >
                  Remove connection
                </button>
              ) : null}
            </form>
          </>
        ) : null}
      </details>
      <Sources evidence={r.evidence} chat={chat} />
      {r.conflicts?.length ? (
        <p>
          Conflicts with:{' '}
          {r.conflicts
            .map(
              (id) =>
                chat.nexus.data.records.find((v) => v.id === id)?.revisions.at(-1)?.text ?? id,
            )
            .join(' · ')}
        </p>
      ) : null}
      <details onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
        <summary>History ({record.revisions.length})</summary>
        {historyOpen
          ? record.revisions
              .map((v, i) => ({ v, change: describeRevisionChange(record.revisions[i - 1], v) }))
              .slice(-historyLimit)
              .reverse()
              .map(({ v, change }) => (
                <div
                  className="nexus-source"
                  key={`${v.created}:${v.status}:${v.pinned}:${v.enabled}:${v.deleted}:${v.text}:${JSON.stringify(v.evidence)}`}
                >
                  <p>
                    {revisionDateLabel(v.created)} · {v.manual ? 'User edit' : 'Generated'} ·{' '}
                    {change ? change.join(' · ') : v.status}
                  </p>
                  {/* A state change repeats the previous text and sources; the label is the row. */}
                  {change ? null : (
                    <>
                      <p>{v.text}</p>
                      <Sources evidence={v.evidence} chat={chat} />
                    </>
                  )}
                </div>
              ))
          : null}
        {historyOpen && record.revisions.length > historyLimit ? (
          <button
            type="button"
            className="wc-button"
            onClick={() => setHistoryLimit((l) => l + 20)}
          >
            Earlier revisions
          </button>
        ) : null}
      </details>
      {!valid && r.enabled && !r.deleted ? (
        <button
          type="button"
          className="wc-button"
          onClick={() => {
            if (confirm) {
              patch({ evidence: [], needsReview: false });
              setConfirm(null);
            } else setConfirm('delete');
          }}
        >
          {confirm ? 'Confirm this as my own statement' : 'Reassert as user-authored'}
        </button>
      ) : null}
      <button
        type="button"
        className="wc-button wc-button--ghost"
        onClick={() => {
          if (r.deleted) {
            patch({ deleted: false });
            setConfirm(null);
          } else if (confirm === 'delete') {
            patch({ deleted: true });
            setConfirm(null);
          } else setConfirm('delete');
        }}
      >
        {r.deleted ? 'Restore' : confirm === 'delete' ? 'Confirm deletion' : 'Delete'}
      </button>
      {confirm ? (
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={() => setConfirm(null)}
        >
          Cancel
        </button>
      ) : null}
    </article>
  );
}
