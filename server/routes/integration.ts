import { json } from '../lib/http.ts';
import { runtimeDescriptor } from '../lib/usage.ts';
export async function handleIntegrationRoute(request: Request, segments: string[]): Promise<Response | null> {
  return request.method === 'GET' && segments.length === 0 ? json(runtimeDescriptor()) : null;
}
