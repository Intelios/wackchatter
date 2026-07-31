import { describe, expect, test } from 'bun:test';
import { type SseFrame, createSseParser, createStreamAccumulator, parseCompletion } from './sse.ts';

/** Wrap a delta the way an OpenAI-compatible stream does. */
function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

function frame(data: string): SseFrame {
  return { data };
}

describe('framing', () => {
  test('a complete frame is emitted', () => {
    const parser = createSseParser();
    expect(parser.push('data: hello\n\n')).toEqual([{ data: 'hello' }]);
  });

  test('a frame split across two pushes yields exactly one frame', () => {
    // The case that matters: network chunks land mid-JSON, so a parser that treats each
    // chunk as a frame produces a JSON.parse error and kills the stream.
    const parser = createSseParser();
    expect(parser.push('data: {"cho')).toEqual([]);
    expect(parser.push('ices":[{"delta":{"content":"hi"}}]}\n\n')).toEqual([
      { data: '{"choices":[{"delta":{"content":"hi"}}]}' },
    ]);
  });

  test('a separator split across pushes still terminates', () => {
    const parser = createSseParser();
    expect(parser.push('data: hello\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ data: 'hello' }]);
  });

  test('several frames in one chunk all come out', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\n\ndata: b\n\ndata: c\n\n')).toEqual([
      { data: 'a' },
      { data: 'b' },
      { data: 'c' },
    ]);
  });

  test('both \\r\\n\\r\\n and \\n\\n terminate a frame', () => {
    expect(createSseParser().push('data: a\r\n\r\n')).toEqual([{ data: 'a' }]);
    expect(createSseParser().push('data: b\n\n')).toEqual([{ data: 'b' }]);
    expect(createSseParser().push('data: c\r\r')).toEqual([{ data: 'c' }]);
  });

  test('multi-line data fields join with a newline, per the SSE spec', () => {
    const parser = createSseParser();
    expect(parser.push('data: line one\ndata: line two\n\n')).toEqual([
      { data: 'line one\nline two' },
    ]);
  });

  test('an event name is carried through', () => {
    const parser = createSseParser();
    expect(parser.push('event: ping\ndata: {}\n\n')).toEqual([{ event: 'ping', data: '{}' }]);
  });

  test('OpenRouter keepalive comments are ignored and do not end the stream', () => {
    // OpenRouter emits ": OPENROUTER PROCESSING" between tokens on slow models.
    const parser = createSseParser();
    expect(parser.push(': OPENROUTER PROCESSING\n\n')).toEqual([]);
    expect(parser.push('data: still here\n\n')).toEqual([{ data: 'still here' }]);
  });

  test('a comment sharing a block with data does not suppress the data', () => {
    const parser = createSseParser();
    expect(parser.push(': keepalive\ndata: payload\n\n')).toEqual([{ data: 'payload' }]);
  });

  test('only one space after the colon is stripped', () => {
    const parser = createSseParser();
    expect(parser.push('data:  two spaces\n\n')).toEqual([{ data: ' two spaces' }]);
    expect(parser.push('data:none\n\n')).toEqual([{ data: 'none' }]);
  });

  test('flush emits a trailing frame that never got its terminator', () => {
    const parser = createSseParser();
    expect(parser.push('data: dangling')).toEqual([]);
    expect(parser.flush()).toEqual([{ data: 'dangling' }]);
    expect(parser.flush()).toEqual([]);
  });

  test('flush on whitespace-only leftovers emits nothing', () => {
    const parser = createSseParser();
    parser.push('data: a\n\n\n');
    expect(parser.flush()).toEqual([]);
  });
});

