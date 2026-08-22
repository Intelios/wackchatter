import { describe, expect, test } from 'bun:test';
import type { ChatSummary } from '@shared/types/chat.ts';
import {
  buildBranchTree,
  CANVAS_PADDING,
  NODE_GAP,
  NODE_WIDTH,
  placeBranchTimeline,
} from './branchTree.ts';

let seed = 0;

function summary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  seed += 1;
  return {
    id: `chat-${seed}`,
    characterId: 'a.png',
    title: `Chat ${seed}`,
    created: seed * 1000,
    modified: seed * 1000,
    messageCount: 1,
    lastMessage: 'Hello.',
    ...overrides,
  };
}

/** ids are opaque, so tests name them explicitly and only the timestamps vary. */
function chat(id: string, overrides: Partial<ChatSummary> = {}): ChatSummary {
  return summary({ id, ...overrides });
}

function nodeOf(tree: ReturnType<typeof buildBranchTree>, id: string) {
  const node = tree.nodes.find((n) => n.chat.id === id);
  expect(node).toBeDefined();
  return node!;
}

describe('buildBranchTree', () => {
  test('a chat with no branches is a single-node family', () => {
    const only = chat('a');
    const tree = buildBranchTree({ currentChatId: 'a', chats: [only] });

    expect(tree.nodes).toHaveLength(1);
    expect(tree.edges).toEqual([]);
    expect(tree.laneCount).toBe(1);
    expect(tree.nodes[0]?.isCurrent).toBe(true);
    expect(tree.nodes[0]?.parentId).toBeNull();
    // A lone node centres rather than hugging an edge.
    expect(tree.nodes[0]?.x).toBe(0.5);
  });

  test('the family is only the chats connected to the current one', () => {
    const root = chat('root');
    const branch = chat('b1', { branchedFrom: { chatId: 'root', messageId: 'm' } });
    const otherRoot = chat('other');
    const otherBranch = chat('b2', {
      branchedFrom: { chatId: 'other', messageId: 'm' },
    });

    const tree = buildBranchTree({
      currentChatId: 'b1',
      chats: [root, branch, otherRoot, otherBranch],
    });

    expect(tree.nodes.map((n) => n.chat.id).sort()).toEqual(['b1', 'root']);
    expect(tree.edges).toEqual([{ parentId: 'root', childId: 'b1' }]);
  });

  test('a branch of a branch keeps the whole chain, current at the leaf', () => {
    const a = chat('a', { created: 1000 });
    const b = chat('b', { created: 2000, branchedFrom: { chatId: 'a', messageId: 'm' } });
    const c = chat('c', { created: 3000, branchedFrom: { chatId: 'b', messageId: 'm' } });

    const tree = buildBranchTree({ currentChatId: 'c', chats: [a, b, c] });

    expect(tree.nodes.map((n) => n.chat.id)).toEqual(['a', 'b', 'c']);
    expect(tree.edges).toEqual([
      { parentId: 'a', childId: 'b' },
      { parentId: 'b', childId: 'c' },
    ]);
    // A chain is one lane; the timeline runs left to right in creation order.
    expect(tree.laneCount).toBe(1);
    expect(nodeOf(tree, 'a').x).toBeLessThan(nodeOf(tree, 'b').x);
    expect(nodeOf(tree, 'b').x).toBeLessThan(nodeOf(tree, 'c').x);
    expect(nodeOf(tree, 'c').isCurrent).toBe(true);
  });

  test('siblings fork into their own lanes and the parent sits over the median', () => {
    const a = chat('a', { created: 1000 });
    const b = chat('b', { created: 2000, branchedFrom: { chatId: 'a', messageId: 'm' } });
    const c = chat('c', { created: 3000, branchedFrom: { chatId: 'a', messageId: 'm' } });

    const tree = buildBranchTree({ currentChatId: 'a', chats: [a, b, c] });

    expect(tree.laneCount).toBe(2);
    expect(nodeOf(tree, 'b').lane).not.toBe(nodeOf(tree, 'c').lane);
    // The lower median of two children: the trunk continues into the first fork.
    expect(nodeOf(tree, 'a').lane).toBe(nodeOf(tree, 'b').lane);
    expect(nodeOf(tree, 'a').x).toBeLessThan(nodeOf(tree, 'b').x);
    expect(nodeOf(tree, 'a').x).toBeLessThan(nodeOf(tree, 'c').x);
  });

  test('an imported chat with a timestamp before its parent still draws right of it', () => {
    const a = chat('a', { created: 5000 });
    const b = chat('b', { created: 1000, branchedFrom: { chatId: 'a', messageId: 'm' } });

    const tree = buildBranchTree({ currentChatId: 'a', chats: [a, b] });

    expect(nodeOf(tree, 'a').x).toBeLessThan(nodeOf(tree, 'b').x);
  });

  test('equal timestamps spread by a minimum step rather than stacking', () => {
    const a = chat('a', { created: 1000 });
    const b = chat('b', { created: 1000, branchedFrom: { chatId: 'a', messageId: 'm' } });
    const c = chat('c', { created: 1000, branchedFrom: { chatId: 'b', messageId: 'm' } });

    const tree = buildBranchTree({ currentChatId: 'c', chats: [a, b, c] });

    expect(nodeOf(tree, 'a').x).toBeLessThan(nodeOf(tree, 'b').x);
    expect(nodeOf(tree, 'b').x).toBeLessThan(nodeOf(tree, 'c').x);
  });

  test('siblings with equal timestamps order by id for determinism', () => {
    const a = chat('a', { created: 1000 });
    const late = chat('z-late', { created: 2000, branchedFrom: { chatId: 'a', messageId: 'm' } });
    const early = chat('b-early', { created: 2000, branchedFrom: { chatId: 'a', messageId: 'm' } });

    const tree = buildBranchTree({ currentChatId: 'a', chats: [a, late, early] });

    expect(nodeOf(tree, 'b-early').lane).toBe(0);
    expect(nodeOf(tree, 'z-late').lane).toBe(1);
  });

  test('a parent deleted from the library severs the chain without losing the chat', () => {
    const orphan = chat('orphan', {
      branchedFrom: { chatId: 'ghost', messageId: 'm' },
    });
    const unrelated = chat('unrelated');

    const tree = buildBranchTree({ currentChatId: 'orphan', chats: [orphan, unrelated] });

    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]?.orphaned).toBe(true);
    expect(tree.edges).toEqual([]);
  });

  test('a parent chain that loops breaks at the earliest chat', () => {
    // Malformed imported metadata: neither chat has a parent-free ancestor.
    const a = chat('a', { created: 1000, branchedFrom: { chatId: 'b', messageId: 'm' } });
    const b = chat('b', { created: 2000, branchedFrom: { chatId: 'a', messageId: 'm' } });

    const tree = buildBranchTree({ currentChatId: 'a', chats: [a, b] });

    expect(tree.nodes.map((n) => n.chat.id)).toEqual(['a', 'b']);
    expect(nodeOf(tree, 'a').parentId).toBeNull();
    expect(nodeOf(tree, 'b').parentId).toBe('a');
    expect(nodeOf(tree, 'a').x).toBeLessThan(nodeOf(tree, 'b').x);
  });

  test('an unknown current chat yields an empty tree rather than throwing', () => {
    const tree = buildBranchTree({ currentChatId: 'nope', chats: [chat('a')] });
    expect(tree.nodes).toEqual([]);
    expect(tree.edges).toEqual([]);
    expect(tree.laneCount).toBe(0);
  });

  test('identical input produces identical output', () => {
    const root = chat('root');
    const one = chat('one', { branchedFrom: { chatId: 'root', messageId: 'm' } });
    const two = chat('two', { branchedFrom: { chatId: 'root', messageId: 'm' } });
    const input = { currentChatId: 'root', chats: [two, root, one] };

    expect(buildBranchTree(input)).toEqual(buildBranchTree(input));
  });
});

