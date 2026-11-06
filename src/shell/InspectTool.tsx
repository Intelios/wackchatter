/**
 * Inspect: every reply in the chat traced as a row of phases, and one reply opened up —
 * its lanes on a shared clock, its facts, what changed since the one before, and the
 * prompt it sent, as blocks or raw. Timings live on every swipe for good; prompts only
 * for the last few replies of the session.
 */

import type { MessageState } from '@shared/chat/message.ts';
import type { ApiMessage } from '@shared/types/chat.ts';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { PromptInspection } from '../features/chat/state/chatReducer.ts';
import { Icon } from './icons.tsx';
import {
  type Attempt,
  type Block,
  chatTurns,
  type Lane,
  type Names,
  phases,
  previousInspection,
  promptBlocks,
  promptDiff,
  rowScale,
  seconds,
  stripWindow,
  type Turn,
  traceLanes,
  turnStats,
} from './inspect.ts';
import './inspect.css';

/** How many replies keep the prompt they sent: the chat's inspections cap. */
export const KEPT_PROMPTS = 10;

interface InspectToolProps {
  chatId: string | null;
  messages: readonly MessageState[];
  inspections: readonly PromptInspection[];
  /** The message being written right now, if any. */
  liveMessageId: string | null;
  names: Names;
  avatarUrl: string | null;
  countText: (text: string) => number;
  onOpenTool: (tool: 'lorebooks' | 'memory') => void;
}

