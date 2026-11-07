/**
 * The Memory tool: the open chat's story memory. For the classic summary, the memory is the
 * page: a coverage strip and its buttons above, the text in its sections (each editable),
 * earlier versions, then the summary's settings folded away. Nexus gets a compact frame
 * that opens its own explorer; Off shows only the default for new chats.
 */

import { NEXUS_PROMPT, type NexusSettings } from '@shared/nexus/types.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
import type { ReasoningEffort } from '@shared/types/preset.ts';
import {
  DEFAULT_SUMMARY_PROMPT,
  type MemoryMode,
  type StoryMemoryPlacement,
  type SummaryPosition,
  type SummarySettings,
} from '@shared/types/settings.ts';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AppController } from '../app/useAppController.ts';
import { toChatMessages } from '../features/chat/state/chatReducer.ts';
import { ModelPicker } from '../features/models/ModelPicker.tsx';
import { nexusCounts } from '../features/nexus/summaryLine.ts';
import { Group, Range, Row, Segments, Switch, useArm } from './controls.tsx';
import { Icon } from './icons.tsx';
import {
  changeKey,
  inlineParts,
  kTokens,
  type LineChange,
  type MemoryCoverage,
  memoryChanges,
  memoryCoverage,
  memorySections,
  sectionLines,
  type TickState,
  whenWritten,
  withSection,
} from './memory.ts';
import './memory.css';

const MODES: [MemoryMode, string][] = [
  ['classic', 'Summary'],
  ['nexus', 'Nexus'],
  ['off', 'Off'],
];
const MODE_NAME: Record<MemoryMode, string> = { classic: 'Summary', nexus: 'Nexus', off: 'Off' };

export function MemoryTool({ controller }: { controller: AppController }) {
  const { chat, app } = controller;
  const prefs = app.view;
  const chatOpen = chat.state.chatId !== null;
  const mode = chat.memoryMode;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const fold = (id: string) => ({
    open: Boolean(open[id]),
    onToggle: () => setOpen((current) => ({ ...current, [id]: !current[id] })),
  });
  const patchSummary = (patch: Partial<SummarySettings>) =>
    void app.patchSettings({ summary: { ...prefs.summary, ...patch } });
  const patchNexus = (patch: Partial<NexusSettings>) =>
    void app.patchSettings({ nexus: { ...prefs.nexus, ...patch } });

  if (controller.memoryPrompt) {
    return (
      <PromptEditor
        prompt={prefs.summary.prompt}
        onSave={(prompt) => patchSummary({ prompt })}
        onClose={() => controller.setMemoryPrompt(false)}
      />
    );
  }

  const newChats = (
    <Fold label="New chats" summary={MODE_NAME[prefs.memoryMode]} {...fold('new')}>
      <Row title="New chats start with">
        <Segments
          label="Memory for new chats"
          value={prefs.memoryMode}
          options={MODES}
          onChange={(memoryMode) => void app.patchSettings({ memoryMode })}
        />
      </Row>
    </Fold>
  );

  return (
    <div className="w3-mem">
      <Segments
        label="Story memory for this chat"
        value={mode}
        options={MODES}
        disabled={!chatOpen}
        title={chatOpen ? undefined : 'Open a chat to choose its memory'}
        onChange={(next) => chat.nexus.setMode(next)}
      />
      {chatOpen && mode === 'classic' ? (
        <SummaryView controller={controller} />
      ) : chatOpen && mode === 'nexus' ? (
        <NexusView controller={controller} />
      ) : null}
      <div>
        {mode === 'classic' ? (
          <>
            <Fold
              label="Rhythm"
              summary={`${prefs.summary.auto ? `every ${prefs.summary.autoAfter}` : 'by hand'} · ${
                prefs.summary.hideCovered ? `keeps ${prefs.summary.keepMessages}` : 'hides nothing'
              }`}
              {...fold('rhythm')}
            >
              <Rhythm settings={prefs.summary} onChange={patchSummary} />
            </Fold>
            <Fold
              label="How it writes"
              summary={`${prefs.summary.targetWords} words · temp ${prefs.summary.temperature}`}
              {...fold('writes')}
            >
              <Writes controller={controller} settings={prefs.summary} onChange={patchSummary} />
            </Fold>
            <Fold
              label="Where it goes"
              summary={placementSummary(prefs.summary)}
              {...fold('where')}
            >
              <Placement settings={prefs.summary} onChange={patchSummary} macro="summary" />
            </Fold>
          </>
        ) : mode === 'nexus' ? (
          <Fold label="Nexus settings" summary={nexusSummary(prefs.nexus)} {...fold('nexus')}>
            <NexusSettingsBody
              controller={controller}
              settings={prefs.nexus}
              onChange={patchNexus}
            />
          </Fold>
        ) : null}
        {newChats}
      </div>
    </div>
  );
}