describe('placeBranchTimeline', () => {
  function forkedTree() {
    const root = chat('root', { created: 1000 });
    const trunk = chat('trunk', {
      created: 2000,
      branchedFrom: { chatId: 'root', messageId: 'm' },
    });
    const fork = chat('fork', { created: 3000, branchedFrom: { chatId: 'trunk', messageId: 'm' } });
    return buildBranchTree({ currentChatId: 'root', chats: [root, trunk, fork] });
  }

  test('nodes never overlap on a lane, whatever the timestamps did', () => {
    // One millisecond apart: timestamp spacing is sub-pixel, so only the collision pass
    // keeps the trunk and its first child apart.
    const root = chat('root', { created: 1000 });
    const child = chat('child', {
      created: 1001,
      branchedFrom: { chatId: 'root', messageId: 'm' },
    });
    const tree = buildBranchTree({ currentChatId: 'root', chats: [root, child] });

    const placement = placeBranchTimeline(tree, 800);
    const rootAt = placement.byId.get('root')!;
    const childAt = placement.byId.get('child')!;

    expect(childAt.cx).toBeGreaterThanOrEqual(rootAt.cx + NODE_WIDTH + NODE_GAP);
    // y centres track the lane: a chain is one row.
    expect(childAt.cy).toBe(rootAt.cy);
  });

  test('nodes on different lanes do not push each other', () => {
    const placement = placeBranchTimeline(forkedTree(), 800);
    const fork = placement.byId.get('fork')!;

    // The fork is on its own lane; nothing on the trunk lane pushed it.
    expect(fork.cx).toBeGreaterThanOrEqual(CANVAS_PADDING + NODE_WIDTH / 2);
  });

  test('the canvas is at least the viewport wide, and reports what it needs', () => {
    const tree = forkedTree();
    expect(placeBranchTimeline(tree, 800).contentWidth).toBe(800);

    // A narrow viewport must widen the canvas rather than crush the timeline.
    expect(placeBranchTimeline(tree, 240).contentWidth).toBeGreaterThan(240);
  });

  test('an empty tree places nothing', () => {
    const placement = placeBranchTimeline(
      buildBranchTree({ currentChatId: 'nope', chats: [] }),
      800,
    );
    expect(placement.byId.size).toBe(0);
    expect(placement.contentWidth).toBe(800);
  });
});