/** Ticks while something is live, so its clock runs. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function InspectTool(props: InspectToolProps) {
  const { messages, liveMessageId, chatId } = props;
  const inspections = useMemo(
    () => props.inspections.filter((inspection) => inspection.chatId === chatId),
    [props.inspections, chatId],
  );
  const turns = useMemo(
    () => chatTurns(messages, inspections, liveMessageId),
    [messages, inspections, liveMessageId],
  );
  // Null follows the newest reply, so a reply being written comes into view by itself.
  const [picked, setPicked] = useState<string | null>(null);
  const now = useNow(turns.some((turn) => turn.main.outcome === 'live'));

  if (!chatId) return <p className="w3-ins__empty">Open a chat to inspect its replies.</p>;
  if (!turns.length) {
    return (
      <p className="w3-ins__empty">
        No replies yet. Send a message and its timeline shows up here.
      </p>
    );
  }

  const newest = turns.at(-1) as Turn;
  const found = picked ? findAttempt(turns, picked) : null;
  const [turn, attempt] = found ?? [newest, newest.main];

  return (
    <div className="w3-ins">
      <Replies
        turns={turns}
        turn={turn}
        attempt={attempt}
        now={now}
        onPick={(key) => setPicked(key === newest.main.key ? null : key)}
      />
      <Reply
        {...props}
        key={attempt.key}
        turn={turn}
        attempt={attempt}
        now={now}
        inspections={inspections}
      />
    </div>
  );
}

function findAttempt(turns: readonly Turn[], key: string): [Turn, Attempt] | null {
  for (const turn of turns) {
    const attempt = turn.attempts.find((a) => a.key === key);
    if (attempt) return [turn, attempt];
  }
  return null;
}

function elapsed(attempt: Attempt, now: number): number {
  return attempt.total ?? Math.max(0, now - attempt.at);
}

// ---------- The list ----------

function Replies({
  turns,
  turn,
  attempt,
  now,
  onPick,
}: {
  turns: Turn[];
  turn: Turn;
  attempt: Attempt;
  now: number;
  onPick: (key: string) => void;
}) {
  const scale = rowScale(turns.map((t) => t.main.total ?? 0));
  const picked = turns.indexOf(turn);
  const [first, last] = stripWindow(turns.length, picked);
  const shown = turns.slice(first, last + 1).reverse();
  const stats = turnStats(turns);

  return (
    <section className="w3-ins__replies" aria-label="Replies">
      {turns.length > 1 ? (
        <>
          <Strip turns={turns} picked={turn} window={[first, last]} onPick={onPick} />
          {stats ? (
            <div className="w3-ins__stripmeta">
              <span>{label(turns[0] as Turn)}</span>
              <span>
                median {seconds(stats.median)} · slowest {seconds(stats.slowest.main.total ?? 0)}
                {stats.slowest.n ? ` (#${stats.slowest.n})` : ''}
              </span>
              <span>{label(turns.at(-1) as Turn)}</span>
            </div>
          ) : null}
        </>
      ) : null}
      <div className="w3-ins__legend">
        <span>
          <i data-phase="prep" />
          Prompt
        </span>
        <span>
          <i data-phase="wait" />
          Waiting
        </span>
        <span>
          <i data-phase="think" />
          Thinking
        </span>
        <span>
          <i data-phase="write" />
          Writing
        </span>
      </div>
      <div className="w3-ins__axis" aria-hidden>
        <span>0</span>
        <span>{seconds(scale / 2)}</span>
        <span>{seconds(scale)}</span>
      </div>
      <div className="w3-ins__rows">
        {shown.map((entry) => (
          <Fragment key={entry.main.key}>
            <Row
              turn={entry}
              attempt={entry.main}
              scale={scale}
              now={now}
              current={entry.main === attempt}
              onPick={onPick}
            />
            {entry.attempts
              .filter((other) => other !== entry.main)
              .map((other) => (
                <Row
                  key={other.key}
                  turn={entry}
                  attempt={other}
                  scale={scale}
                  now={now}
                  current={other === attempt}
                  onPick={onPick}
                  swipe
                />
              ))}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function label(turn: Turn): string {
  if (turn.n !== null) return `#${turn.n}`;
  return turn.main.kind === 'impersonation' ? 'you' : 'try';
}

function attemptLabel(turn: Turn, attempt: Attempt, swipe: boolean): string {
  if (!swipe) return label(turn);
  if (attempt.swipe !== null) return `swipe ${attempt.swipe + 1}`;
  return attempt.outcome === 'live' ? 'new' : 'try';
}

function Row({
  turn,
  attempt,
  scale,
  now,
  current,
  onPick,
  swipe = false,
}: {
  turn: Turn;
  attempt: Attempt;
  scale: number;
  now: number;
  current: boolean;
  onPick: (key: string) => void;
  swipe?: boolean;
}) {
  const total = elapsed(attempt, now);
  const cut = attempt.outcome === 'stopped' || attempt.outcome === 'failed';
  const time = attempt.outcome === 'failed' && !attempt.trace?.writing ? 'failed' : seconds(total);
  return (
    <button
      type="button"
      className="w3-ins__row"
      data-swipe={swipe || undefined}
      data-over={total > scale || undefined}
      data-cut={cut || undefined}
      data-old={!attempt.trace && attempt.outcome !== 'live' ? '' : undefined}
      aria-current={current}
      title={
        !attempt.trace && attempt.outcome !== 'live'
          ? 'From before tracing began: only its total time is known'
          : undefined
      }
      onClick={() => onPick(attempt.key)}
    >
      <span className="w3-ins__n">{attemptLabel(turn, attempt, swipe)}</span>
      <Bar attempt={attempt} total={total} scale={scale} />
      <span className="w3-ins__t">{time}</span>
    </button>
  );
}

function Bar({ attempt, total, scale }: { attempt: Attempt; total: number; scale: number }) {
  const width = Math.min(1, total / scale) * 100;
  const cut = attempt.outcome === 'stopped' || attempt.outcome === 'failed';
  if (attempt.outcome === 'live') {
    return (
      <span className="w3-ins__bar">
        <span className="w3-ins__live" style={{ width: `${width}%` }} />
      </span>
    );
  }
  return (
    <span className="w3-ins__bar" data-over={total > scale || undefined}>
      <span className="w3-ins__fill" style={{ width: `${width}%` }}>
        {phases(attempt).map((part) => (
          <i
            key={part.phase}
            data-phase={part.phase}
            style={{ width: `${total ? (part.ms / total) * 100 : 0}%` }}
          />
        ))}
        {cut ? <i className="w3-ins__cut" /> : null}
      </span>
    </span>
  );
}

function Strip({
  turns,
  picked,
  window,
  onPick,
}: {
  turns: Turn[];
  picked: Turn;
  window: [number, number];
  onPick: (key: string) => void;
}) {
  const peak = Math.max(1, ...turns.map((t) => t.main.total ?? 0));
  const count = turns.length;
  return (
    <div className="w3-ins__strip" data-dense={count > 120 || undefined}>
      {turns.map((turn, index) => {
        const total = turn.main.total ?? 0;
        const height = Math.sqrt(total / peak) * 100;
        return (
          <button
            key={turn.main.key}
            type="button"
            title={`${label(turn)} · ${turn.main.total === null ? 'being written' : seconds(total)}`}
            aria-label={`${label(turn)}, ${seconds(total)}`}
            aria-current={turn === picked}
            data-in={(index >= window[0] && index <= window[1]) || undefined}
            onClick={() => onPick(turn.main.key)}
          >
            {turn.main.outcome === 'live' ? (
              <i data-phase="write" style={{ height: '100%' }} />
            ) : (
              phases(turn.main).map((part) => (
                <i
                  key={part.phase}
                  data-phase={part.phase}
                  style={{ height: `${total ? (part.ms / total) * height : 0}%` }}
                />
              ))
            )}
          </button>
        );
      })}
      <span
        className="w3-ins__window"
        style={{
          left: `${(window[0] / count) * 100}%`,
          width: `${((window[1] - window[0] + 1) / count) * 100}%`,
        }}
      />
    </div>
  );
}

// ---------- One reply ----------

const OUTCOME: Record<string, string> = {
  finished: 'finished',
  length: 'hit the length limit',
  stopped: 'stopped by you',
  failed: 'failed',
  live: 'being written…',
  unknown: 'cut short',
};

function Reply({
  turn,
  attempt,
  now,
  inspections,
  names,
  avatarUrl,
  countText,
  onOpenTool,
}: InspectToolProps & { turn: Turn; attempt: Attempt; now: number }) {
  const trace = attempt.trace;
  const swipes = turn.attempts.filter((a) => a.swipe !== null).length;
  const who =
    attempt.kind === 'impersonation'
      ? 'Written for you'
      : `${turn.n ? `Reply ${turn.n}` : 'A try'} · ${names.char}${
          attempt.swipe !== null && swipes > 1 ? ` · swipe ${attempt.swipe + 1} of ${swipes}` : ''
        }`;
  const total = elapsed(attempt, now);
  const outcome = attempt.outcome;
  const bad = outcome === 'stopped' || outcome === 'failed' || outcome === 'length';
  const failure = attempt.inspection?.failure;

  return (
    <section className="w3-ins__reply" aria-label="This reply">
      <header className="w3-ins__head">
        <span className="w3-ins__kicker">
          {avatarUrl && attempt.kind === 'reply' ? <img src={avatarUrl} alt="" /> : null}
          {who}
          {attempt.at ? <time>{clock(attempt.at)}</time> : null}
        </span>
        <div className="w3-ins__big">
          <strong>{seconds(total)}</strong>
          {trace && outcome !== 'live' ? <Splits attempt={attempt} /> : null}
          <span className="w3-ins__outcome" data-bad={bad || undefined}>
            {failure && outcome === 'failed' ? `failed · ${failure}` : OUTCOME[outcome]}
          </span>
        </div>
      </header>

      {trace ? (
        <Lanes lanes={traceLanes(trace)} attempt={attempt} onOpenTool={onOpenTool} />
      ) : outcome === 'live' ? (
        <p className="w3-ins__note">Its timeline appears when it finishes.</p>
      ) : (
        <div className="w3-ins__note" data-box>
          <b>Written before tracing began</b>
          Only its total time is known. Replies from now on are traced in full.
        </div>
      )}

      {outcome !== 'live' ? <Facts attempt={attempt} /> : null}

      <Prompt
        attempt={attempt}
        inspections={inspections}
        names={names}
        countText={countText}
        traced={Boolean(trace)}
      />
    </section>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function Splits({ attempt }: { attempt: Attempt }) {
  const trace = attempt.trace;
  if (!trace) return null;
  const parts = phases(attempt);
  const ms = (phase: string) => parts.find((p) => p.phase === phase)?.ms;
  const firstBack = trace.thinking ?? trace.writing;
  const think = ms('think');
  const write = ms('write');
  return (
    <span className="w3-ins__splits">
      {firstBack !== undefined ? (
        <>
          first token <b>{seconds(firstBack)}</b>
        </>
      ) : null}
      {think !== undefined ? (
        <>
          {' · '}thinking <b>{seconds(think)}</b>
        </>
      ) : null}
      {write !== undefined ? (
        <>
          {' · '}writing <b>{seconds(write)}</b>
        </>
      ) : null}
    </span>
  );
}

const LANE_NAMES: Record<Lane['id'], [string, string?]> = {
  prep: ['Building the prompt'],
  lore: ['Lore'],
  memory: ['Memory'],
  wait: ['Waiting', 'for the first token'],
  think: ['Thinking'],
  write: ['Writing'],
};

function Lanes({
  lanes,
  attempt,
  onOpenTool,
}: {
  lanes: Lane[];
  attempt: Attempt;
  onOpenTool: (tool: 'lorebooks' | 'memory') => void;
}) {
  const trace = attempt.trace;
  if (!trace) return null;
  const end = Math.max(1, trace.end);
  const pct = (ms: number) => (ms / end) * 100;
  const last = lanes.at(-1)?.id;
  const cut = trace.outcome === 'stopped' || trace.outcome === 'failed';
  const tokens = attempt.extra?.token_count;
  const rate =
    typeof tokens === 'number' && trace.writing !== undefined && trace.end > trace.writing
      ? Math.round(tokens / ((trace.end - trace.writing) / 1000))
      : null;

  const value = (lane: Lane) => {
    switch (lane.id) {
      case 'lore':
        return (
          <>
            {trace.lore?.fired ?? 0} fired ·{' '}
            <button type="button" onClick={() => onOpenTool('lorebooks')}>
              Lorebooks
            </button>
          </>
        );
      case 'memory':
        return (
          <>
            {trace.memory?.recalled ?? 0} recalled ·{' '}
            <button type="button" onClick={() => onOpenTool('memory')}>
              Memory
            </button>
          </>
        );
      case 'think':
        return trace.thinkingTokens
          ? `${seconds(lane.ms)} · ${trace.thinkingTokens.toLocaleString()} tokens`
          : seconds(lane.ms);
      case 'write':
        if (trace.outcome === 'stopped') return `${seconds(lane.ms)} · stopped by you`;
        return `${seconds(lane.ms)}${typeof tokens === 'number' ? ` · ${tokens.toLocaleString()} tokens` : ''}${rate ? ` · ${rate}/s` : ''}`;
      default:
        return seconds(lane.ms);
    }
  };

  return (
    <div className="w3-ins__lanes">
      <div className="w3-ins__lane" aria-hidden>
        <span />
        <span className="w3-ins__ticks">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f} style={{ left: `${f * 100}%` }}>
              {seconds(end * f)}
            </span>
          ))}
        </span>
      </div>
      {lanes.map((lane) => {
        const [name, small] = LANE_NAMES[lane.id];
        const right = pct(lane.start + lane.ms) > 62;
        return (
          <div
            key={lane.id}
            className="w3-ins__lane"
            data-sub={lane.id === 'lore' || lane.id === 'memory' || undefined}
          >
            <span className="w3-ins__lanename">
              {name}
              {small ? <small>{small}</small> : null}
            </span>
            <span className="w3-ins__track">
              <i
                data-phase={lane.id}
                data-cut={(cut && lane.id === last) || undefined}
                style={{ left: `${pct(lane.start)}%`, width: `${pct(lane.ms)}%` }}
              />
              <span
                className="w3-ins__val"
                style={
                  right
                    ? { right: `calc(${100 - pct(lane.start)}% + 8px)` }
                    : { left: `calc(${pct(lane.start + lane.ms)}% + 8px)` }
                }
              >
                {value(lane)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Facts({ attempt }: { attempt: Attempt }) {
  const extra = attempt.extra;
  const inspection = attempt.inspection;
  const model =
    (typeof extra?.model === 'string' ? extra.model : undefined) ??
    (typeof inspection?.body?.model === 'string' ? inspection.body.model : undefined);
  const sent =
    typeof extra?.prompt_tokens === 'number'
      ? extra.prompt_tokens.toLocaleString()
      : inspection
        ? `~${inspection.totalTokens.toLocaleString()}`
        : null;
  const cached = attempt.trace?.cachedTokens;
  const written =
    typeof extra?.token_count === 'number'
      ? `${extra.usage_reported ? '' : '~'}${extra.token_count.toLocaleString()}`
      : null;
  const thinking = attempt.trace?.thinkingTokens;
  const cells: [string, string, string?][] = [];
  if (model) cells.push([model.split('/').at(-1) ?? model, 'Model', model]);
  if (sent) cells.push([sent, cached ? `Sent · ${cached.toLocaleString()} cached` : 'Sent']);
  if (written) cells.push([written, 'Written']);
  if (thinking) cells.push([thinking.toLocaleString(), 'Thinking']);
  if (!cells.length) return null;
  return (
    <div className="w3-ins__facts">
      {cells.map(([value, name, title]) => (
        <div key={name} title={title}>
          <b>{value}</b>
          <span>{name}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- The prompt ----------

function Prompt({
  attempt,
  inspections,
  names,
  countText,
  traced,
}: {
  attempt: Attempt;
  inspections: readonly PromptInspection[];
  names: Names;
  countText: (text: string) => number;
  traced: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const inspection = attempt.inspection;

  const blocks = useMemo(
    () => (inspection ? promptBlocks(inspection, names) : []),
    [inspection, names],
  );
  const before = inspection ? previousInspection(inspections, inspection) : null;
  const diff = useMemo(
    () => (inspection && before ? promptDiff(before, inspection, names) : null),
    [inspection, before, names],
  );

  if (!inspection) {
    if (!traced) return null;
    return (
      <div className="w3-ins__prompt">
        <span className="w3-ins__label">What was sent</span>
        <div className="w3-ins__note" data-box>
          <b>Prompt not kept</b>
          Only the last {KEPT_PROMPTS} replies of this session keep the prompt they sent. Its
          timeline is kept for good.
        </div>
      </div>
    );
  }

  const copy = () => {
    const text = raw
      ? JSON.stringify(inspection.body ?? inspection.messages, null, 2)
      : inspection.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  };

  return (
    <>
      {diff?.changes.length ? (
        <div className="w3-ins__diff">
          <span className="w3-ins__label">Since the one before</span>
          {diff.changes.map((change) => (
            <span
              key={`${change.sign}${change.text}`}
              className="w3-ins__change"
              data-sign={change.sign}
            >
              <b>{change.sign === '-' ? '−' : change.sign}</b>
              {change.text}
            </span>
          ))}
        </div>
      ) : null}
      <div className="w3-ins__prompt">
        <div className="w3-ins__promptbar">
          <span className="w3-ins__label">
            What was sent · ~{inspection.totalTokens.toLocaleString()} tokens
          </span>
          <div className="w3-ins__toggle">
            <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
              Blocks
            </button>
            <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
              Raw
            </button>
          </div>
          <button type="button" className="w3-ins__copy" onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} size="sm" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {inspection.overflow ? (
          <div className="w3-ins__note" data-box data-bad>
            <b>It didn’t fit</b>
            The prompt needed {inspection.overflow.requiredPromptTokens.toLocaleString()} tokens
            before any chat history, {inspection.overflow.overBy.toLocaleString()} over the limit,
            so nothing was sent.
          </div>
        ) : null}
        {raw ? (
          <pre className="w3-ins__raw">
            {JSON.stringify(inspection.body ?? { messages: inspection.messages }, null, 2)}
          </pre>
        ) : (
          <Blocks
            blocks={blocks}
            dropped={inspection.droppedMessages}
            marks={diff?.marks}
            gone={diff?.gone ?? []}
            names={names}
            countText={countText}
          />
        )}
      </div>
    </>
  );
}

function tokensOf(messages: readonly ApiMessage[], countText: (text: string) => number): number {
  return messages.reduce((sum, message) => sum + countText(message.content), 0);
}

function Blocks({
  blocks,
  dropped,
  marks,
  gone,
  names,
  countText,
}: {
  blocks: Block[];
  dropped: number;
  marks?: Map<string, 'new' | 'edited'>;
  gone: Block[];
  names: Names;
  countText: (text: string) => number;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const firstHistory = blocks.findIndex((block) => block.history);

  return (
    <ul className="w3-ins__blocks">
      {blocks.map((block, index) => {
        const isOpen = open.has(block.key);
        const mark = marks?.get(block.id);
        return (
          <Fragment key={block.key}>
            {index === firstHistory && dropped > 0 ? (
              <li className="w3-ins__dropped">
                {dropped} older {dropped === 1 ? 'message' : 'messages'} didn’t fit and weren’t sent
              </li>
            ) : null}
            <li className="w3-ins__block" data-open={isOpen || undefined}>
              <button
                type="button"
                className="w3-ins__blockhead"
                aria-expanded={isOpen}
                onClick={() => toggle(block.key)}
              >
                <i data-source={block.source} />
                <span className="w3-ins__role">{block.role}</span>
                <span className="w3-ins__blockname">
                  <b>{block.name}</b>
                  {block.history || block.messages.length > 1 ? (
                    <span>{block.messages.length} messages</span>
                  ) : (
                    <span>{preview(block.messages[0]?.content ?? '')}</span>
                  )}
                  {mark ? <em data-mark={mark}>{mark}</em> : null}
                </span>
                <span className="w3-ins__tok">
                  {tokensOf(block.messages, countText).toLocaleString()}
                </span>
                <span className="w3-ins__chev">
                  <Icon name="chevronDown" size="xs" />
                </span>
              </button>
              {isOpen ? (
                <div className="w3-ins__blockbody">
                  {block.history ? (
                    <History block={block} names={names} countText={countText} />
                  ) : (
                    block.messages.map((message, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a block's messages never reorder
                      <pre key={i}>{message.content}</pre>
                    ))
                  )}
                </div>
              ) : null}
            </li>
          </Fragment>
        );
      })}
      {gone.map((block) => (
        <li key={`gone:${block.key}`} className="w3-ins__block" data-gone>
          <div className="w3-ins__blockhead">
            <i data-source={block.source} />
            <span className="w3-ins__role" />
            <span className="w3-ins__blockname">
              <b>{block.name}</b>
              <span>not sent this time</span>
              <em data-mark="gone">gone</em>
            </span>
            <span />
            <span />
          </div>
        </li>
      ))}
    </ul>
  );
}

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

/** How many of a long history show before "Show all": the newest ones. */
const HISTORY_SHOWN = 8;

function History({
  block,
  names,
  countText,
}: {
  block: Block;
  names: Names;
  countText: (text: string) => number;
}) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const messages = block.messages;
  const start = all ? 0 : Math.max(0, messages.length - HISTORY_SHOWN);
  const speaker = (message: ApiMessage) =>
    message.role === 'user'
      ? (names.persona ?? 'You')
      : message.role === 'assistant'
        ? names.char
        : 'system';
  return (
    <div className="w3-ins__history">
      {start > 0 ? (
        <button type="button" className="w3-ins__more" onClick={() => setAll(true)}>
          Show the {start} before these
        </button>
      ) : null}
      {messages.slice(start).map((message, offset) => {
        const index = start + offset;
        const isOpen = open === index;
        return (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: a sent prompt never reorders
            key={index}
            type="button"
            className="w3-ins__msg"
            data-open={isOpen || undefined}
            onClick={() => setOpen(isOpen ? null : index)}
          >
            <b>{speaker(message)}</b>
            {isOpen ? <pre>{message.content}</pre> : <span>{preview(message.content)}</span>}
            <em>{countText(message.content).toLocaleString()}</em>
          </button>
        );
      })}
    </div>
  );
}