// ---------- The summary ----------

function SummaryView({ controller }: { controller: AppController }) {
  const { chat, app } = controller;
  const status = chat.summaryStatus;
  const running = status.running;
  const summary = chat.state.metadata.summary;
  const text = summary?.text ?? '';
  const history = summary?.history ?? [];
  const blocked = app.models.summary.blockedReason;

  // Rebuilt only when the transcript changes, not on every chat state update.
  const transcript = chat.state.messages;
  const messages = useMemo(() => toChatMessages({ messages: transcript }), [transcript]);
  const coverage = useMemo(() => memoryCoverage(messages, summary), [messages, summary]);

  const [viewing, setViewing] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [fresh, setFresh] = useState(0);
  const arm = useArm();

  // A run that just finished lights up what it wrote.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && !status.error && status.processed) {
      setShowChanges(true);
      setFresh((n) => n + 1);
      setViewing(null);
    }
    wasRunning.current = running;
  }, [running, status.error, status.processed]);

  // A version that no longer exists (after a restore or undo) can't stay open.
  useEffect(() => {
    if (viewing !== null && !history[viewing]) setViewing(null);
  }, [viewing, history]);

  const before = history[0]?.text;
  const changes = useMemo(
    () => (before !== undefined ? memoryChanges(text, before) : new Map<string, LineChange>()),
    [text, before],
  );

  const pending = chat.summaryPending;
  const updateBlocked = !chat.state.chatId
    ? 'Open a chat first'
    : blocked
      ? blocked
      : chat.busy
        ? 'Wait for the reply to finish'
        : pending === 0
          ? 'Nothing new to fold in'
          : null;
  const rewriteBlocked = blocked ?? (chat.busy ? 'Wait for the reply to finish' : null);

  const shown = viewing !== null ? (history[viewing]?.text ?? '') : text;
  const sections = memorySections(shown);

  return (
    <>
      <Coverage
        coverage={coverage}
        messages={messages}
        memoryText={text}
        countTokens={app.countTokens}
      />
      <div className="w3-mem__acts">
        {running ? (
          <button
            type="button"
            className="w3-set__pill w3-mem__run"
            style={
              {
                '--p': `${status.total ? (status.processed / status.total) * 100 : 0}%`,
              } as CSSProperties
            }
            onClick={chat.cancelSummary}
          >
            <Icon name="stop" size="sm" />
            <span>Stop</span>
            <i>
              {status.processed} of {status.total}
            </i>
          </button>
        ) : (
          <button
            type="button"
            className="w3-set__pill"
            disabled={Boolean(updateBlocked)}
            title={
              updateBlocked ?? `Fold in ${pending} new ${pending === 1 ? 'message' : 'messages'}`
            }
            onClick={() => void chat.summarize(undefined, 'update')}
          >
            <Icon name="spark" size="sm" />
            <span>Update</span>
            {pending ? <i>{pending}</i> : null}
          </button>
        )}
        <button
          type="button"
          className="w3-set__ghost"
          disabled={running || Boolean(rewriteBlocked) || !messages.length}
          title={
            rewriteBlocked ??
            (coverage.changed
              ? `${coverage.changed} summarised ${coverage.changed === 1 ? 'message has' : 'messages have'} changed since. Rewrite reads everything again.`
              : 'Start over from the first message')
          }
          onClick={() => void chat.summarize(undefined, 'rewrite')}
        >
          <Icon name="refresh" size="sm" />
          Rewrite
        </button>
        <button
          type="button"
          className="w3-set__ghost"
          disabled={running || !chat.summaryCanUndo}
          title="Bring back the version before"
          onClick={chat.undoSummary}
        >
          <Icon name="restore" size="sm" />
          Undo
        </button>
        {history.length && viewing === null ? (
          <button
            type="button"
            className="w3-set__ghost w3-mem__changes"
            aria-pressed={showChanges}
            title="Light up what the last run added or changed"
            onClick={() => setShowChanges((on) => !on)}
          >
            Changes
          </button>
        ) : null}
      </div>
      {status.error ? (
        <p className="w3-mem__error" role="alert">
          {status.error}
        </p>
      ) : blocked ? (
        <p className="w3-mem__error" role="status">
          {blocked}
        </p>
      ) : null}

      {viewing !== null && history[viewing] ? (
        <div className="w3-mem__viewing">
          <span>
            {whenWritten(history[viewing]?.updatedAt, new Date())}
            <small>{coveredCount(history[viewing]?.covered)}</small>
          </span>
          <button
            type="button"
            className="w3-set__ghost"
            data-armed={arm.armed === 'restore' || undefined}
            disabled={running}
            onClick={() =>
              arm.press('restore', () => {
                chat.restoreSummary(viewing);
                setViewing(null);
              })
            }
            onBlur={arm.disarm}
          >
            {arm.armed === 'restore' ? 'Restore? Click again' : 'Restore'}
          </button>
          <button type="button" className="w3-set__ghost" onClick={() => setViewing(null)}>
            Back to now
          </button>
        </div>
      ) : null}

      <div
        key={fresh}
        className="w3-mem__doc"
        data-changes={(showChanges && viewing === null) || undefined}
        data-fresh={fresh > 0 || undefined}
        data-running={running || undefined}
      >
        {sections.length ? (
          sections.map((section, index) => (
            <Section
              // biome-ignore lint/suspicious/noArrayIndexKey: a section is its place; titles can repeat
              key={index}
              title={section.title}
              body={section.body}
              changes={viewing === null ? changes : null}
              editable={viewing === null && !running}
              editing={editing === index}
              onEdit={() => setEditing(index)}
              onCancel={() => setEditing(null)}
              onSave={(body) => {
                chat.editSummary(withSection(text, index, body));
                setEditing(null);
              }}
            />
          ))
        ) : (
          <p className="w3-mem__empty">No memory yet.</p>
        )}
      </div>

      {history.length ? (
        <Group label="Versions">
          <div className="w3-mem__versions">
            <button
              type="button"
              className="w3-mem__ver"
              data-now
              aria-pressed={viewing === null}
              onClick={() => setViewing(null)}
            >
              Now
              <small>{coveredCount(summary?.covered)}</small>
            </button>
            {history.map((version, index) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: versions are a stack; the place is the identity
                key={index}
                type="button"
                className="w3-mem__ver"
                aria-pressed={viewing === index}
                onClick={() => {
                  arm.disarm();
                  setEditing(null);
                  setViewing(index);
                }}
              >
                {whenWritten(version.updatedAt, new Date())}
                <small>{coveredCount(version.covered)}</small>
              </button>
            ))}
          </div>
        </Group>
      ) : null}
    </>
  );
}

