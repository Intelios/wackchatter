import type { ApiMessage } from '@shared/types/chat.ts';
import { useMemo, useState } from 'react';
import { ChevronIcon } from '../../layout/icons.tsx';
import type { PromptInspection } from './state/chatReducer.ts';
import './PromptInspector.css';

/**
 * Messages longer than this start collapsed. The front of the prompt is dominated by
 * large standing blocks (system prompt, description, world info); folding those is what
 * makes the list scannable instead of one long scroll.
 */
const AUTO_COLLAPSE_CHARS = 400;
const PREVIEW_CHARS = 90;

function defaultExpanded(messages: ApiMessage[]): Set<number> {
  const open = new Set<number>();
  messages.forEach((message, index) => {
    if (message.content.length <= AUTO_COLLAPSE_CHARS) {
      open.add(index);
    }
  });
  return open;
}

/** First non-blank run of the content, flattened to one line and truncated. */
function previewOf(content: string): string {
  const start = content.search(/\S/);
  if (start === -1) {
    return '(empty)';
  }
  const flat = content
    .slice(start, start + PREVIEW_CHARS * 2)
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/**
 * The message list, owning its expand/collapse state.
 *
 * Keyed by the inspection timestamp at the call site, so each generation starts fresh —
 * a stale expansion set from a previous payload would index the wrong messages.
 */
function MessageList({ messages }: { messages: ApiMessage[] }) {
  // `null` means "use the size-based default"; any manual toggle materialises a set.
  const [override, setOverride] = useState<Set<number> | null>(null);
  const auto = useMemo(() => defaultExpanded(messages), [messages]);
  const expanded = override ?? auto;

  const toggle = (index: number) => {
    const next = new Set(expanded);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    setOverride(next);
  };

  return (
    <div className="inspector__list">
      <div className="inspector__list-tools">
        <button
          type="button"
          className="wc-button wc-button--ghost inspector__mini"
          onClick={() => setOverride(new Set(messages.map((_, i) => i)))}
        >
          Expand all
        </button>
        <button
          type="button"
          className="wc-button wc-button--ghost inspector__mini"
          onClick={() => setOverride(new Set())}
        >
          Collapse all
        </button>
      </div>

      <ol className="inspector__messages">
        {messages.map((message, index) => {
          const open = expanded.has(index);
          return (
            // Index is the identity here: this is an immutable snapshot, never reordered.
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: snapshot, never reordered
              key={index}
              className="inspector__message"
              data-role={message.role}
              data-open={open}
            >
              <button
                type="button"
                className="inspector__head"
                aria-expanded={open}
                onClick={() => toggle(index)}
              >
                <ChevronIcon className="inspector__chevron" />
                <span className="inspector__index">{index + 1}</span>
                <span className="inspector__role">{message.role}</span>
                {message.name ? <span className="inspector__name">{message.name}</span> : null}
                {open ? null : (
                  <span className="inspector__preview">{previewOf(message.content)}</span>
                )}
                <span className="inspector__chars">
                  {message.content.length.toLocaleString()} ch
                </span>
              </button>
              {open ? <pre className="inspector__content">{message.content}</pre> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * What was actually sent.
 *
 * Because the browser assembles the prompt and posts the object it built verbatim,
 * `inspection.body` IS the wire payload — nothing here is reconstructed or approximated.
 * That is the whole reason assembly stayed client-side.
 */
export function PromptInspector({ inspection }: { inspection: PromptInspection | null }) {
  const [view, setView] = useState<'messages' | 'body'>('messages');

  if (!inspection) {
    return <div className="wc-empty">Nothing sent yet.</div>;
  }

  return (
    <div className="inspector">
      <div className="inspector__summary">
        <span>{inspection.generationType}</span>
        <span>{inspection.messages.length} messages</span>
        <span>{inspection.totalTokens} tokens</span>
        {inspection.overflow ? (
          <span className="inspector__warn" title="Mandatory prompt content exceeds context">
            overflow
          </span>
        ) : null}
        {inspection.droppedMessages > 0 ? (
          <span className="inspector__warn" title="Oldest messages did not fit the budget">
            {inspection.droppedMessages} dropped
          </span>
        ) : null}
        {inspection.macroWarnings.length > 0 ? (
          <span className="inspector__warn">
            {inspection.macroWarnings.length} unresolved macro
            {inspection.macroWarnings.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {inspection.macroWarnings.length > 0 ? (
        <details className="inspector__warnings">
          <summary>Unresolved macros</summary>
          <ul>
            {inspection.macroWarnings.map((warning) => (
              <li key={`${warning.source}:${warning.macro}`}>
                <code>{warning.macro}</code> in {warning.source}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="inspector__tabs">
        <button
          type="button"
          className="wc-button wc-button--ghost"
          aria-pressed={view === 'messages'}
          onClick={() => setView('messages')}
        >
          Messages
        </button>
        <button
          type="button"
          className="wc-button wc-button--ghost"
          aria-pressed={view === 'body'}
          onClick={() => setView('body')}
        >
          Raw body
        </button>
      </div>

      {view === 'messages' ? (
        // Keyed so a fresh generation resets the expansion state.
        <MessageList key={inspection.at} messages={inspection.messages} />
      ) : (
        <pre className="inspector__json">{JSON.stringify(inspection.body, null, 2)}</pre>
      )}
    </div>
  );
}
