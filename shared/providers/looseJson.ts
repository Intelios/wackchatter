/**
 * Reading a JSON object out of a model's reply.
 *
 * Lives beside the SSE parser rather than with prompt assembly: this is the reading half of
 * talking to a provider, and it is shared by every feature that asks a model for structured
 * output (`shared/memory/extract.ts`, `shared/persona/derive.ts`). One copy on purpose — the
 * trailing-comma retry below is exactly the quirk someone would "fix" in one copy and not
 * the other, and the resulting divergence would only show up on whichever model happens to
 * emit trailing commas.
 */

/**
 * Reasoning leaked into the reply as a `<think>` block. Stripped before any JSON is read:
 * a thought that muses with example shapes would otherwise splice itself into the span
 * between the first `{` and the last `}`, and the whole reply would parse as nothing.
 */
const THINK_BLOCK = /<think(?:ing)?\s*>[\s\S]*?<\/think(?:ing)?>/gi;

/**
 * A function rather than the regex itself so the `g` flag can never bite a future caller —
 * a global regex is stateful under `.test()`, stateless under `.replace()`.
 */
export function stripThinkBlocks(text: string): string {
  return text.replace(THINK_BLOCK, ' ');
}

/**
 * Pull a JSON object out of a reply that may be fenced, prefaced, or trailing-comma'd.
 *
 * Roleplay-tuned models wrap JSON in prose and fences routinely; treating that as a hard
 * failure would make these features unusable on exactly the models people run them with.
 */
export function looseParseJson(text: string): unknown {
  // Think blocks go first: a fence quoted inside a thought must not be mistaken for the
  // reply's own opening fence.
  const unfenced = stripThinkBlocks(text)
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const slice = unfenced.slice(start, end + 1);

  try {
    return JSON.parse(slice);
  } catch {
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}
