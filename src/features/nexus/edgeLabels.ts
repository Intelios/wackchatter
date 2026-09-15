import type { NexusGraphEdge } from './graph.ts';

interface Point {
  x: number;
  y: number;
}
interface Box extends Point {
  width: number;
  height: number;
}
export interface EdgeLabel extends Box {
  id: string;
  lines: string[];
  anchor: Point;
}
export function overlaps(a: Box, b: Box) {
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 8 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 + 8
  );
}

/** Deterministic map-space placement: panning and zooming never reshuffle labels. */
export function layoutEdgeLabels(
  edges: readonly NexusGraphEdge[],
  nodes: readonly (Point & { id: string; name: string })[],
  measure: (text: string) => number,
): EdgeLabel[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const occupied: Box[] = nodes.flatMap((n) => [
    { x: n.x, y: n.y, width: 58, height: 58 },
    { x: n.x, y: n.y + 40, width: (measure(n.name) * 13) / 11 + 12, height: 20 },
  ]);
  return [...edges]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((edge) => {
      const a = byId.get(edge.from),
        b = byId.get(edge.to);
      if (!a || !b) return [];
      const lines: string[] = [];
      let line = '';
      for (const word of edge.label.split(/\s+/)) {
        if (line && measure(`${line} ${word}`) > 150) {
          lines.push(line);
          line = '';
        }
        if (line) line += ' ';
        // Only split inside a word when that word alone exceeds the line width.
        for (const char of word) {
          if (measure(line + char) > 150 && line) {
            lines.push(line);
            line = '';
          }
          line += char;
        }
      }
      if (line.trim()) lines.push(line.trim());
      const width = Math.max(24, ...lines.map(measure)) + 16;
      const height = Math.max(1, lines.length) * 14 + 10;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        len = Math.hypot(dx, dy) || 1;
      let best: EdgeLabel | undefined;
      let score = Infinity;
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const anchor = { x: a.x + dx * t, y: a.y + dy * t };
        for (let step = 0; step < 16; step++) {
          for (const side of [-1, 1]) {
            const offset = side * (18 + step * 18);
            const box = {
              x: anchor.x - (dy / len) * offset,
              y: anchor.y + (dx / len) * offset,
              width,
              height,
            };
            const cost = Math.abs(offset) + Math.abs(t - 0.5) * len * 0.5;
            if (cost >= score || occupied.some((other) => overlaps(box, other))) continue;
            best = { ...box, id: edge.id, lines, anchor };
            score = cost;
          }
        }
      }
      if (!best) {
        // Dense or duplicate relationships still get their own readable label.
        const anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const y =
          Math.max(...occupied.map((box) => box.y + box.height / 2), anchor.y) + height / 2 + 12;
        best = { ...anchor, y, width, height, id: edge.id, lines, anchor };
      }
      occupied.push(best);
      return [best];
    });
}
