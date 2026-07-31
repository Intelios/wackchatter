/** Small helpers for building JSON/error responses consistently across routes. */

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

export function notFound(message = 'Not found'): Response {
  return errorResponse(message, 404);
}

/**
 * Wrap a handler so an unexpected throw becomes a 500 with a readable message
 * rather than taking the process down or hanging the request.
 */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[wackchatter]', error);
    return errorResponse(message, 500);
  }
}

/** Parse a JSON request body, returning null if it isn't valid JSON. */
export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
