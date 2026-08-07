/**
 * Regex script types, SillyTavern's format.
 *
 * A regex script rewrites message text on the way to the screen, on the way to the model,
 * or both — independently. The canonical use is a bookkeeping tag the model writes to keep
 * itself on track that the reader never sees.
 *
 * Which of those a script does is declared by two badly-named booleans, and the pair is the
 * whole feature. Reading them as "only" flags is the trap; they are really "runs during":
 *
 *   markdownOnly | promptOnly | display | prompt | stored | meaning
 *   -------------|------------|---------|--------|--------|---------------------------------
 *   true         | false      |    Y    |   -    |   -    | hidden from the reader, still sent
 *   false        | true       |    -    |   Y    |   -    | visible to the reader, not sent
 *   true         | true       |    Y    |   Y    |   -    | both, ephemerally
 *   false        | false      |    -    |   -    |   Y    | ST's destructive default
 *
 * The last row rewrites ST's chat file irreversibly. We have no storage-path call site, so
 * such a script is inert here — by construction, not by a special case. It still round-trips
 * byte-identically, because silently reinterpreting somebody's file is worse than not
 * running it. `runOnEdit` gated only that path, so it is preserved and never read.
 *
 * The field names are ST's and are the on-disk format. The UI is free to present them
 * better (it does — see the "Affects" control) but must store this shape.
 */

/**
 * ST's `regex_placement` (engine.js:281). These values are the wire format; never renumber.
 *
 * `SLASH_COMMAND` has nothing to hook here — our slash commands are hide/unhide/jump/reload
 * and none of them produce a message. `WORLD_INFO` is not wired yet. Both are still listed,
 * because a script carrying one must survive a round-trip and simply never fire.
 */
export const REGEX_PLACEMENT = {
  /** Deprecated in ST itself. Never produced by our UI, preserved on import. */
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  // 4 was `sendAs`. Absent from ST's enum too — an imported 4 survives as a bare number.
  WORLD_INFO: 5,
  REASONING: 6,
} as const;

export type RegexPlacement = (typeof REGEX_PLACEMENT)[keyof typeof REGEX_PLACEMENT];

/** Whether macros in the FIND pattern are expanded, and whether the result is escaped. */
export const REGEX_SUBSTITUTE = {
  /** `{{char}}` stays literal — it will only match the eight characters `{{char}}`. */
  NONE: 0,
  /** Expanded verbatim, so metacharacters in a name become live regex syntax. */
  RAW: 1,
  /** Expanded, then each substituted value is regex-escaped. */
  ESCAPED: 2,
} as const;

export type RegexSubstituteMode = (typeof REGEX_SUBSTITUTE)[keyof typeof REGEX_SUBSTITUTE];

export interface RegexScript {
  /** Opaque. The persona rule: nothing references a script by name, so renaming is free. */
  id: string;
  scriptName: string;
  /** `/pattern/flags`, or a bare pattern — which gets NO flags. See `compileFindRegex`. */
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  /**
   * `number[]`, deliberately not `RegexPlacement[]`. An imported ST script may carry 0, 3
   * or 4, and narrowing the type would push somebody into dropping them on read — which
   * would corrupt the file on the next export. Membership is an exact match at apply time,
   * so a value we don't know simply never fires.
   */
  placement: number[];
  disabled: boolean;
  /** Runs while rendering into the transcript. ST's name, kept because it is the format. */
  markdownOnly: boolean;
  /** Runs while materialising into a prompt. */
  promptOnly: boolean;
  /** Gated ST's destructive storage path, which we do not have. Preserved, never read. */
  runOnEdit: boolean;
  substituteRegex: RegexSubstituteMode;
  /** null means unlimited. Both bounds are INCLUSIVE. 0 is the newest message. */
  minDepth: number | null;
  /** null means unlimited. Both bounds are INCLUSIVE. */
  maxDepth: number | null;
}

/**
 * A blank script.
 *
 * Defaults match ST's new-script editor state (engine/index.js:797) with one exception:
 * ST starts a script on USER_INPUT only, which is the less common half of the pair. We
 * start on both, so the first thing a new user tries — hide a tag the model keeps writing
 * — works without first hunting for a checkbox.
 */
export function newRegexScript(id: string, scriptName: string): RegexScript {
  return {
    id,
    scriptName,
    findRegex: '',
    replaceString: '',
    trimStrings: [],
    placement: [REGEX_PLACEMENT.USER_INPUT, REGEX_PLACEMENT.AI_OUTPUT],
    disabled: false,
    // Display-only: the safe default. It cannot change what the model is told, so a
    // half-written pattern can never quietly corrupt a conversation.
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: REGEX_SUBSTITUTE.NONE,
    minDepth: null,
    maxDepth: null,
  };
}
