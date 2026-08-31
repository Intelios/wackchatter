import { describe, expect, test } from 'bun:test';
import { createSseParser, createStreamAccumulator, parseCompletion, type SseFrame } from './sse.ts';

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

describe('multi-choice completions', () => {
  /** A delta for one specific completion, as a stream with `n > 1` interleaves them. */
  function delta(index: number, content: string): SseFrame {
    return frame(JSON.stringify({ choices: [{ index, delta: { content } }] }));
  }

  test('a single-choice stream reports no alternates at all', () => {
    // The regression that matters: `n: 1` is almost every request, and it must produce
    // exactly the state it always did.
    const accumulator = createStreamAccumulator();
    accumulator.push(delta(0, 'Hello.'));
    expect(accumulator.snapshot().alternates).toBeUndefined();
  });

  test('interleaved deltas stay with their own completion', () => {
    // Taking choices[0] of each chunk — what this did before — splices all three into one.
    const accumulator = createStreamAccumulator();
    accumulator.push(delta(0, 'The '));
    accumulator.push(delta(1, 'A '));
    accumulator.push(delta(2, 'One '));
    accumulator.push(delta(1, 'cat'));
    accumulator.push(delta(0, 'dog'));
    accumulator.push(delta(2, 'bird'));

    const state = accumulator.snapshot();
    expect(state.content).toBe('The dog');
    expect(state.alternates?.map((choice) => choice.content)).toEqual(['A cat', 'One bird']);
  });

  test('several choices inside one chunk are all read', () => {
    const accumulator = createStreamAccumulator();
    accumulator.push(
      frame(
        JSON.stringify({
          choices: [
            { index: 0, delta: { content: 'first' } },
            { index: 1, delta: { content: 'second' } },
          ],
        }),
      ),
    );

    const state = accumulator.snapshot();
    expect(state.content).toBe('first');
    expect(state.alternates?.[0]?.content).toBe('second');
  });

  test('deltas with no index at all belong to the first completion', () => {
    // Some proxies omit `index`. Treating that as choice 0 is what keeps them working.
    const accumulator = createStreamAccumulator();
    accumulator.push(frame(JSON.stringify({ choices: [{ delta: { content: 'hi ' } }] })));
    accumulator.push(frame(JSON.stringify({ choices: [{ delta: { content: 'there' } }] })));

    const state = accumulator.snapshot();
    expect(state.content).toBe('hi there');
    expect(state.alternates).toBeUndefined();
  });

  test('reasoning and finish_reason are tracked per completion', () => {
    const accumulator = createStreamAccumulator();
    accumulator.push(
      frame(JSON.stringify({ choices: [{ index: 1, delta: { reasoning: 'Hmm' } }] })),
    );
    accumulator.push(delta(0, 'done'));
    accumulator.push(
      frame(JSON.stringify({ choices: [{ index: 1, finish_reason: 'length', delta: {} }] })),
    );
    accumulator.push(
      frame(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })),
    );

    const state = accumulator.snapshot();
    expect(state.reasoning).toBe('');
    expect(state.finishReason).toBe('stop');
    expect(state.alternates?.[0]).toEqual({
      content: '',
      reasoning: 'Hmm',
      finishReason: 'length',
    });
  });

  test('a gap in the indices is filled, never renumbered', () => {
    // An index has to keep meaning the same completion. Closing the gap would make the
    // stream's choice 2 arrive as alternate 1 and merge with whatever lands there next.
    const accumulator = createStreamAccumulator();
    accumulator.push(delta(0, 'primary'));
    accumulator.push(delta(2, 'third'));

    expect(accumulator.snapshot().alternates).toEqual([
      { content: '', reasoning: '', finishReason: null },
      { content: 'third', reasoning: '', finishReason: null },
    ]);
  });

  test('a nonsense index does not allocate an array of that size', () => {
    const accumulator = createStreamAccumulator();
    accumulator.push(delta(9999, 'x'));
    accumulator.push(delta(-1, 'y'));

    // Both fall back to the first choice rather than growing the array.
    expect(accumulator.snapshot().alternates).toBeUndefined();
    expect(accumulator.snapshot().content).toBe('xy');
  });

  test('the seed belongs to the reply being continued, not to the alternates', () => {
    const accumulator = createStreamAccumulator('We went');
    accumulator.push(delta(0, ' onward.'));
    accumulator.push(delta(1, ' back.'));

    const state = accumulator.snapshot();
    expect(state.content).toBe('We went onward.');
    expect(state.alternates?.[0]?.content).toBe(' back.');
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

  test('one choice reports no alternates', () => {
    expect(
      parseCompletion({ choices: [{ message: { content: 'a' } }] }).alternates,
    ).toBeUndefined();
  });

  test('extra choices come back as alternates, in order', () => {
    const state = parseCompletion({
      choices: [
        { message: { content: 'first' }, finish_reason: 'stop' },
        { message: { content: 'second', reasoning: 'why' }, finish_reason: 'stop' },
        { message: { content: 'third' }, finish_reason: 'length' },
      ],
    });

    expect(state.content).toBe('first');
    expect(state.alternates).toEqual([
      { content: 'second', reasoning: 'why', finishReason: 'stop' },
      { content: 'third', reasoning: '', finishReason: 'length' },
    ]);
  });

  test('a seed prefixes only the first choice', () => {
    const state = parseCompletion(
      { choices: [{ message: { content: ' onward.' } }, { message: { content: ' back.' } }] },
      'We went',
    );

    expect(state.content).toBe('We went onward.');
    expect(state.alternates?.[0]?.content).toBe(' back.');
  });
});

