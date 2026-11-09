/**
 * How much context a model takes. Never a setting: it comes from the model's catalogue,
 * and a model that doesn't say gets a generous size every current model takes.
 */

export const UNKNOWN_MODEL_CONTEXT = 128_000;

export function contextOrDefault(known: number | null | undefined): number {
  return known && Number.isFinite(known) && known > 0 ? Math.floor(known) : UNKNOWN_MODEL_CONTEXT;
}
