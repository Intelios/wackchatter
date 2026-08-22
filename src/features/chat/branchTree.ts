/**
 * The branch family as geometry: which chats belong on the timeline, and where.
 *
 * Pure and separately tested, like buildChatMenu and buildCharacterTree: there is no DOM
 * test harness in this project, so the rules live here and the React component stays a
 * renderer. Everything that decides what appears where — what "the family" is, how forks
 * pick lanes, when the timeline is allowed to lie — is in this file.
 *
 * The family is the connected component of the current chat over `branchedFrom` links,
 * not "every chat with this character": two unrelated stories with the same card have
 * nothing to say about each other on one timeline. `branchedFrom` names the immediate
 * parent only (there is no stored root), so the component is walked over both directions
 * of the link — a chat is family whether it is an ancestor or a descendant.
 *
 * Tolerance rules, both pinned by tests:
 * - A `branchedFrom` whose chat is gone (deleted, or metadata imported from elsewhere)
 *   severs the chain: the chat stays, marked `orphaned`, as its own root. Provenance is
 *   not a foreign key.
 * - A parent chain that loops (only possible through hand-edited imports) breaks at the
 *   earliest-created chat in the loop, so the output is always a forest, never a cycle.
 *
 * Geometry: `x` is a 0..1 time fraction from `created`, EXCEPT that a child is never drawn
 * left of its parent — an imported chat whose timestamp precedes its parent's is nudged
 * right by a minimum step. The timeline may lie slightly about *when*; it never draws an
 * edge pointing backwards. Lanes are allocated to leaves in traversal order and a parent
 * takes the lower median of its children's lanes, so the trunk continues into its first
 * fork and every leaf owns a lane.
 */

import type { ChatSummary } from '@shared/types/chat.ts';

export interface BranchTimelineNode {
  chat: ChatSummary;
  /** 0..1 across the timeline; a parent is always strictly left of its children. */
  x: number;
  /** 0-based vertical lane; `laneCount` is the family's lane total. */
  lane: number;
  isCurrent: boolean;
  /** Family parent, or null for a root. */
  parentId: string | null;
  /** The recorded parent is not in the library: the link is severed, the chat is a root. */
  orphaned: boolean;
}

export interface BranchTimelineEdge {
  parentId: string;
  childId: string;
}

export interface BranchTimeline {
  nodes: BranchTimelineNode[];
  edges: BranchTimelineEdge[];
  /** Max lane + 1; how many rows tall the timeline is. */
  laneCount: number;
}

/** How far a child is pushed right of its parent when timestamps do not order them. */
const MIN_STEP = 0.02;

/*
 * Rendered geometry. The module owns these so the placement pass, the SVG edges and the
 * node buttons can never disagree about how much room a node takes.
 */
export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 56;
export const LANE_HEIGHT = 84;
/** Horizontal room between two nodes that share a lane. */
export const NODE_GAP = 24;
/** Blank canvas margin at every edge. */
export const CANVAS_PADDING = 24;

