import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover } from '../components/Popover.tsx';
import type { CocreatorContext } from '../features/cocreator/context.ts';
import { Switch } from './controls.tsx';
import './contextRing.css';

const number = (value: number) => Math.round(value).toLocaleString();

/** One readout for the conversation that will make the next request. Opening it never generates. */
export function ContextRing({
  context,
  onCompact,
  onAutomatic,
  onStop,
}: {
  context: CocreatorContext;
  onCompact: () => void;
  onAutomatic: (automatic: boolean) => void;
  onStop: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const dismissedFocus = useRef(false);
  const root = useRef<HTMLFieldSetElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const changeOpen = useCallback((next: boolean) => {
    clearTimeout(timer.current);
    if (!next) {
      pinned.current = false;
      dismissedFocus.current = true;
    }
    setOpen(next);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const percent = context.total ? Math.round((context.used / context.total) * 100) : 0;
  const progress = Math.min(100, Math.max(0, percent));
  const until = Math.max(0, Math.floor(context.promptBudget * 0.8 - context.used));
  const history = Math.max(0, context.used - context.fixed - context.summary);
  const checkpoint = context.checkpoint;

  return (
    <fieldset
      className="w3-context"
      aria-label="Conversation context"
      ref={root}
      onPointerEnter={() => {
        clearTimeout(timer.current);
        dismissedFocus.current = false;
        setOpen(true);
      }}
      onPointerLeave={() => {
        const delay = Number.parseFloat(
          getComputedStyle(root.current!).getPropertyValue('--wc-context-hover-delay'),
        );
        timer.current = setTimeout(() => {
          if (!pinned.current && !root.current?.contains(document.activeElement)) setOpen(false);
        }, delay);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !pinned.current)
          changeOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          changeOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <Popover
        label={`${context.label} context: ${percent}% used`}
        icon={null}
        open={open}
        onOpenChange={changeOpen}
        placement="bottom-end"
        popupClassName="w3-context-panel"
        renderTrigger={(props) => (
          <button
            {...props}
            className="w3-context-ring"
            type="button"
            data-tone={
              context.used > context.promptBudget ? 'bad' : until === 0 ? 'near' : undefined
            }
            data-compacting={context.compacting || undefined}
            onFocus={() => {
              if (dismissedFocus.current) dismissedFocus.current = false;
              else setOpen(true);
            }}
            onClick={() => {
              if (pinned.current && open) changeOpen(false);
              else {
                pinned.current = true;
                setOpen(true);
              }
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle className="w3-context-ring__track" cx="12" cy="12" r="9" />
              <circle
                className="w3-context-ring__fill"
                cx="12"
                cy="12"
                r="9"
                pathLength="100"
                strokeDasharray={`${progress} ${100 - progress}`}
                transform="rotate(-90 12 12)"
              />
              <circle className="w3-context-ring__dot" cx="12" cy="12" r="1.5" />
            </svg>
          </button>
        )}
      >
        <header className="w3-context-panel__head">
          <span>
            {context.label}
            <small title={context.model ?? undefined}>
              {context.model?.split('/').pop() ?? 'Choose a model'}
            </small>
          </span>
          <b>
            {percent}
            <small>%</small>
          </b>
        </header>
        <p className="w3-context-panel__meter">
          ~{number(context.used)} / {number(context.total)} tokens
          {context.assumed ? ' · assumed window' : ''}
        </p>
        <dl className="w3-context-panel__breakdown">
          <div>
            <dt>Instructions, card or preset, examples</dt>
            <dd>~{number(context.fixed)}</dd>
          </div>
          <div>
            <dt>Earlier conversation summary</dt>
            <dd>~{number(context.summary)}</dd>
          </div>
          <div>
            <dt>Conversation and tools</dt>
            <dd>~{number(history)}</dd>
          </div>
          <div>
            <dt>Reply and thinking reserve</dt>
            <dd>{number(context.reserved)}</dd>
          </div>
        </dl>
        <div className="w3-context-panel__auto">
          <span>
            Auto-compact
            <small>
              {until ? `~${number(until)} tokens until the threshold` : 'Threshold reached'} · 80%
              of available input
            </small>
          </span>
          <Switch
            on={context.automatic}
            label="Auto-compact this conversation"
            onChange={onAutomatic}
          />
        </div>
        <p className="w3-context-panel__hint">
          Estimates include the saved conversation and fixed context. Compaction uses this model,
          keeps recent exchanges verbatim and preserves the full transcript.
        </p>
        <button
          type="button"
          className="w3-st-primary"
          disabled={!context.compacting && Boolean(context.disabledReason)}
          title={
            context.compacting
              ? 'Stop compaction'
              : (context.disabledReason ?? 'Summarize earlier conversation with this model')
          }
          onClick={context.compacting ? onStop : onCompact}
        >
          {context.compacting ? 'Stop compacting' : 'Compact now'}
        </button>
        {context.compacting ? (
          <p className="w3-context-panel__hint" role="status">
            Compacting with {context.model?.split('/').pop()}…
          </p>
        ) : context.disabledReason ? (
          <p className="w3-context-panel__hint">{context.disabledReason}</p>
        ) : null}
        {checkpoint?.checkpoint ? (
          <details className="w3-context-panel__summary">
            <summary>
              Current summary
              {checkpoint.afterTokens !== undefined
                ? ` · ${number(checkpoint.beforeTokens)} → ${number(checkpoint.afterTokens)}`
                : ''}
            </summary>
            <div>
              <p>{checkpoint.checkpoint.summary}</p>
              <b>The user’s own words</b>
              {checkpoint.checkpoint.quotedUserMessages.map((quote, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: immutable quotations can contain identical user text; this list never reorders.
                <blockquote key={`${index}:${quote}`}>{quote}</blockquote>
              ))}
            </div>
          </details>
        ) : null}
      </Popover>
    </fieldset>
  );
}
