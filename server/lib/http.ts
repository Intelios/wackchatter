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
 * Format a Content-Disposition header with an ASCII fallback and an RFC 5987 / RFC 6266
 * UTF-8 encoded filename (`filename*=UTF-8''...`).
 */
export function contentDisposition(
  filename: string,
  type: 'attachment' | 'inline' = 'attachment',
): string {
  const cleanAscii = filename.replace(/[^\w\-. ]/g, '').trim();
  const asciiFallback =
    !cleanAscii || /^\.[^.]*$/.test(cleanAscii)
      ? `export${cleanAscii.startsWith('.') ? cleanAscii : ''}`
      : cleanAscii;
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
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
