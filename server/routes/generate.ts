/**
 * The generation proxy.
 *
 * Deliberately the thinnest thing that can work: the browser posts the exact body it
 * wants sent, this adds a base URL and an API key, and the upstream response is piped
 * back untransformed. Nothing here parses SSE.
 *
 * Two consequences worth stating, because they are the reason for the shape:
 *  - The request carries no URL or provider. The endpoint comes from settings on this
 *    side, so a page cannot aim the server at an arbitrary host.
 *  - Since the browser posts what it built, the prompt inspector shows the real payload
 *    rather than a reconstruction of it.
 */

import type { ChatCompletionBody } from '../../shared/providers/types.ts';
import { callUpstream, describeFailure, trackGeneration } from '../lib/generate.ts';
import { errorResponse, readJson } from '../lib/http.ts';
import { colorizeJson, prettyJson } from '../lib/log.ts';

export async function handleGenerateRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  if (segments.length !== 0 || request.method !== 'POST') return null;

  const payload = await readJson<{ body?: ChatCompletionBody; connectionId?: unknown }>(request);
  if (!payload?.body || typeof payload.body !== 'object') {
    return errorResponse('Expected a JSON object with a "body" property.');
  }
  if (payload.connectionId !== undefined && typeof payload.connectionId !== 'string') {
    return errorResponse('"connectionId" must be a saved connection id.');
  }

  // Stringified, not the object: Bun's console truncates long arrays and deep objects
  // ("... N more items") and offers no inspect defaults to lift the limits, unlike the
  // Node console SillyTavern tunes with util.inspect.defaultOptions.
  console.debug('Chat Completion request:', colorizeJson(JSON.stringify(payload.body, null, 2)));

  // Held until the reply is done, so the data folder cannot move out from under the save
  // that follows it. Releasing on abort as well as on completion, because a client that
  // hangs up mid-stream never reaches the transform's flush.
  const finished = trackGeneration();
  request.signal.addEventListener('abort', finished, { once: true });

  let upstream: Response;
  try {
    upstream = await callUpstream(payload.body, request.signal, payload.connectionId);
  } catch (error) {
    finished();
    // A client that hung up mid-connect is not an error worth reporting back.
    if (request.signal.aborted) return new Response(null, { status: 499 });

    console.error('Generation failed:', error);
    const message = (error as Error).message;
    return errorResponse(
      message.includes('ECONNREFUSED') || message.includes('Unable to connect')
        ? `Could not reach the endpoint: ${message}`
        : message,
      message.startsWith('Unknown connection') ? 400 : 502,
    );
  }

  if (!upstream.ok) {
    finished();
    const errorText = await upstream.text();
    console.error(`Chat Completion error ${upstream.status}:`, errorText);
    return errorResponse(describeFailure(upstream.status, errorText), upstream.status);
  }

  const headers = {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-cache, no-transform',
    // Tells any reverse proxy in front of us not to buffer the stream.
    'x-accel-buffering': 'no',
  };

  if (payload.body.stream) {
    console.info('Streaming request in progress');
    const transform = new TransformStream({
      flush() {
        finished();
        console.info('Streaming request finished');
      },
    });
    return new Response(upstream.body?.pipeThrough(transform), { status: 200, headers });
  }

  const text = await upstream.text();
  finished();
  console.debug('Chat Completion response:', colorizeJson(prettyJson(text)));
  return new Response(text, { status: 200, headers });
}