export function buildBranchTree({
  currentChatId,
  chats,
}: {
  currentChatId: string;
  chats: readonly ChatSummary[];
}): BranchTimeline {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  if (!byId.has(currentChatId)) {
    return { nodes: [], edges: [], laneCount: 0 };
  }

  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const orphanedIds = new Set<string>();
  for (const chat of chats) {
    const parentId = chat.branchedFrom?.chatId;
    if (!parentId) continue;
    if (byId.has(parentId)) {
      parentOf.set(chat.id, parentId);
      childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), chat.id]);
    } else {
      orphanedIds.add(chat.id);
    }
  }

  // The family: everything reachable from the current chat, parents and children both.
  const family = new Set<string>([currentChatId]);
  const queue = [currentChatId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const parent = parentOf.get(id);
    if (parent !== undefined && !family.has(parent)) {
      family.add(parent);
      queue.push(parent);
    }
    for (const child of childrenOf.get(id) ?? []) {
      if (!family.has(child)) {
        family.add(child);
        queue.push(child);
      }
    }
  }

  const byOrder = (a: string, b: string): number => {
    const ca = byId.get(a)!;
    const cb = byId.get(b)!;
    return ca.created - cb.created || (ca.id < cb.id ? -1 : ca.id > cb.id ? 1 : 0);
  };

  const childLists = new Map<string, string[]>();
  for (const [parent, kids] of childrenOf) {
    const inFamily = kids.filter((id) => family.has(id)).sort(byOrder);
    if (inFamily.length > 0) childLists.set(parent, inFamily);
  }

  /*
   * Roots and cycle islands. Natural roots are family members with no parent link; every
   * family is closed under that link, so an unreached chat after walking from the roots can
   * only be part of a parent loop. Breaking at the loop's earliest chat is deterministic
   * and keeps the drawing a forest.
   */
  const order = [...family].sort(byOrder);
  const rootIds: string[] = [];
  const reached = new Set<string>();
  const markFrom = (root: string): void => {
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const child of childLists.get(id) ?? []) stack.push(child);
    }
  };
  for (const id of order) {
    if (parentOf.has(id) || reached.has(id)) continue;
    rootIds.push(id);
    markFrom(id);
  }
  for (const id of order) {
    if (reached.has(id)) continue;
    // Sever this chat from its parent: the edge that closes the loop is the one not drawn.
    const parent = parentOf.get(id);
    if (parent !== undefined) {
      parentOf.delete(id);
      childLists.set(
        parent,
        (childLists.get(parent) ?? []).filter((child) => child !== id),
      );
    }
    rootIds.push(id);
    markFrom(id);
  }

  const times = order.map((id) => byId.get(id)!.created);
  const first = Math.min(...times);
  const last = Math.max(...times);
  const rawX = (id: string): number =>
    last > first ? (byId.get(id)!.created - first) / (last - first) : 0.5;

  const lanes = new Map<string, number>();
  const xs = new Map<string, number>();
  const visitOrder: string[] = [];
  let nextLane = 0;

  const assign = (id: string, parentX: number | null): void => {
    visitOrder.push(id);
    xs.set(id, parentX === null ? rawX(id) : Math.max(rawX(id), parentX + MIN_STEP));
    const kids = childLists.get(id) ?? [];
    if (kids.length === 0) {
      lanes.set(id, nextLane);
      nextLane += 1;
      return;
    }
    for (const child of kids) assign(child, xs.get(id)!);
    const kidLanes = kids.map((kid) => lanes.get(kid)!);
    lanes.set(id, kidLanes[Math.floor((kidLanes.length - 1) / 2)]!);
  };
  for (const root of rootIds) assign(root, null);

  // Clamping can push past 1; compress the whole axis rather than clipping the newest.
  const maxX = Math.max(...xs.values());
  if (maxX > 1) {
    for (const [id, x] of xs) xs.set(id, x / maxX);
  }

  const nodes: BranchTimelineNode[] = visitOrder.map((id) => ({
    chat: byId.get(id)!,
    x: xs.get(id)!,
    lane: lanes.get(id)!,
    isCurrent: id === currentChatId,
    parentId: parentOf.get(id) ?? null,
    orphaned: orphanedIds.has(id),
  }));
  const edges: BranchTimelineEdge[] = visitOrder
    .map((id) => (parentOf.has(id) ? { parentId: parentOf.get(id)!, childId: id } : null))
    .filter((edge): edge is BranchTimelineEdge => edge !== null);

  return { nodes, edges, laneCount: family.size > 0 ? nextLane : 0 };
}

export interface NodePlacement {
  /** Centre of the node, px from the canvas's left edge. */
  cx: number;
  /** Centre of the node, px from the canvas's top edge. */
  cy: number;
}

export interface BranchPlacement {
  byId: Map<string, NodePlacement>;
  /** The canvas's own size: at least the viewport width, wider when nodes demand it. */
  contentWidth: number;
  contentHeight: number;
}

/**
 * Timeline fractions to pixels.
 *
 * Timestamps space the nodes, but two chats can be close enough in time — or tied, which
 * the clamping above deliberately produces — that their buttons would overlap on a lane.
 * Each lane is walked left to right and any node that would collide with its predecessor
 * is pushed just clear of it, which is also what widens `contentWidth` past the viewport:
 * the canvas grows rather than compressing the timeline below one node-plus-gap per lane.
 *
 * A parent and its first child often share a lane (the trunk continues into the fork), so
 * this pass is what actually enforces "strictly right of the parent" on screen, whatever
 * the timestamps did.
 */
export function placeBranchTimeline(tree: BranchTimeline, viewportWidth: number): BranchPlacement {
  const usable = Math.max(viewportWidth - 2 * CANVAS_PADDING, NODE_WIDTH);
  const byId = new Map<string, NodePlacement>();
  const laneRight = new Map<number, number>();

  const ordered = [...tree.nodes].sort(
    (a, b) => a.x - b.x || (a.chat.id < b.chat.id ? -1 : a.chat.id > b.chat.id ? 1 : 0),
  );
  for (const node of ordered) {
    const base = CANVAS_PADDING + NODE_WIDTH / 2 + node.x * (usable - NODE_WIDTH);
    const predecessor = laneRight.get(node.lane);
    const cx =
      predecessor === undefined ? base : Math.max(base, predecessor + NODE_GAP + NODE_WIDTH / 2);
    laneRight.set(node.lane, cx + NODE_WIDTH / 2);
    byId.set(node.chat.id, {
      cx,
      cy: CANVAS_PADDING + node.lane * LANE_HEIGHT + NODE_HEIGHT / 2,
    });
  }

  let contentWidth = viewportWidth;
  for (const right of laneRight.values()) {
    contentWidth = Math.max(contentWidth, right + CANVAS_PADDING);
  }
  const contentHeight =
    tree.laneCount * LANE_HEIGHT + 2 * CANVAS_PADDING - (LANE_HEIGHT - NODE_HEIGHT);

  return { byId, contentWidth, contentHeight };
}
