/**
 * The regex script editor.
 *
 * Markup and one confirm; every list edit lives in `regexScripts.ts` and every semantic in
 * `shared/regex/`. The one piece of judgement here is the live tester at the bottom of each
 * open script: a bad pattern fails completely silently — in SillyTavern too — and the
 * "No change" case is what catches the bare-pattern-has-no-`g` trap before it is saved
 * rather than three messages later.
 *
 * Import and export are client-side. Scripts live inside settings.json, so there is no
 * server resource to point a download at, and adding a route just to echo JSON back would
 * put app logic in a server whose job is files, database and proxying.
 */

import { compileFindRegex, runRegexScript } from '@shared/regex/engine.ts';
import {
  parseRegexScriptFile,
  regexScriptFilename,
  serializeRegexScript,
} from '@shared/regex/io.ts';
import type { RegexScript, RegexSubstituteMode } from '@shared/types/regex.ts';
import { REGEX_SUBSTITUTE } from '@shared/types/regex.ts';
import { useState } from 'react';
import {
  CheckField,
  OptionalNumberField,
  SelectField,
  TextField,
} from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { ChevronIcon, DownloadIcon, PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import {
  addScript,
  duplicateScript,
  hasUsablePlacement,
  moveScript,
  PLACEMENT_OPTIONS,
  regexTarget,
  removeScript,
  TARGET_OPTIONS,
  targetFlags,
  targetLabel,
  togglePlacement,
  updateScript,
} from './regexScripts.ts';
import './RegexScriptList.css';

interface RegexScriptListProps {
  scripts: RegexScript[];
  onChange: (scripts: RegexScript[]) => void;
}

/** Trigger a download without a server URL to hang an `href` on. */
function download(filename: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // The click is synchronous but the fetch it starts is not, so the revoke waits a tick.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function RegexScriptList({ scripts, onChange }: RegexScriptListProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function handleImport(file: File): Promise<void> {
    try {
      const parsed = parseRegexScriptFile(JSON.parse(await file.text()), () => crypto.randomUUID());
      if (parsed.length === 0) {
        setError(`${file.name} does not contain a regex script.`);
        return;
      }
      setError('');
      onChange([...scripts, ...parsed]);
    } catch {
      setError(`${file.name} is not readable JSON.`);
    }
  }

  return (
    <div className="regex-scripts">
      <p className="wc-hint">
        Rewrite message text on its way to the screen, on its way to the model, or both.
        SillyTavern's format — script files move between the two apps untouched.
      </p>

      {scripts.length === 0 ? (
        <p className="regex-scripts__empty">
          No scripts yet. A script that hides text from you but still sends it to the AI is “Display
          only” with an empty replacement.
        </p>
      ) : (
        <ul className="regex-scripts__list">
          {scripts.map((script, index) => {
            const open = openId === script.id;
            const broken = Boolean(script.findRegex) && compileFindRegex(script.findRegex) === null;
            const patch = (fields: Partial<Omit<RegexScript, 'id'>>) =>
              onChange(updateScript(scripts, script.id, fields));

            return (
              <li
                className="regex-script"
                key={script.id}
                data-disabled={script.disabled || undefined}
              >
                <div className="regex-script__row">
                  <input
                    type="checkbox"
                    checked={!script.disabled}
                    aria-label={`${script.scriptName || 'Script'} enabled`}
                    title={script.disabled ? 'Disabled' : 'Enabled'}
                    onChange={(event) => patch({ disabled: !event.target.checked })}
                  />

                  <button
                    type="button"
                    className="regex-script__name"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : script.id)}
                  >
                    <ChevronIcon className="regex-script__chevron" />
                    <span>{script.scriptName || 'Untitled script'}</span>
                  </button>

                  {broken ? (
                    <span className="regex-script__warning" title="This pattern does not compile">
                      ●
                    </span>
                  ) : null}
                  <span className="regex-script__target">{targetLabel(regexTarget(script))}</span>

                  <button
                    type="button"
                    className="wc-button wc-button--ghost regex-script__move"
                    disabled={index === 0}
                    title="Move up"
                    aria-label={`Move ${script.scriptName || 'script'} up`}
                    onClick={() => onChange(moveScript(scripts, script.id, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="wc-button wc-button--ghost regex-script__move"
                    disabled={index === scripts.length - 1}
                    title="Move down"
                    aria-label={`Move ${script.scriptName || 'script'} down`}
                    onClick={() => onChange(moveScript(scripts, script.id, 1))}
                  >
                    ↓
                  </button>
                </div>

                {open ? (
                  <RegexScriptForm
                    script={script}
                    onPatch={patch}
                    confirmingDelete={confirmDelete === script.id}
                    onDuplicate={() =>
                      onChange(duplicateScript(scripts, script.id, crypto.randomUUID()))
                    }
                    onExport={() =>
                      download(regexScriptFilename(script), serializeRegexScript(script))
                    }
                    onDelete={() => {
                      if (confirmDelete === script.id) {
                        onChange(removeScript(scripts, script.id));
                        setConfirmDelete(null);
                      } else {
                        setConfirmDelete(script.id);
                      }
                    }}
                    onCancelDelete={() => setConfirmDelete((id) => (id === script.id ? null : id))}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {error ? <p className="regex-scripts__error">{error}</p> : null}

      <div className="regex-scripts__actions">
        <button
          type="button"
          className="wc-button"
          onClick={() => {
            const next = addScript(scripts, crypto.randomUUID());
            onChange(next);
            setOpenId(next.at(-1)?.id ?? null);
          }}
        >
          <PlusIcon />
          Add script
        </button>

        <label className="wc-button">
          Import
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleImport(file);
              // Reset, or picking the same file twice would not fire a change.
              event.target.value = '';
            }}
          />
        </label>

        {scripts.length > 0 ? (
          <button
            type="button"
            className="wc-button"
            onClick={() =>
              download('wackchatter-regex-scripts.json', JSON.stringify(scripts, null, 4))
            }
          >
            Export all
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RegexScriptForm({
  script,
  onPatch,
  confirmingDelete,
  onDuplicate,
  onExport,
  onDelete,
  onCancelDelete,
}: {
  script: RegexScript;
  onPatch: (fields: Partial<Omit<RegexScript, 'id'>>) => void;
  confirmingDelete: boolean;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}) {
  const target = regexTarget(script);

  return (
    <div className="regex-script__form">
      <TextField
        label="Name"
        value={script.scriptName}
        onChange={(scriptName) => onPatch({ scriptName })}
        placeholder="What this script does"
      />

      <div className="regex-script__pattern">
        <TextField
          label="Find"
          value={script.findRegex}
          onChange={(findRegex) => onPatch({ findRegex })}
          placeholder="/pattern/flags"
          hint="A bare pattern gets no flags — write /…/g to replace every match, not just the first."
        />
      </div>

      <TextField
        label="Replace with"
        value={script.replaceString}
        onChange={(replaceString) => onPatch({ replaceString })}
        multiline
        rows={2}
        placeholder="Leave empty to delete the match"
        hint="$1…$9, $<name>, and {{match}} for the whole match. $& is not supported. Macros expand."
      />

      <SelectField
        label="Affects"
        value={target}
        options={TARGET_OPTIONS}
        onChange={(next) => onPatch(targetFlags(next))}
        hint={
          target === 'store'
            ? 'SillyTavern would rewrite the stored chat text here. WackChatter never edits your transcript, so this script will not run — pick one of the others.'
            : undefined
        }
      />

      <fieldset className="regex-script__placements">
        <legend className="wc-label">Applies to</legend>
        {PLACEMENT_OPTIONS.map((option) => (
          <CheckField
            key={option.value}
            label={option.label}
            checked={script.placement.includes(option.value)}
            onChange={(on) =>
              onPatch({ placement: togglePlacement(script.placement, option.value, on) })
            }
          />
        ))}
        {!hasUsablePlacement(script) ? (
          <p className="wc-hint">Nothing selected, so this script never runs.</p>
        ) : null}
      </fieldset>

      <div className="regex-script__pair">
        <OptionalNumberField
          label="From depth"
          value={script.minDepth}
          onChange={(minDepth) => onPatch({ minDepth })}
          min={-1}
          max={9999}
          placeholder="Unlimited"
        />
        <OptionalNumberField
          label="To depth"
          value={script.maxDepth}
          onChange={(maxDepth) => onPatch({ maxDepth })}
          min={0}
          max={9999}
          placeholder="Unlimited"
        />
      </div>
      <p className="wc-hint">0 is the newest message. Both ends are included.</p>

      <TextField
        label="Trim from matches"
        value={script.trimStrings.join('\n')}
        onChange={(value) =>
          onPatch({ trimStrings: value.split('\n').filter((line) => line.length > 0) })
        }
        multiline
        rows={2}
        placeholder="One per line"
        hint="Removed from the text a capture group pulled in — not from what you typed above."
      />

      <SelectField<RegexSubstituteMode>
        label="Macros in the find pattern"
        value={script.substituteRegex}
        options={[
          { label: 'Leave literal', value: REGEX_SUBSTITUTE.NONE },
          { label: 'Expand', value: REGEX_SUBSTITUTE.RAW },
          { label: 'Expand and escape', value: REGEX_SUBSTITUTE.ESCAPED },
        ]}
        onChange={(substituteRegex) => onPatch({ substituteRegex })}
        hint="Expand puts a name straight into the pattern, where a . or ( in it becomes live regex syntax. Escape unless you meant that."
      />

      <RegexTester script={script} />

      {/*
        Duplicate, export and delete live here rather than on the collapsed row. Seven
        controls did not fit the panel at its narrowest and truncated the script name to
        nothing — and the name is the only thing that tells two scripts apart. The row keeps
        what you scan for: what it is called, whether it runs, and where it sits in the chain.
      */}
      <div className="regex-script__form-actions">
        <button type="button" className="wc-button wc-button--ghost" onClick={onDuplicate}>
          Duplicate
        </button>
        <button type="button" className="wc-button wc-button--ghost" onClick={onExport}>
          <DownloadIcon />
          Export
        </button>
        {/* Two-click confirm in place, not a dialog: the chat stays live. */}
        <button
          type="button"
          className="wc-button wc-button--ghost wc-button--danger"
          data-confirming={confirmingDelete || undefined}
          onClick={onDelete}
          onBlur={onCancelDelete}
        >
          {confirmingDelete ? 'Sure?' : <TrashIcon />}
          {confirmingDelete ? null : 'Delete'}
        </button>
      </div>
    </div>
  );
}

/**
 * Try the script against text you paste in.
 *
 * Macros are deliberately NOT expanded here: this component has no character, and showing
 * `{{char}}` unresolved is more honest than resolving it to nothing. A script that leans on
 * macros will show its pattern not matching, which is the truth about this preview rather
 * than about the script.
 */
function RegexTester({ script }: { script: RegexScript }) {
  const [sample, setSample] = useState('');
  const compiled = script.findRegex ? compileFindRegex(script.findRegex) : null;
  const result = compiled && sample ? runRegexScript(script, sample) : sample;

  return (
    <div className="regex-tester">
      <TextField
        label="Try it"
        value={sample}
        onChange={setSample}
        multiline
        rows={2}
        placeholder="Paste a message to see what this script does to it"
      />
      <output className="regex-tester__result">
        {!script.findRegex ? (
          <span className="wc-hint">Enter a pattern above.</span>
        ) : !compiled ? (
          <span className="regex-tester__bad">This pattern does not compile.</span>
        ) : !sample ? (
          <span className="wc-hint">Nothing to try yet.</span>
        ) : result === sample ? (
          <span className="wc-hint">No change — the pattern did not match.</span>
        ) : (
          <pre className="regex-tester__output">{result}</pre>
        )}
      </output>
    </div>
  );
}

/** The panel section. Kept beside the list so a new home is one import to move. */
export function RegexScriptSection(props: RegexScriptListProps) {
  return (
    <Section title="Regex scripts" badge={props.scripts.length || undefined}>
      <RegexScriptList {...props} />
    </Section>
  );
}
