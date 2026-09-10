/**
 * The branch timeline: this chat's family, drawn left to right.
 *
 * Takes the chat column the way `CardReader` does — portaled into the shell's overlay root
 * and pinned to the column's grid cell, so the top bar and both side panels stay visible,
 * and opening a panel compresses this exactly as it compresses the chat underneath. Not a
 * modal: nothing here needs the rest of the app inert to be correct.
 *
 * Read-only by design. Branching and deleting already have homes (the message menu, the
 * chat menu), and a map that can also reshape the territory is a destructive flow hiding
 * behind a navigation affordance. The one action here is the jump: `openChat`, which
 * flushes and aborts exactly like every other way of switching transcript.
 *
 * Like "Character card…", this is reachable mid-generation — the timeline is a question
 * you ask *while* a reply is arriving. The individual jumps are not: a switch would
 * silently throw away the reply being written, so they disable with the reason until the
 * generation settles.
 *
 * Everything that decides what appears where lives in `branchTree.ts` (pure, tested); this
 * file only renders it.
 */

import type { ChatSummary } from '@shared/types/chat.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ErrorBoundary } from '../../components/ErrorBoundary.tsx';
import { CloseIcon } from '../../layout/icons.tsx';
import { chatApi } from '../../lib/api.ts';
import { buildBranchTree, NODE_HEIGHT, NODE_WIDTH, placeBranchTimeline } from './branchTree.ts';
import { formatTimestamp } from './formatDate.ts';
import type { UseChat } from './useChat.ts';
import './BranchTree.css';

const BUSY = 'Wait for the current reply to finish.';

interface BranchTreeProps {
  chat: Pick<UseChat, 'state' | 'busy' | 'openChat'>;
  onClose: () => void;
}

type FamilyState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; chats: ChatSummary[] };

