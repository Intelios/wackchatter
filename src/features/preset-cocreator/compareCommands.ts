/** The composer owns selection; this parser only recognises text before a source is picked. */
export const PRESET_SLASH_COMMANDS = [
  {
    name: 'compare',
    usage: '/compare <preset>',
    description: 'Ask the Co-Creator to assess your draft against another preset.',
  },
] as const;

export type CompareCommandDraft =
  | { kind: 'message' }
  | { kind: 'command'; completing: boolean }
  | { kind: 'source'; query: string }
  | { kind: 'invalid'; error: string };

export function compareCommandDraft(input: string): CompareCommandDraft {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return { kind: 'message' };
  const match = /^\/([^\s]*)(\s*)([\s\S]*)$/.exec(trimmed);
  const name = match?.[1]?.toLowerCase() ?? '';
  const spacing = match?.[2] ?? '';
  const rest = match?.[3] ?? '';
  if (name === 'compare') {
    return spacing ? { kind: 'source', query: rest } : { kind: 'command', completing: false };
  }
  if (PRESET_SLASH_COMMANDS.some((command) => command.name.startsWith(name)) && !spacing) {
    return { kind: 'command', completing: true };
  }
  return { kind: 'invalid', error: `Unknown command: /${name || '(empty)'}.` };
}
