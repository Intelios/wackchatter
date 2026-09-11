import type { ComposerLabelMode } from '@shared/composer/layout.ts';
import { useRef, useState } from 'react';
import { EditIcon, UploadIcon } from '../../layout/icons.tsx';
import { RenameChatPopover } from './RenameChatPopover.tsx';

interface RenameProps {
  title: string;
  display: ComposerLabelMode;
  disabledReason?: string;
  onRename: (title: string) => void;
}

export function ComposerRenameControl({ title, display, disabledReason, onRename }: RenameProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="composer-utility">
      <button
        ref={triggerRef}
        type="button"
        className="wc-button wc-button--ghost composer__icon composer__layout-button"
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? 'Rename'}
        aria-label="Rename"
        onClick={() => setOpen(true)}
      >
        <EditIcon />
        {display === 'label' ? <span>Rename</span> : null}
      </button>
      <RenameChatPopover
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        title={title}
        onRename={onRename}
      />
    </div>
  );
}

interface ImportProps {
  display: ComposerLabelMode;
  disabledReason?: string;
  onImport: (file: File) => void;
}

export function ComposerImportControl({ display, disabledReason, onImport }: ImportProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="composer-utility">
      <button
        type="button"
        className="wc-button wc-button--ghost composer__icon composer__layout-button"
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? 'Import chat'}
        aria-label="Import chat"
        onClick={() => input.current?.click()}
      >
        <UploadIcon />
        {display === 'label' ? <span>Import</span> : null}
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onImport(file);
          event.currentTarget.value = '';
        }}
      />
    </span>
  );
}
