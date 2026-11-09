/** Structural equality for JSON-shaped values, used to tell an edit from a value put back. */

/** Deep equality for plain objects, arrays and primitives, key order ignored. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    // A key set to undefined and a key left out read the same everywhere a preset is used.
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}