function coveredCount(covered: readonly string[] | undefined): string {
  if (!covered) return '';
  return `${covered.length} ${covered.length === 1 ? 'message' : 'messages'}`;
}

/** One section of the memory: read, or edited on its own. */
function Section({
  title,
  body,
  changes,
  editable,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  title: string | null;
  body: string;
  changes: Map<string, LineChange> | null;
  editable: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const [draft, setDraft] = useState(body);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) return;
    setDraft(body);
    const node = area.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.style.height = `${node.scrollHeight + 2}px`;
  }, [editing, body]);

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave(draft);
    }
  };

  const lines = sectionLines(body);
  const heading = title ?? (editable ? 'Memory' : null);
  return (
    <section className="w3-mem__sec">
      {heading !== null ? (
        <h3 data-untitled={title === null || undefined}>
          {title ?? ''}
          {editable && !editing ? (
            <button
              type="button"
              className="w3-mem__edit"
              aria-label={title ? `Edit ${title}` : 'Edit the memory'}
              onClick={onEdit}
            >
              <Icon name="pencil" size="xs" />
            </button>
          ) : null}
        </h3>
      ) : null}
      {editing ? (
        <>
          <textarea
            ref={area}
            className="w3-mem__area"
            value={draft}
            spellCheck
            aria-label={title ?? 'Memory'}
            onChange={(event) => {
              setDraft(event.target.value);
              event.target.style.height = 'auto';
              event.target.style.height = `${event.target.scrollHeight + 2}px`;
            }}
            onKeyDown={onKey}
          />
          <div className="w3-mem__done">
            <button type="button" className="w3-set__ghost" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="w3-set__pill" onClick={() => onSave(draft)}>
              Done
            </button>
          </div>
        </>
      ) : (
        <Lines lines={lines} title={title} changes={changes} />
      )}
    </section>
  );
}

