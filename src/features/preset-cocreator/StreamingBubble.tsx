import { Reasoning } from '../chat/Reasoning.tsx';
import '../chat/MessageBubble.css';
import '../chat/Composer.css';

/**
 * The working bubble both conversations show while a reply streams.
 *
 * It reuses the main chat's bubble classes and its Reasoning box, and adds the one thing
 * the main chat keeps on its composer: the lime scan light patrolling the border while
 * the model works. A turn that is between provider requests (a tool executing) has no
 * text to show, so the ring plus a quiet status word is what says "still going".
 */
export function StreamingBubble({
  name,
  initial,
  reasoning,
  text,
  note,
}: {
  name: string;
  initial: string;
  reasoning: string;
  text: string;
  /** The status word shown before the first token arrives. */
  note: string;
}) {
  return (
    <article className="message preset-cc-streaming" data-role="assistant">
      <div className="message__bubble">
        <header className="message__head">
          <div className="message__avatar">
            <span aria-hidden="true">{initial.slice(0, 1).toUpperCase()}</span>
          </div>
          <div className="message__ident">
            <span className="message__name">{name}</span>
            <span className="message__stream-note" role="status">
              {text || reasoning ? 'responding' : note}
            </span>
          </div>
        </header>
        {reasoning ? <Reasoning text={reasoning} defaultOpen /> : null}
        <div className="message__text message__text--streaming">
          {text}
          <span className="message__caret" aria-hidden="true" />
        </div>
      </div>
    </article>
  );
}