describe('accumulation', () => {
  test('push returns the full accumulated text, never the delta', () => {
    // This is the property the throttled UI depends on: if the consumer assigns rather
    // than appends, a dropped frame costs nothing.
    const accumulator = createStreamAccumulator();
    const parser = createSseParser();

    let last = '';
    for (const piece of ['Hello', ', ', 'world']) {
      for (const f of parser.push(chunk(piece))) {
        last = accumulator.push(f)?.content ?? last;
      }
    }

    expect(last).toBe('Hello, world');
    expect(accumulator.snapshot().content).toBe('Hello, world');
  });

  test('a seed prefixes the accumulation, for continue', () => {
    const accumulator = createStreamAccumulator('The door creaked');
    const parser = createSseParser();
    const [f] = parser.push(chunk(' open.'));
    expect(accumulator.push(f!)?.content).toBe('The door creaked open.');
  });

  test('[DONE] ends the stream once', () => {
    const accumulator = createStreamAccumulator();
    expect(accumulator.push(frame('[DONE]'))?.done).toBe(true);
    expect(accumulator.push(frame('[DONE]'))).toBeNull();
  });

  test('a usage-only final chunk with empty choices does not throw', () => {
    // What stream_options / usage:{include:true} returns as the last chunk.
    const accumulator = createStreamAccumulator();
    const state = accumulator.push(
      frame(JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })),
    );
    expect(state?.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20 });
    expect(state?.content).toBe('');
  });

  test('both reasoning and reasoning_content land in reasoning', () => {
    const openrouter = createStreamAccumulator();
    expect(
      openrouter.push(frame(JSON.stringify({ choices: [{ delta: { reasoning: 'Thinking…' } }] })))
        ?.reasoning,
    ).toBe('Thinking…');

    const other = createStreamAccumulator();
    expect(
      other.push(frame(JSON.stringify({ choices: [{ delta: { reasoning_content: 'Hmm.' } }] })))
        ?.reasoning,
    ).toBe('Hmm.');
  });

  test('reasoning accumulates separately from content', () => {
    const accumulator = createStreamAccumulator();
    accumulator.push(frame(JSON.stringify({ choices: [{ delta: { reasoning: 'a' } }] })));
    accumulator.push(frame(JSON.stringify({ choices: [{ delta: { content: 'X' } }] })));
    accumulator.push(frame(JSON.stringify({ choices: [{ delta: { reasoning: 'b' } }] })));

    const state = accumulator.snapshot();
    expect(state.reasoning).toBe('ab');
    expect(state.content).toBe('X');
  });

  test('finish_reason and model are captured', () => {
    const accumulator = createStreamAccumulator();
    const state = accumulator.push(
      frame(JSON.stringify({ model: 'gpt-4o', choices: [{ finish_reason: 'stop', delta: {} }] })),
    );
    expect(state?.finishReason).toBe('stop');
    expect(state?.model).toBe('gpt-4o');
  });

  test('an error object inside a 200 stream surfaces and stops the stream', () => {
    const accumulator = createStreamAccumulator();
    const state = accumulator.push(
      frame(JSON.stringify({ error: { message: 'Rate limit exceeded' } })),
    );
    expect(state?.error).toBe('Rate limit exceeded');
    expect(state?.done).toBe(true);
  });

  test('a bare string error is also recognised', () => {
    const accumulator = createStreamAccumulator();
    expect(accumulator.push(frame(JSON.stringify({ error: 'upstream exploded' })))?.error).toBe(
      'upstream exploded',
    );
  });

  test('non-JSON data is ignored rather than aborting a working stream', () => {
    const accumulator = createStreamAccumulator();
    expect(accumulator.push(frame('not json at all'))).toBeNull();
    expect(accumulator.push(frame(''))).toBeNull();
    // The stream keeps working afterwards.
    const parser = createSseParser();
    const [f] = parser.push(chunk('fine'));
    expect(accumulator.push(f!)?.content).toBe('fine');
  });

  test('a frame that changes nothing returns null', () => {
    const accumulator = createStreamAccumulator();
    expect(accumulator.push(frame(JSON.stringify({ choices: [{ delta: {} }] })))).toBeNull();
  });

  test('snapshots are fresh objects, safe to hold across renders', () => {
    const accumulator = createStreamAccumulator();
    const first = accumulator.snapshot();
    accumulator.push(frame(JSON.stringify({ choices: [{ delta: { content: 'x' } }] })));
    expect(first.content).toBe('');
    expect(accumulator.snapshot().content).toBe('x');
  });
});

describe('non-streamed completions', () => {
  test('a normal response is read into the same shape', () => {
    const state = parseCompletion({
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    });

    expect(state.content).toBe('Hello.');
    expect(state.finishReason).toBe('stop');
    expect(state.model).toBe('gpt-4o');
    expect(state.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    expect(state.done).toBe(true);
  });

  test('reasoning is read from either field', () => {
    expect(
      parseCompletion({ choices: [{ message: { content: 'a', reasoning: 'why' } }] }).reasoning,
    ).toBe('why');
    expect(
      parseCompletion({ choices: [{ message: { content: 'a', reasoning_content: 'how' } }] })
        .reasoning,
    ).toBe('how');
  });

  test('a seed prefixes it, for a non-streamed continue', () => {
    expect(
      parseCompletion({ choices: [{ message: { content: ' onward.' } }] }, 'We went').content,
    ).toBe('We went onward.');
  });

  test('an error body surfaces as an error', () => {
    const state = parseCompletion({ error: { message: 'bad request' } });
    expect(state.error).toBe('bad request');
    expect(state.content).toBe('');
  });

  test('junk does not throw', () => {
    expect(parseCompletion(null).content).toBe('');
    expect(parseCompletion({ choices: [] }).content).toBe('');
  });
});
