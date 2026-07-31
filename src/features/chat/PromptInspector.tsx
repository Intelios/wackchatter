import { useState } from 'react';
import type { PromptInspection } from './state/chatReducer.ts';
import './PromptInspector.css';

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
        {inspection.droppedMessages > 0 ? (
          <span className="inspector__warn" title="Oldest messages did not fit the budget">
            {inspection.droppedMessages} dropped
          </span>
        ) : null}
      </div>

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
        <ol className="inspector__messages">
          {inspection.messages.map((message, index) => (
            // Index is the identity here: this is an immutable snapshot, never reordered.
            // biome-ignore lint/suspicious/noArrayIndexKey: snapshot, never reordered
            <li key={index} className="inspector__message" data-role={message.role}>
              <div className="inspector__role">
                {message.role}
                {message.name ? <span className="inspector__name">{message.name}</span> : null}
              </div>
              <pre className="inspector__content">{message.content}</pre>
            </li>
          ))}
        </ol>
      ) : (
        <pre className="inspector__json">{JSON.stringify(inspection.body, null, 2)}</pre>
      )}
    </div>
  );
}
