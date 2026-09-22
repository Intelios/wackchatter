/**
 * Why a preset JSON buffer cannot be applied, located to a line where the engine allows.
 *
 * Engines word parse errors differently and only some of them say where: V8 gives a
 * character position (newer builds add the line and column too), Firefox gives the line
 * and column, JavaScriptCore gives neither. The location is read from whichever the
 * message carries and derived from the text when all it has is a position, so the editor
 * can point at the line whatever the browser — and still say *something* when it cannot.
 */

export interface JsonProblem {
  message: string;
  /** 1-based, or null when the engine did not say where. */
  line: number | null;
  column: number | null;
}

/** The problem with `text` as a preset, or null when it would parse into one. */
export function findJsonProblem(text: string): JsonProblem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (failure) {
    return describeJsonParseError(text, (failure as Error).message);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { message: 'A preset must be a JSON object.', line: null, column: null };
  }
  return null;
}

/** Split out from `findJsonProblem` so each engine's wording can be pinned by a test. */
export function describeJsonParseError(text: string, raw: string): JsonProblem {
  let line: number | null = null;
  let column: number | null = null;

  const lineColumn = /line (\d+) column (\d+)/i.exec(raw);
  const position = /position (\d+)/i.exec(raw);
  if (lineColumn) {
    line = Number(lineColumn[1]);
    column = Number(lineColumn[2]);
  } else if (position) {
    ({ line, column } = locate(text, Number(position[1])));
  } else if (/end of (JSON )?input|unexpected EOF/i.test(raw)) {
    ({ line, column } = locate(text, text.length));
  }

  const message = raw
    .replace(/^JSON(\.parse:| Parse error:)\s*/i, '')
    .replace(/\s+in JSON at position \d+(\s*\(line \d+ column \d+\))?/i, '')
    .replace(/\s+at line \d+ column \d+ of the JSON data$/i, '')
    .trim();

  return {
    message: message ? message[0]!.toUpperCase() + message.slice(1) : 'Invalid JSON',
    line,
    column,
  };
}

function locate(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

/** "line 3, column 5 — Expected '}'", or just the message when unlocated. */
export function formatJsonProblem(problem: JsonProblem): string {
  return problem.line === null
    ? problem.message
    : `line ${problem.line}, column ${problem.column} — ${problem.message}`;
}
