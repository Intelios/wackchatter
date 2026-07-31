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
import { callUpstream, describeFailure } from '../lib/generate.ts';
import { errorResponse, readJson } from '../lib/http.ts';

export async function handleGenerateRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  if (segments.length !== 0 || request.method !== 'POST') return null;

  const payload = await readJson<{ body?: ChatCompletionBody }>(request);
  if (!payload?.body || typeof payload.body !== 'object') {
    return errorResponse('Expected a JSON object with a "body" property.');
  }

  let upstream: Response;
  try {
    upstream = await callUpstream(payload.body, request.signal);
  } catch (error) {
    // A client that hung up mid-connect is not an error worth reporting back.
    if (request.signal.aborted) return new Response(null, { status: 499 });

    const message = (error as Error).message;
    return errorResponse(
      message.includes('ECONNREFUSED') || message.includes('Unable to connect')
        ? `Could not reach the endpoint: ${message}`
        : message,
      502,
    );
  }

  if (!upstream.ok) {
    return errorResponse(describeFailure(upstream.status, await upstream.text()), upstream.status);
  }

  // Pipe the body straight through. Bun streams it without buffering, and because none
  // of our code runs inside the stream there is nothing that can throw partway and turn
  // a half-delivered response into a 500.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache, no-transform',
      // Tells any reverse proxy in front of us not to buffer the stream.
      'x-accel-buffering': 'no',
    },
  });
}
