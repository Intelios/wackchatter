export interface DialogueRange {
  start: number;
  /** Exclusive. */
  end: number;
}

export interface DialogueSegment {
  text: string;
  dialogue: boolean;
}

/**
 * Locate completed English double-quote pairs without crossing a line or a masked span.
 * The punctuation belongs to the range: colouring just the words leaves the quote marks
 * looking detached from the dialogue they delimit.
 */
export function dialogueRanges(text: string, eligible?: readonly boolean[]): DialogueRange[] {
  const ranges: DialogueRange[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const open = text[index];
    if (open === '\n' || open === '\r' || eligible?.[index] === false) continue;
    const close = open === '"' ? '"' : open === '“' ? '”' : null;
    if (!close) continue;

    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (char === '\n' || char === '\r') break;
      if (eligible?.[cursor] === false) break;
      if (char !== close) continue;

      ranges.push({ start: index, end: cursor + 1 });
      index = cursor;
      break;
    }
  }

  return ranges;
}

/** Mark Markdown code spans as ineligible without parsing the rest of Markdown. */
function markdownEligibility(text: string): boolean[] {
  const eligible = Array.from({ length: text.length }, () => true);
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (const lineWithBreak of text.match(/.*(?:\r\n|\n|\r|$)/g) ?? []) {
    if (!lineWithBreak) continue;
    const line = lineWithBreak.replace(/(?:\r\n|\n|\r)$/, '');
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);

    if (fence) {
      eligible.fill(false, offset, offset + lineWithBreak.length);
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.marker &&
        fenceMatch[1]!.length >= fence.length
      ) {
        fence = null;
      }
      offset += lineWithBreak.length;
      continue;
    }

    if (fenceMatch) {
      const run = fenceMatch[1]!;
      fence = { marker: run[0] as '`' | '~', length: run.length };
      eligible.fill(false, offset, offset + lineWithBreak.length);
      offset += lineWithBreak.length;
      continue;
    }

    let cursor = 0;
    while (cursor < line.length) {
      if (line[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      let runEnd = cursor + 1;
      while (line[runEnd] === '`') runEnd += 1;
      const marker = line.slice(cursor, runEnd);
      const close = line.indexOf(marker, runEnd);
      if (close < 0) {
        cursor = runEnd;
        continue;
      }
      eligible.fill(false, offset + cursor, offset + close + marker.length);
      cursor = close + marker.length;
    }

    offset += lineWithBreak.length;
  }

  return eligible;
}

export function dialogueSegments(markdown: string): DialogueSegment[] {
  if (!markdown) return [];
  const ranges = dialogueRanges(markdown, markdownEligibility(markdown));
  if (ranges.length === 0) return [{ text: markdown, dialogue: false }];

  const segments: DialogueSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ text: markdown.slice(cursor, range.start), dialogue: false });
    }
    segments.push({ text: markdown.slice(range.start, range.end), dialogue: true });
    cursor = range.end;
  }
  if (cursor < markdown.length) {
    segments.push({ text: markdown.slice(cursor), dialogue: false });
  }
  return segments;
}

interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

interface HastRoot {
  type: 'root';
  children: HastNode[];
}

type HastNode = HastText | HastElement | HastRoot | { type: string; [key: string]: unknown };

interface TextRef {
  node: HastText;
  parent: HastElement | HastRoot;
  start: number;
  end: number;
}

const TEXT_CONTAINERS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th']);

function isElement(node: HastNode): node is HastElement {
  return node.type === 'element' && typeof (node as HastElement).tagName === 'string';
}

function collectTextGroups(container: HastElement): TextRef[][] {
  const groups: TextRef[][] = [];
  let current: TextRef[] = [];
  let offset = 0;

  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
    offset = 0;
  };

  const visit = (node: HastNode, parent: HastElement | HastRoot) => {
    if (node.type === 'text') {
      const text = node as HastText;
      current.push({ node: text, parent, start: offset, end: offset + text.value.length });
      offset += text.value.length;
      return;
    }
    if (!isElement(node)) return;
    if (node.tagName === 'code' || node.tagName === 'pre' || node.tagName === 'br') {
      flush();
      return;
    }
    for (const child of node.children) visit(child, node);
  };

  for (const child of container.children) visit(child, container);
  flush();
  return groups;
}

function wrapTextRef(ref: TextRef, ranges: DialogueRange[]): HastNode[] {
  const intersections = ranges
    .map((range) => ({
      start: Math.max(range.start, ref.start),
      end: Math.min(range.end, ref.end),
    }))
    .filter((range) => range.start < range.end);
  if (intersections.length === 0) return [ref.node];

  const children: HastNode[] = [];
  let cursor = ref.start;
  for (const range of intersections) {
    if (range.start > cursor) {
      children.push({
        type: 'text',
        value: ref.node.value.slice(cursor - ref.start, range.start - ref.start),
      });
    }
    children.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['message__dialogue'] },
      children: [
        {
          type: 'text',
          value: ref.node.value.slice(range.start - ref.start, range.end - ref.start),
        },
      ],
    });
    cursor = range.end;
  }
  if (cursor < ref.end) {
    children.push({ type: 'text', value: ref.node.value.slice(cursor - ref.start) });
  }
  return children;
}

function transformContainer(container: HastElement): void {
  for (const group of collectTextGroups(container)) {
    const text = group.map((ref) => ref.node.value).join('');
    const ranges = dialogueRanges(text);
    if (ranges.length === 0) continue;

    const byParent = new Map<HastElement | HastRoot, TextRef[]>();
    for (const ref of group) {
      const refs = byParent.get(ref.parent) ?? [];
      refs.push(ref);
      byParent.set(ref.parent, refs);
    }
    for (const [parent, refs] of byParent) {
      for (const ref of refs.reverse()) {
        const index = parent.children.indexOf(ref.node);
        if (index >= 0) parent.children.splice(index, 1, ...wrapTextRef(ref, ranges));
      }
    }
  }
}

/** Rehype plugin used by ReactMarkdown. Raw HTML remains disabled as before. */
export function rehypeDialogue() {
  return (tree: HastRoot) => {
    const visit = (node: HastNode) => {
      if (!isElement(node)) {
        if (node.type === 'root') for (const child of (node as HastRoot).children) visit(child);
        return;
      }
      if (TEXT_CONTAINERS.has(node.tagName)) {
        transformContainer(node);
        return;
      }
      for (const child of node.children) visit(child);
    };
    visit(tree);
  };
}
