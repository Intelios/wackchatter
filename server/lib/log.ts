/**
 * Colouring for the generation log. Bun's object inspection truncates long arrays and
 * deep objects, so payloads are printed as JSON strings (see routes/generate.ts); this
 * puts back the syntax colouring the inspection would have provided.
 */

const RESET = '\x1b[0m';
const KEY = '\x1b[36m'; // cyan
const STRING = '\x1b[32m'; // green
const NUMBER = '\x1b[33m'; // yellow
const SPECIAL = '\x1b[35m'; // magenta — true / false / null

// A string followed by a colon is a key; alternatives are ordered so nothing inside a
// string literal is ever seen by the later ones.
const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Add ANSI syntax colours to a JSON document. Off unless stdout is a terminal. */
export function colorizeJson(json: string, enabled = colorsEnabled()): string {
  if (!enabled) return json;
  return json.replace(JSON_TOKEN, (match, key, colon, str) => {
    if (key !== undefined) return KEY + key + RESET + colon;
    if (str !== undefined) return STRING + str + RESET;
    if (match === 'true' || match === 'false' || match === 'null') return SPECIAL + match + RESET;
    return NUMBER + match + RESET;
  });
}

/** Re-print a JSON document with indentation; returns it unchanged if it does not parse. */
export function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function colorsEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}
