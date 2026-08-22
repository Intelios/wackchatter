/**
 * Example cues for the Arena's cue pool.
 *
 * Every cue is open-ended on purpose. A benchmark cue exists to make models answer at
 * length — a yes/no question measures nothing, and a cue that dictates the reply measures
 * the cue, not the model. Each one invites a substantive answer where quality is actually
 * visible: how a character opens, how they hold up under pressure, whether they can be
 * tender or inventive or hold a constraint without dropping the fiction.
 *
 * They are grouped by what the group separates models on, because that is the question you
 * are asking when you pick one: not "what do I say" but "what am I testing".
 *
 * Format follows the convention the cards themselves are written in: action in asterisks,
 * speech in double quotes. The quotes are load-bearing — unquoted speech reads as
 * narration, and the model answers a different cue than the one written, which is not the
 * model's fault but still ends up in the ratings. Pinned by test, like everything else
 * here.
 *
 * Like the starter suggestions before them, these are offered, never bundled — a click
 * inserts the text as the user's own cue, and the default really is an empty list. Macros
 * are limited to `{{char}}` and `{{user}}` (pinned by test): a shipped example carrying a
 * macro the assembler does not expand would silently benchmark a broken prompt, and these
 * are drawn against forty different cards — a macro is the only thing that makes one cue
 * fit all of them.
 */

export interface ExampleCueGroup {
  /** Stable id for React keys — the label is display text and free to change. */
  id: string;
  label: string;
  /** One line on what the group separates models on. */
  note: string;
  cues: string[];
}

export const EXAMPLE_CUE_GROUPS: readonly ExampleCueGroup[] = [
  {
    id: 'open',
    label: 'Open a scene',
    note: 'Works cold, against any card — the first move is all theirs.',
    cues: [
      '*I step through the door and stop.* "So you’re the one they warned me about."',
      '*I say nothing, and wait for {{char}} to break the silence.*',
      '"You have my full attention. Start wherever you like."',
      '*I take the seat across from {{char}} and wait.* "Well? Make the first move."',
    ],
  },
  {
    id: 'press',
    label: 'Press them',
    note: 'Pressure and subtext — whether a model holds the character or folds into politeness.',
    cues: [
      '"Tell me what you actually want. No hedging."',
      '"Something is wrong here. What are you not telling me?"',
      '"I don’t believe you. Try again — this time, the truth."',
      '"That’s not an answer. What are you afraid of?"',
    ],
  },
  {
    id: 'range',
    label: 'Emotional range',
    note: 'Tenderness and vulnerability — nuance separates models more than vocabulary does.',
    cues: [
      '*I sit down beside {{char}} and let the quiet stretch, shoulders almost touching.*',
      '"Tell me about the last time you were properly happy."',
      '"You can drop the act with me. I’m not going anywhere."',
    ],
  },
  {
    id: 'invent',
    label: 'Invention',
    note: 'Worldbuilding on demand — a weak model answers, a strong one shows you something.',
    cues: [
      '"Describe this place to someone who has never seen anything like it."',
      '"Tell me a story your people tell about the stars."',
      '"Show me something impossible, and make me believe it."',
    ],
  },
  {
    id: 'constraint',
    label: 'Hold a constraint',
    note: 'Instruction-following inside the fiction — keeping the constraint is the test.',
    cues: [
      '"Tell me what you want in exactly three sentences. No more, no fewer."',
      '"Describe this room through sound alone."',
      '"Would you rather be feared or loved? Answer twice — once as a performance, once honestly."',
    ],
  },
];
