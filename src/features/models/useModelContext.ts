import { contextOrDefault } from '@shared/models/context.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import { useEffect, useMemo, useState } from 'react';
import { modelContextLength } from './modelContext.ts';

export function useModelContext(model: ResolvedModel | null) {
  const key = model ? [model.id, model.provider, model.baseUrl, model.model].join('|') : '';
  const [known, setKnown] = useState<{ key: string; tokens: number | null } | null>(null);
  useEffect(() => {
    if (!model) return;
    let live = true;
    void modelContextLength(model).then((tokens) => {
      if (live) setKnown({ key, tokens });
    });
    return () => {
      live = false;
    };
  }, [key, model]);
  const reported = known?.key === key ? known.tokens : null;
  const tokens = reported && Number.isFinite(reported) && reported > 0 ? reported : null;
  return useMemo(() => ({ tokens: contextOrDefault(tokens), assumed: tokens === null }), [tokens]);
}
