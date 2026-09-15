import { DEFAULT_NEXUS, type NexusSettings } from './types.ts';
export function normalizeNexusSettings(value: unknown): NexusSettings {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const n = (key: keyof NexusSettings, min: number, max: number) =>
    typeof v[key] === 'number' && Number.isFinite(v[key])
      ? Math.max(min, Math.min(max, v[key] as number))
      : (DEFAULT_NEXUS[key] as number);
  const str = (key: keyof NexusSettings) =>
    typeof v[key] === 'string' ? (v[key] as string) : (DEFAULT_NEXUS[key] as string);
  return {
    connectionId: typeof v.connectionId === 'string' && v.connectionId ? v.connectionId : null,
    model: str('model'),
    extractPrompt: str('extractPrompt'),
    autoInterval: Math.floor(n('autoInterval', 0, 2000)),
    // Context ceilings move faster than this file: the upper bound is a garbage guard
    // (Infinity would survive a round-trip as null), never a policy.
    inputTokens: Math.floor(n('inputTokens', 2048, Number.MAX_SAFE_INTEGER)),
    outputTokens: Math.floor(n('outputTokens', 256, 16384)),
    budgetTokens: Math.floor(n('budgetTokens', 0, 32000)),
    temperature: n('temperature', 0, 2),
    reasoningEffort: ['auto', 'min', 'low', 'medium', 'high', 'max'].includes(
      String(v.reasoningEffort),
    )
      ? (v.reasoningEffort as NexusSettings['reasoningEffort'])
      : DEFAULT_NEXUS.reasoningEffort,
    motion: typeof v.motion === 'boolean' ? v.motion : true,
    template: str('template'),
    position: ['none', 'beforeMain', 'afterMain', 'atDepth'].includes(String(v.position))
      ? (v.position as NexusSettings['position'])
      : DEFAULT_NEXUS.position,
    depth: Math.floor(n('depth', 0, 100)),
    role: ['system', 'user', 'assistant'].includes(String(v.role))
      ? (v.role as NexusSettings['role'])
      : DEFAULT_NEXUS.role,
  };
}