function Lines({
  lines,
  title,
  changes,
}: {
  lines: ReturnType<typeof sectionLines>;
  title: string | null;
  changes: Map<string, LineChange> | null;
}) {
  const blocks: ReactNode[] = [];
  let items: ReactNode[] = [];
  const flush = (key: number) => {
    if (items.length) blocks.push(<ul key={`u${key}`}>{items}</ul>);
    items = [];
  };
  lines.forEach((line, index) => {
    const change = changes?.get(changeKey(title, line.text));
    if (line.kind === 'item') {
      items.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat; the place is the identity
        <li key={index} data-change={change}>
          <Inline text={line.text} />
        </li>,
      );
    } else {
      flush(index);
      blocks.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat; the place is the identity
        <p key={index} data-change={change}>
          <Inline text={line.text} />
        </p>,
      );
    }
  });
  flush(lines.length);
  return <>{blocks}</>;
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) =>
        part.strong ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <strong key={index}>{part.text}</strong>
        ) : part.em ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <em key={index}>{part.text}</em>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

// ---------- Coverage ----------

const TICK_WORDS: Record<TickState, string> = {
  in: 'in memory',
  hidden: 'in memory, hidden',
  changed: 'changed since',
  new: 'new',
  out: 'left out',
};

function Coverage({
  coverage,
  messages,
  memoryText,
  countTokens,
}: {
  coverage: MemoryCoverage;
  messages: readonly ChatMessage[];
  memoryText: string;
  countTokens: TokenCounter;
}) {
  const [hover, setHover] = useState<{ index: number; x: number; right: boolean } | null>(null);
  const memoryTokens = useMemo(
    () => (memoryText.trim() ? countTokens.countText(memoryText) : 0),
    [memoryText, countTokens],
  );
  const savedTokens = useMemo(() => {
    let sum = 0;
    coverage.states.forEach((state, index) => {
      if (state === 'hidden') sum += countTokens.countText(messages[index]?.mes ?? '');
    });
    return sum;
  }, [coverage.states, messages, countTokens]);

  if (!coverage.total) return null;
  const hovered = hover ? messages[hover.index] : null;
  return (
    <div className="w3-mem__cov">
      <div className="w3-mem__counts">
        <span data-s="in">
          <b>{coverage.inMemory}</b> in memory
        </span>
        {coverage.fresh ? (
          <span data-s="new">
            <b>{coverage.fresh}</b> new
          </span>
        ) : null}
        {coverage.changed ? (
          <span data-s="changed">
            <b>{coverage.changed}</b> changed
          </span>
        ) : null}
        {coverage.hidden ? (
          <span data-s="hidden">
            <b>{coverage.hidden}</b> hidden
          </span>
        ) : null}
      </div>
      <div
        className="w3-mem__strip"
        aria-hidden="true"
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const x = Math.min(box.width - 1, Math.max(0, event.clientX - box.left));
          setHover({
            index: Math.floor((x / box.width) * coverage.total),
            x,
            right: x > box.width / 2,
          });
        }}
        onPointerLeave={() => setHover(null)}
      >
        {coverage.runs.map((run) => (
          <i key={run.start} data-s={run.state} style={{ flexGrow: run.length }} />
        ))}
        {coverage.cut ? (
          <span
            className="w3-mem__cut"
            style={{ left: `${(coverage.cut / coverage.total) * 100}%` }}
          />
        ) : null}
        {hover && hovered ? (
          <span
            className="w3-mem__tip"
            data-right={hover.right || undefined}
            style={{ left: hover.x }}
          >
            <b>
              #{hover.index + 1} · {TICK_WORDS[coverage.states[hover.index] ?? 'out']}
            </b>
            {hovered.name}: {snippet(hovered.mes)}
          </span>
        ) : null}
      </div>
      <div className="w3-mem__cost">
        Memory {kTokens(memoryTokens)} tokens
        {savedTokens ? ` · hiding saves ${kTokens(savedTokens)}` : ''}
      </div>
    </div>
  );
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 88)}…` : flat || '(empty)';
}

// ---------- Settings ----------

function Fold({
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  label: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="w3-mem__fold" data-open={open || undefined}>
      <button type="button" aria-expanded={open} onClick={onToggle}>
        <span>{label}</span>
        <small>{summary}</small>
        <Icon name="chevronDown" size="sm" />
      </button>
      {open ? <div className="w3-mem__foldbody">{children}</div> : null}
    </div>
  );
}

/** A whole number typed in place, kept on blur or Enter and held to its range. */
function NumberInput({
  value,
  min,
  max,
  label,
  wide,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  wide?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number.parseInt(draft.replace(/[^\d]/g, ''), 10);
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <input
      className="w3-mem__num"
      data-wide={wide || undefined}
      inputMode="numeric"
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}

function Rhythm({
  settings,
  onChange,
}: {
  settings: SummarySettings;
  onChange: (patch: Partial<SummarySettings>) => void;
}) {
  return (
    <>
      <Row title="Update by itself" hint="After a reply, once this many are new">
        <span className="w3-mem__ctl" data-off={!settings.auto || undefined}>
          every
          <NumberInput
            label="New messages before it updates"
            value={settings.autoAfter}
            min={1}
            max={10_000}
            onChange={(autoAfter) => onChange({ autoAfter })}
          />
          <Switch
            on={settings.auto}
            label="Update by itself"
            onChange={(auto) => onChange({ auto })}
          />
        </span>
      </Row>
      <Row title="Hide what’s in memory" hint="Hidden messages leave the prompt">
        <Switch
          on={settings.hideCovered}
          label="Hide what’s in memory"
          onChange={(hideCovered) => onChange({ hideCovered })}
        />
      </Row>
      {settings.hideCovered ? (
        <Row title="Keep the newest">
          <span className="w3-mem__ctl">
            <NumberInput
              label="Messages kept in the prompt"
              value={settings.keepMessages}
              min={0}
              max={100_000}
              wide
              onChange={(keepMessages) => onChange({ keepMessages })}
            />
            messages
          </span>
        </Row>
      ) : null}
    </>
  );
}

function Writes({
  controller,
  settings,
  onChange,
}: {
  controller: AppController;
  settings: SummarySettings;
  onChange: (patch: Partial<SummarySettings>) => void;
}) {
  const { app } = controller;
  return (
    <>
      <Row title="Model">
        <span className="w3-mem__picker">
          <ModelPicker
            label="Summary model"
            value={app.models.slots.summary}
            onChange={(ref) => app.setModelSlot('summary', ref)}
            emptyLabel="Same as chat"
            emptyFollows={app.models.slots.chat}
            disabled={controller.chat.summaryStatus.running}
            disabledReason="Wait for the summary to finish."
          />
        </span>
      </Row>
      <Row title="Length" hint="A target; models run a little over">
        <span className="w3-mem__ctl">
          <NumberInput
            label="Target length in words"
            value={settings.targetWords}
            min={25}
            max={3000}
            wide
            onChange={(targetWords) => onChange({ targetWords: Math.round(targetWords / 25) * 25 })}
          />
          words
        </span>
      </Row>
      <Range
        label="Temp"
        value={settings.temperature}
        min={0}
        max={2}
        step={0.05}
        shown={settings.temperature.toFixed(2)}
        onChange={(temperature) => onChange({ temperature })}
      />
      <Range
        label="Top-p"
        value={settings.topP}
        min={0}
        max={1}
        step={0.01}
        shown={settings.topP.toFixed(2)}
        onChange={(topP) => onChange({ topP })}
      />
      <div className="w3-mem__promptrow">
        <p>{settings.prompt.split('\n').find((line) => line.trim()) ?? 'No prompt'}</p>
        <button
          type="button"
          className="w3-set__ghost"
          onClick={() => controller.setMemoryPrompt(true)}
        >
          <Icon name="pencil" size="xs" />
          Edit prompt
        </button>
      </div>
    </>
  );
}

const POSITIONS: [SummaryPosition, string][] = [
  ['beforeMain', 'Before main'],
  ['afterMain', 'After main'],
  ['atDepth', 'In chat'],
  ['none', 'Nowhere'],
];
const ROLES: ['system' | 'user' | 'assistant', string][] = [
  ['system', 'System'],
  ['user', 'User'],
  ['assistant', 'Assistant'],
];

function placementSummary(settings: StoryMemoryPlacement): string {
  if (settings.position === 'none') return 'not sent';
  const where =
    settings.position === 'atDepth'
      ? `in chat · depth ${settings.depth}`
      : settings.position === 'beforeMain'
        ? 'before main'
        : 'after main';
  return `${where} · ${settings.role}`;
}

/** How a memory is wrapped and where it lands, for the summary and Nexus alike. */
function Placement<T extends StoryMemoryPlacement>({
  settings,
  onChange,
  macro,
}: {
  settings: T;
  onChange: (patch: Partial<StoryMemoryPlacement>) => void;
  macro: 'summary' | 'memories';
}) {
  const [template, setTemplate] = useState(settings.template);
  useEffect(() => setTemplate(settings.template), [settings.template]);
  return (
    <>
      <Group label="Template" aside={`{{${macro}}}`}>
        <input
          className="w3-mem__text"
          aria-label="Template"
          value={template}
          onChange={(event) => setTemplate(event.target.value)}
          onBlur={() => {
            if (template !== settings.template) onChange({ template });
          }}
        />
      </Group>
      <Row title="Position">
        <Segments
          label="Position"
          value={settings.position}
          options={POSITIONS}
          onChange={(position) => onChange({ position })}
        />
      </Row>
      {settings.position === 'atDepth' ? (
        <Row title="Depth" hint="Messages back from the end">
          <NumberInput
            label="Depth"
            value={settings.depth}
            min={0}
            max={10_000}
            onChange={(depth) => onChange({ depth })}
          />
        </Row>
      ) : null}
      <Row title="Role">
        <Segments
          label="Role"
          value={settings.role}
          options={ROLES}
          onChange={(role) => onChange({ role })}
        />
      </Row>
    </>
  );
}

// ---------- The prompt, wide ----------

function PromptEditor({
  prompt,
  onSave,
  onClose,
}: {
  prompt: string;
  onSave: (prompt: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(prompt);
  const save = (next = draft) => {
    if (next !== prompt) onSave(next);
  };
  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;
  return (
    <div className="w3-mem__editor">
      <div className="w3-mem__edhead">
        <h3>Summary prompt</h3>
        <button
          type="button"
          className="w3-set__ghost"
          disabled={draft === DEFAULT_SUMMARY_PROMPT}
          onClick={() => {
            setDraft(DEFAULT_SUMMARY_PROMPT);
            save(DEFAULT_SUMMARY_PROMPT);
          }}
        >
          <Icon name="restore" size="xs" />
          Default
        </button>
        <button
          type="button"
          className="w3-set__pill"
          onClick={() => {
            save();
            onClose();
          }}
        >
          Done
        </button>
      </div>
      <textarea
        className="w3-mem__prompt"
        aria-label="Summary prompt"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => save()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            save();
            onClose();
          }
        }}
      />
      <div className="w3-mem__edfoot">
        <span>
          {'{{words}}'} · {'{{char}}'} · {'{{user}}'}
        </span>
        {words} words
      </div>
    </div>
  );
}

// ---------- Nexus ----------

function NexusView({ controller }: { controller: AppController }) {
  const { chat, app } = controller;
  const n = chat.nexus;
  const counts = useMemo(() => nexusCounts(n.data), [n.data]);
  const blocked = app.models.nexus.blockedReason;
  const interval = app.view.nexus.autoInterval;
  const line = n.run.running
    ? `${n.run.kind === 'collection' ? 'Remembering' : 'Searching'}… ${n.run.processed} of ${n.run.total}`
    : [
        n.data.paused ? 'Paused' : interval ? `Collects every ${interval}` : 'Collects by hand',
        `${n.pending} waiting`,
      ].join(' · ');
  return (
    <>
      <div className="w3-mem__stats">
        {(
          [
            ['memories', 'Memories'],
            ['person', 'People'],
            ['place', 'Places'],
            ['event', 'Events'],
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <b>{counts[key]}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="w3-mem__cost" role="status">
        {line}
      </div>
      <div className="w3-mem__acts">
        <button type="button" className="w3-set__pill" onClick={() => n.show()}>
          <Icon name="compass" size="sm" />
          Explore Nexus
        </button>
        {n.run.running ? (
          <button type="button" className="w3-set__ghost" onClick={n.cancel}>
            <Icon name="stop" size="xs" />
            Stop
          </button>
        ) : !n.data.initialized ? (
          <>
            <button
              type="button"
              className="w3-set__ghost"
              disabled={Boolean(blocked)}
              title={blocked ?? 'Collect from the whole chat so far'}
              onClick={n.build}
            >
              Build from this chat
            </button>
            <button
              type="button"
              className="w3-set__ghost"
              title="Collect only from here on"
              onClick={n.startHere}
            >
              Start from here
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="w3-set__ghost"
              disabled={Boolean(blocked) || !n.pending}
              title={blocked ?? (n.pending ? undefined : 'Nothing waiting')}
              onClick={() => void n.collect(true)}
            >
              <Icon name="spark" size="xs" />
              Collect now
            </button>
            <button
              type="button"
              className="w3-set__ghost"
              onClick={() => n.update((s) => ({ ...s, paused: !s.paused }))}
            >
              {n.data.paused ? 'Resume' : 'Pause'}
            </button>
          </>
        )}
      </div>
      {n.run.error ? (
        <p className="w3-mem__error" role="alert">
          {n.run.error}
        </p>
      ) : blocked ? (
        <p className="w3-mem__error" role="status">
          {blocked}
        </p>
      ) : null}
    </>
  );
}

function nexusSummary(settings: NexusSettings): string {
  return settings.autoInterval ? `every ${settings.autoInterval}` : 'by hand';
}

const EFFORTS: [ReasoningEffort, string][] = [
  ['auto', 'Auto'],
  ['min', 'Min'],
  ['low', 'Low'],
  ['medium', 'Med'],
  ['high', 'High'],
  ['max', 'Max'],
];

function NexusSettingsBody({
  controller,
  settings,
  onChange,
}: {
  controller: AppController;
  settings: NexusSettings;
  onChange: (patch: Partial<NexusSettings>) => void;
}) {
  const { app } = controller;
  const [guidance, setGuidance] = useState(settings.extractPrompt);
  useEffect(() => setGuidance(settings.extractPrompt), [settings.extractPrompt]);
  return (
    <>
      <Row title="Model">
        <span className="w3-mem__picker">
          <ModelPicker
            label="Nexus model"
            value={app.models.slots.nexus}
            onChange={(ref) => app.setModelSlot('nexus', ref)}
          />
        </span>
      </Row>
      <Row title="Collect every" hint="0 collects only when you ask">
        <span className="w3-mem__ctl">
          <NumberInput
            label="Collect every"
            value={settings.autoInterval}
            min={0}
            max={2000}
            onChange={(autoInterval) => onChange({ autoInterval })}
          />
          messages
        </span>
      </Row>
      <Row title="Recall allowance" hint="Pins, findings and recall share it">
        <span className="w3-mem__ctl">
          <NumberInput
            label="Recall allowance"
            value={settings.budgetTokens}
            min={0}
            max={32_000}
            wide
            onChange={(budgetTokens) => onChange({ budgetTokens })}
          />
          tokens
        </span>
      </Row>
      <Row title="Model context">
        <span className="w3-mem__ctl">
          <NumberInput
            label="Memory model context"
            value={settings.inputTokens}
            min={2048}
            max={2_000_000}
            wide
            onChange={(inputTokens) => onChange({ inputTokens })}
          />
          tokens
        </span>
      </Row>
      <Row title="Reasoning">
        <Segments
          label="Reasoning effort"
          value={settings.reasoningEffort}
          options={EFFORTS}
          onChange={(reasoningEffort) => onChange({ reasoningEffort })}
        />
      </Row>
      <Range
        label="Temp"
        value={settings.temperature}
        min={0}
        max={2}
        step={0.05}
        shown={settings.temperature.toFixed(2)}
        onChange={(temperature) => onChange({ temperature })}
      />
      <Row title="Living map motion">
        <Switch
          on={settings.motion}
          label="Living map motion"
          onChange={(motion) => onChange({ motion })}
        />
      </Row>
      <Group
        label="Extraction guidance"
        aside={
          guidance !== NEXUS_PROMPT ? (
            <button
              type="button"
              className="w3-mem__reset"
              onClick={() => {
                setGuidance(NEXUS_PROMPT);
                onChange({ extractPrompt: NEXUS_PROMPT });
              }}
            >
              Default
            </button>
          ) : undefined
        }
      >
        <textarea
          className="w3-mem__guide"
          aria-label="Extraction guidance"
          rows={6}
          value={guidance}
          onChange={(event) => setGuidance(event.target.value)}
          onBlur={() => {
            if (guidance !== settings.extractPrompt) onChange({ extractPrompt: guidance });
          }}
        />
      </Group>
      <Placement settings={settings} onChange={onChange} macro="memories" />
    </>
  );
}
