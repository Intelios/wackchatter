import { describe, expect, it } from 'bun:test';
import { LEFT_PANELS, RIGHT_PANELS } from './panels.tsx';

describe('RIGHT_PANELS', () => {
  it('does not contain a standalone groups button', () => {
    const ids = RIGHT_PANELS.map((p) => p.id);
    expect(ids).toContain('characters');
    expect(ids).not.toContain('groups');
  });

  it('contains characters, lorebooks, summary, persona, and settings', () => {
    const ids = RIGHT_PANELS.map((p) => p.id);
    expect(ids).toEqual(['characters', 'lorebooks', 'summary', 'persona', 'settings']);
  });
});

describe('LEFT_PANELS', () => {
  it('contains connection, prompts, generation, and inspect', () => {
    const ids = LEFT_PANELS.map((p) => p.id);
    expect(ids).toEqual(['connection', 'prompts', 'generation', 'inspect']);
  });
});