export function BranchTree({ chat, onClose }: BranchTreeProps) {
  const { chatId, characterId, title } = chat.state;

  // Captured on mount, while the burger that opened this still holds focus, so closing
  // puts the timeline back where it came from.
  const openerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const overlayRoot = useMemo(() => document.querySelector('[data-overlay-root]'), []);

  const close = useCallback(() => {
    onClose();
    const opener = openerRef.current;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [onClose]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  /*
   * The list is fetched fresh on open rather than trusted from `chat.chats`: that state
   * ages with the session, and a branch made in another tab (or the stale-tab case the
   * revision queue exists for) would be missing from the map exactly when the user is
   * looking for it. The request id is the stale-response guard — a slow reply from before
   * a retry must not overwrite the one the user is waiting for.
   */
  const [family, setFamily] = useState<FamilyState>({ status: 'loading' });
  const requestId = useRef(0);
  const loadFamily = useCallback(() => {
    if (!chatId) return;
    const id = ++requestId.current;
    setFamily({ status: 'loading' });
    chatApi
      .list(characterId ?? undefined)
      .then((chats) => {
        if (requestId.current === id) setFamily({ status: 'ready', chats });
      })
      .catch((error: unknown) => {
        if (requestId.current !== id) return;
        setFamily({
          status: 'error',
          message: error instanceof Error ? error.message : 'The chat list could not be loaded.',
        });
      });
  }, [characterId]);

  useEffect(() => {
    loadFamily();
  }, [loadFamily]);

  /*
   * The canvas coordinates are pixels against the measured viewport, so a panel opening or
   * closing under the overlay re-places the whole timeline. ResizeObserver rather than a
   * window listener for exactly that reason: the column changes width without the window
   * doing anything.
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setViewportWidth(Math.floor(width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const tree = useMemo(
    () =>
      buildBranchTree({
        currentChatId: chatId ?? '',
        chats: family.status === 'ready' ? family.chats : [],
      }),
    [chatId, family],
  );
  const placement = useMemo(
    () => (viewportWidth > 0 ? placeBranchTimeline(tree, viewportWidth) : null),
    [tree, viewportWidth],
  );

  // Hover and focus land on the same strip; without either, it describes this chat.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const detail = tree.nodes.find((node) => node.chat.id === (highlightedId ?? chatId)) ?? null;

  const jump = useCallback(
    (targetId: string) => {
      if (targetId === chatId) return;
      close();
      // openChat flushes saves and aborts any running work itself; a failed flush aborts
      // the switch and the transcript stays put, which is the honest outcome.
      void chat.openChat(targetId);
    },
    [chat, chatId, close],
  );

  // Focus lands on the surface, not a node: the timeline reads top-down before it is
  // clicked through, and Escape has a home from the first frame.
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    surfaceRef.current?.focus({ preventScroll: true });
  }, []);

  if (!overlayRoot) return null;

  const nodeAt = (id: string) => placement?.byId.get(id);

  return createPortal(
    <ErrorBoundary where="the branch timeline" resetKeys={[chatId]}>
      <div
        ref={surfaceRef}
        className="branch-tree"
        role="dialog"
        aria-modal="false"
        aria-label="Branch timeline"
        tabIndex={-1}
      >
        <div className="branch-tree__bar">
          <div className="branch-tree__heading">
            <h2 className="branch-tree__title">Branch timeline</h2>
            <p className="branch-tree__subtitle">{title || 'Chat'}</p>
          </div>
          <button
            type="button"
            className="wc-button wc-button--ghost"
            title="Close (Esc)"
            aria-label="Close the branch timeline"
            onClick={close}
          >
            <CloseIcon />
          </button>
        </div>

        {detail ? (
          <div className="branch-tree__detail">
            <p className="branch-tree__detail-line">
              <strong>{detail.chat.title}</strong>
              {detail.isCurrent ? ' — this chat' : ''}
              {detail.orphaned ? ' — parent chat is gone' : ''}
            </p>
            <p className="branch-tree__detail-meta">
              {formatTimestamp(new Date(detail.chat.created).toISOString())?.short ??
                'unknown date'}{' '}
              · {formatTimestamp(new Date(detail.chat.modified).toISOString())?.short ?? '—'} ·{' '}
              {detail.chat.messageCount} message{detail.chat.messageCount === 1 ? '' : 's'}
            </p>
            {detail.chat.lastMessage ? (
              <p className="branch-tree__detail-preview">{detail.chat.lastMessage}</p>
            ) : null}
          </div>
        ) : null}

        {/*
         * The scroller is always mounted — the ResizeObserver that places the canvas is
         * attached to it, and a ref read once during loading would never see it. The
         * states render inside it; the canvas is the one thing that scrolls.
         */}
        <div className="branch-tree__scroll" ref={scrollRef}>
          {family.status === 'error' ? (
            <div className="branch-tree__state" role="alert">
              <span>{family.message}</span>
              <button type="button" className="wc-button" onClick={loadFamily}>
                Retry
              </button>
            </div>
          ) : family.status === 'loading' || !placement ? (
            <div className="branch-tree__state">
              <span>Loading the branch family…</span>
            </div>
          ) : tree.nodes.length === 0 ? (
            <div className="branch-tree__state">
              <span>This chat is no longer in the library.</span>
            </div>
          ) : (
            <>
              <div
                className="branch-tree__canvas"
                style={{ width: placement.contentWidth, height: placement.contentHeight }}
              >
                <svg
                  className="branch-tree__edges"
                  width={placement.contentWidth}
                  height={placement.contentHeight}
                  viewBox={`0 0 ${placement.contentWidth} ${placement.contentHeight}`}
                  aria-hidden="true"
                  focusable="false"
                >
                  {tree.edges.map((edge) => {
                    const from = nodeAt(edge.parentId);
                    const to = nodeAt(edge.childId);
                    if (!from || !to) return null;
                    const x1 = from.cx + NODE_WIDTH / 2;
                    const x2 = to.cx - NODE_WIDTH / 2;
                    // A horizontal S-curve: reads as a fork at any lane distance, and never
                    // renders the right angle an elbow would put inside a neighbouring node.
                    const bend = Math.min(Math.max((x2 - x1) / 2, 12), 48);
                    return (
                      <path
                        key={`${edge.parentId}->${edge.childId}`}
                        className="branch-tree__edge"
                        d={`M ${x1} ${from.cy} C ${x1 + bend} ${from.cy}, ${x2 - bend} ${to.cy}, ${x2} ${to.cy}`}
                      />
                    );
                  })}
                  {tree.nodes
                    .filter((node) => node.orphaned)
                    .map((node) => {
                      const at = nodeAt(node.chat.id);
                      if (!at) return null;
                      return (
                        <path
                          key={`${node.chat.id}-severed`}
                          className="branch-tree__edge branch-tree__edge--severed"
                          d={`M ${at.cx - NODE_WIDTH / 2 - 36} ${at.cy} H ${at.cx - NODE_WIDTH / 2}`}
                        />
                      );
                    })}
                </svg>

                {tree.nodes.map((node) => {
                  const at = nodeAt(node.chat.id);
                  if (!at) return null;
                  const style = {
                    left: at.cx - NODE_WIDTH / 2,
                    top: at.cy - NODE_HEIGHT / 2,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                  };
                  const meta = `${
                    formatTimestamp(new Date(node.chat.created).toISOString())?.short ?? ''
                  } · ${node.chat.messageCount} message${node.chat.messageCount === 1 ? '' : 's'}`;
                  const highlight = () => setHighlightedId(node.chat.id);
                  const clear = () => setHighlightedId(null);
                  const classes =
                    'branch-tree__node' +
                    (node.isCurrent ? ' branch-tree__node--current' : '') +
                    (node.orphaned ? ' branch-tree__node--orphan' : '');

                  // This chat is where you already are: a marker, not a control.
                  if (node.isCurrent) {
                    return (
                      <div key={node.chat.id} className={classes} style={style} aria-current="true">
                        <span className="branch-tree__node-title">{node.chat.title}</span>
                        <span className="branch-tree__node-meta">You are here · {meta}</span>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={node.chat.id}
                      type="button"
                      className={classes}
                      style={style}
                      // A switch mid-generation would throw away the reply being written.
                      disabled={chat.busy}
                      title={chat.busy ? BUSY : `Open “${node.chat.title}”`}
                      aria-label={`Open “${node.chat.title}”, ${meta}`}
                      onClick={() => jump(node.chat.id)}
                      onFocus={highlight}
                      onBlur={clear}
                      onMouseEnter={highlight}
                      onMouseLeave={clear}
                    >
                      <span className="branch-tree__node-title">{node.chat.title}</span>
                      <span className="branch-tree__node-meta">{meta}</span>
                    </button>
                  );
                })}
              </div>

              {tree.nodes.length === 1 ? (
                <p className="branch-tree__hint">
                  {tree.nodes[0]?.orphaned
                    ? 'The chat this one was branched from is gone from the library.'
                    : 'This chat has no branches yet. Use “Branch from here” on any message — or “Save checkpoint” above — to grow a timeline.'}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </ErrorBoundary>,
    overlayRoot,
  );
}
