/**
 * One readable line about a character, taken from their description.
 *
 * Many cards write the description as a structured block rather than prose: W++
 * (`[Name's Personality= "caring" + ...]`), JSON, or a run of `Key: value` fields. Showing
 * that syntax under a name reads as a fault, so those cards get no line at all rather than
 * a fragment of their markup.
 */

const MAX = 160;

export function introLine(description: string): string {
  const clean = description.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (looksStructured(clean)) return '';
  const sentence = /^(.{20,160}?[.!?])(\s|$)/.exec(clean);
  if (sentence) return sentence[1]!;
  return clean.length > MAX ? `${clean.slice(0, MAX - 1).trimEnd()}…` : clean;
}

function looksStructured(text: string): boolean {
  // Opens with a bracket: W++, JSON, Ali:Chat-style blocks.
  if (/^[[{(<]/.test(text)) return true;
  // `Something= "x"` or `Something: [x` near the start: a field list.
  if (/^.{0,60}[=:]\s*["[{(]/.test(text)) return true;
  // `Name: Mika Age: 20 Gender: ...`: two or more short labelled fields in a row.
  const labels = text.slice(0, 200).match(/(^|\s)[A-Z][\w' ]{0,20}:\s/g);
  return (labels?.length ?? 0) >= 2;
}
