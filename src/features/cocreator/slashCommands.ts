export type CocreatorInput =
  | { type: 'message'; text: string }
  | { type: 'openSide' }
  | { type: 'sendSide'; text: string }
  | { type: 'error'; message: string };

/** Parse before a main turn can be appended. Unknown command-shaped input stays a draft. */
export function parseCocreatorInput(draft: string): CocreatorInput {
  const text = draft.trim();
  if (!text.startsWith('/')) return { type: 'message', text };
  const match = /^\/side(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match)
    return { type: 'error', message: 'Unknown Co-Creator command. Use /side or /side <question>.' };
  return match[1]?.trim() ? { type: 'sendSide', text: match[1].trim() } : { type: 'openSide' };
}
