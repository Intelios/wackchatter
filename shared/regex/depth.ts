/**
 * Depth for regex scripts: how far a message sits from the end of the transcript.
 *
 * One helper rather than a calculation at each call site, because the prompt path and the
 * display path have to agree about what "depth 2" means or a script tuned in the editor
 * would hide a different message than it strips from the prompt.
 */

/** The parts of a message that decide whether it occupies a depth slot. */
export interface DepthCandidate {
  id: string;
  is_system: boolean;
  mes: string;
}

export interface DepthOptions {
  /**
   * A continuation: the model is extending the last message rather than writing a new one,
   * so that message sits past the end at depth -1 and everything else shifts with it.
   * ST's `coreChat.length - index - (isContinue ? 2 : 1)` says the same thing.
   *
   * This is what makes `minDepth: -1` meaningful — it is the only way to write a script
   * that reaches the text being continued.
   */
  continued?: boolean;
}

/**
 * Depth per message id. 0 is the newest message; a message with no slot is absent.
 *
 * Two kinds of message hold no slot:
 *
 *  - **Blank.** A generation appends an empty assistant message before assembling, and
 *    letting the placeholder hold depth 0 would push every real message one deeper than
 *    SillyTavern puts it — so a script shared between the two apps would target the wrong
 *    turn. Same rule, same reason, as `scanLines` in shared/worldinfo/scan.ts.
 *  - **Hidden** (`is_system`). They are not in the prompt, and ST's display path counts
 *    only non-system messages too.
 *
 * Absent from the map means `depth: undefined` at the call site, which skips depth gating
 * entirely — ST's behaviour when its own lookup misses.
 */
export function regexDepths(
  messages: readonly DepthCandidate[],
  options: DepthOptions = {},
): Map<string, number> {
  const depths = new Map<string, number>();
  let depth = options.continued ? -1 : 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.is_system || !message.mes.trim()) continue;
    depths.set(message.id, depth);
    depth += 1;
  }

  return depths;
}
