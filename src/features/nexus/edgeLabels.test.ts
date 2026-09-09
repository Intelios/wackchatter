import { expect, test } from 'bun:test';
import { layoutEdgeLabels, overlaps } from './edgeLabels.ts';

const measure = (text: string) => text.length * 6;
const nodes = [
  { id: 'm', name: 'Mika Asagiri', x: 500, y: 350 },
  { id: 'e', name: 'Emily', x: 510, y: 215 },
  { id: 't', name: 'Talia', x: 660, y: 230 },
  { id: 'j', name: 'Jessica', x: 590, y: 500 },
];
const edges = ['e', 't', 'j'].flatMap((to) =>
  Array.from({ length: 4 }, (_, i) => ({
    id: `${to}${i}`,
    from: 'm',
    to,
    label: i ? 'is sorority sister of' : 'is member of a very long named organisation',
  })),
);
test('dense and parallel connections retain every label without overlapping labels or nodes', () => {
  const labels = layoutEdgeLabels(edges, nodes, measure);
  expect(labels).toHaveLength(edges.length);
  for (const [i, label] of labels.entries()) {
    expect(label.lines.join(' ')).toBe(edges.find((e) => e.id === label.id)!.label);
    for (const other of labels.slice(i + 1)) expect(overlaps(label, other)).toBe(false);
    for (const node of nodes) {
      expect(overlaps(label, { ...node, width: 58, height: 58 })).toBe(false);
      expect(
        overlaps(label, {
          x: node.x,
          y: node.y + 40,
          width: (measure(node.name) * 13) / 11 + 12,
          height: 20,
        }),
      ).toBe(false);
    }
  }
});
test('edge iteration order does not reshuffle captions', () => {
  expect(layoutEdgeLabels([...edges].reverse(), nodes, measure)).toEqual(
    layoutEdgeLabels(edges, nodes, measure),
  );
});
test('unbroken long labels retain their characters and stay within the width budget', () => {
  const text = 'x'.repeat(100);
  const [label] = layoutEdgeLabels(
    [{ id: 'long', from: 'm', to: 'e', label: text }],
    nodes,
    measure,
  );
  expect(label!.lines.join('')).toBe(text);
  expect(label!.width).toBeLessThanOrEqual(166);
});