describe('usage detail and generation identity', () => {
  test('nested cached and reasoning counts are read off a usage-only final chunk', () => {
    const accumulator = createStreamAccumulator();
    const state = accumulator.push(
      frame(
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 8421,
            completion_tokens: 612,
            total_tokens: 9033,
            prompt_tokens_details: { cached_tokens: 4096 },
            completion_tokens_details: { reasoning_tokens: 200 },
          },
        }),
      ),
    );
    expect(state?.usage).toEqual({
      prompt_tokens: 8421,
      completion_tokens: 612,
      total_tokens: 9033,
      cached_tokens: 4096,
      reasoning_tokens: 200,
    });
  });

  test('missing detail objects leave the counts absent rather than zero', () => {
    // Zero and "not reported" are different claims, and only one of them is billable.
    const accumulator = createStreamAccumulator();
    const state = accumulator.push(
      frame(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })),
    );
    expect(state?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3 });
    expect(state?.usage?.cached_tokens).toBeUndefined();
    expect(state?.usage?.reasoning_tokens).toBeUndefined();
  });

  test('a detail object carrying junk is ignored, not coerced', () => {
    const accumulator = createStreamAccumulator();
    const state = accumulator.push(
      frame(
        JSON.stringify({
          choices: [],
          usage: {
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 'lots' },
            completion_tokens_details: null,
          },
        }),
      ),
    );
    expect(state?.usage).toEqual({ completion_tokens: 3 });
  });

  test('the response id is captured from the first chunk that carries one', () => {
    const accumulator = createStreamAccumulator();
    accumulator.push(
      frame(JSON.stringify({ id: 'gen-abc', choices: [{ delta: { content: 'h' } }] })),
    );
    accumulator.push(
      frame(JSON.stringify({ id: 'gen-abc', choices: [{ delta: { content: 'i' } }] })),
    );
    const state = accumulator.snapshot();
    expect(state.id).toBe('gen-abc');
    expect(state.content).toBe('hi');
  });

  test('a stream with no id leaves it absent for the transport to fill in', () => {
    const accumulator = createStreamAccumulator();
    accumulator.push(frame(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })));
    expect(accumulator.snapshot().id).toBeUndefined();
  });

  test('parseCompletion captures the id and the detail counts too', () => {
    const state = parseCompletion({
      id: 'cmpl-42',
      model: 'glm-5.2',
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 8 },
      },
    });
    expect(state.id).toBe('cmpl-42');
    expect(state.usage?.cached_tokens).toBe(8);
  });
});
