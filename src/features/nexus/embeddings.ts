import { NEXUS_MODEL_FINGERPRINT } from '@shared/nexus/model.ts';
import type { NexusDocument, NexusEmbedding } from '@shared/nexus/types.ts';

interface Job {
  id: number;
  text: string;
  query: boolean;
  resolve: (v: number[]) => void;
  reject: (e: Error) => void;
}
let worker: Worker | undefined;
let active: Job | undefined;
let nextId = 0;
const waiting: Job[] = [];
function pump() {
  if (active || !waiting.length) return;
  if (!worker) {
    worker = new Worker(new URL('./embedding.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; vector: number[]; error?: string }>) => {
      if (event.data.id !== active?.id) return;
      const job = active;
      active = undefined;
      if (event.data.error) job.reject(new Error(event.data.error));
      else job.resolve(event.data.vector);
      pump();
    };
    worker.onerror = () => {
      const error = new Error(
        'Local semantic search could not start. Text and graph search remain available.',
      );
      active?.reject(error);
      active = undefined;
      for (const job of waiting.splice(0)) job.reject(error);
      worker?.terminate();
      worker = undefined;
    };
  }
  active = waiting.shift()!;
  worker.postMessage({ id: active.id, text: active.text, query: active.query });
}
const queryCache = new Map<string, number[]>();
export function embed(text: string, query = false): Promise<number[]> {
  const key = `${NEXUS_MODEL_FINGERPRINT}:${text}`;
  if (query && queryCache.has(key)) return Promise.resolve(queryCache.get(key)!);
  return new Promise<number[]>((resolve, reject) => {
    const job = { id: ++nextId, text, query, resolve, reject };
    if (query) waiting.unshift(job);
    else waiting.push(job);
    pump();
  }).then((vector) => {
    if (query) {
      if (queryCache.size >= 32) queryCache.delete(queryCache.keys().next().value!);
      queryCache.set(key, vector);
    }
    return vector;
  });
}
async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Nexus index: ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}
export const loadIndex = async (chatId: string) => {
  const result = await jsonRequest<{ model: string; entries: NexusEmbedding[] }>(
    `/api/chats/${encodeURIComponent(chatId)}/nexus-index`,
  );
  if (result.model !== NEXUS_MODEL_FINGERPRINT)
    throw new Error('Nexus model version changed. Reload the application.');
  return result.entries;
};
export const saveIndex = (chatId: string, entries: NexusEmbedding[]) =>
  jsonRequest(`/api/chats/${encodeURIComponent(chatId)}/nexus-index`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries, model: NEXUS_MODEL_FINGERPRINT }),
  });
export async function embedDocument(doc: NexusDocument): Promise<NexusEmbedding> {
  return { documentId: doc.id, fingerprint: doc.fingerprint, vector: await embed(doc.text) };
}
