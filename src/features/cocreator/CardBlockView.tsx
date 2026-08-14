import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardSlot } from '@shared/types/cocreator.ts';
import { Markdown } from '../chat/Markdown.tsx';
import type { CardBlock } from './blocks.ts';
import { SLOT_LABELS } from './blocks.ts';
import { UseAsMenu } from './UseAsMenu.tsx';

interface CardBlockViewProps {
  block: CardBlock;
  busy: boolean;
  countTokens: TokenCounter;
  isFilled: (slot: CardSlot) => boolean;
  onUse: (slot: CardSlot, text: string) => void;
}

/**
 * One labelled block of card content, inside a reply.
 *
 * The block's text goes back through `Markdown` rather than being shown as code, which is
 * the whole reason the parser splits the message itself instead of letting react-markdown
 * see a `card:` fence: this is prose the user is about to put in a card, and it should read
 * like it. The fence lines were consumed by the parser and appear nowhere.
 */
export function CardBlockView({ block, busy, countTokens, isFilled, onUse }: CardBlockViewProps) {
  const known = block.slot !== null;
  const label = known ? SLOT_LABELS[block.slot as CardSlot] : block.label;

  return (
    <section
      className="card-block"
      data-slot={block.slot ?? 'unknown'}
      data-unknown={!known || undefined}
    >
      <header className="card-block__header">
        <span className="card-block__label">{label}</span>
        {!known ? (
          <span
            className="card-block__hint"
            title="The model used a label we do not recognise. Pick the field yourself."
          >
            unrecognised label
          </span>
        ) : null}
        {!block.closed ? (
          <span className="card-block__hint" title="The closing fence never arrived.">
            incomplete
          </span>
        ) : null}
        <span className="card-block__tokens">{countTokens.countText(block.text)} tok</span>
        <UseAsMenu
          slot={block.slot}
          getText={() => block.text}
          label="Use as"
          busy={busy}
          isFilled={isFilled}
          onUse={onUse}
        />
      </header>
      <div className="card-block__body">
        <Markdown text={block.text} />
      </div>
    </section>
  );
}
