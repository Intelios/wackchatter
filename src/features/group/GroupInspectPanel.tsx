import { memberLabel } from '@shared/types/group.ts';
import { useEffect, useRef, useState } from 'react';
import { PromptInspector } from '../chat/PromptInspector.tsx';
import type { PromptInspection } from '../chat/state/chatReducer.ts';
import type { GroupChatController } from './useGroupChat.ts';
export function GroupInspectPanel({ chat }: { chat: GroupChatController }) {
  const [member, setMember] = useState(chat.selectedMemberId);
  const [preview, setPreview] = useState<PromptInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: member and chat identity are the reset triggers
  useEffect(() => {
    setPreview(null);
    request.current++;
  }, [member, chat.state.chatId, chat.state.revision]);
  const inspection = chat.inspections[member];
  return (
    <div className="groups-panel">
      <label>
        Speaker
        <select className="wc-input" value={member} onChange={(e) => setMember(e.target.value)}>
          <option value="">Choose member</option>
          {chat.state.metadata.group?.members.map((m) => (
            <option value={m.id} key={m.id}>
              {memberLabel(m, chat.state.metadata.group!.members)}
            </option>
          ))}
          <option value="director">Director</option>
        </select>
      </label>
      {member === 'director' ? (
        <pre className="group-wire">{JSON.stringify(chat.directorInspection, null, 2)}</pre>
      ) : (
        <>
          <button
            type="button"
            className="wc-button"
            disabled={!member}
            onClick={async () => {
              const id = ++request.current;
              setError(null);
              try {
                const p = await chat.preview(member);
                if (id === request.current) setPreview(p);
              } catch (e) {
                if (id === request.current) setError((e as Error).message);
              }
            }}
          >
            Preview next request
          </button>
          {error ? <p role="alert">{error}</p> : null}
          {preview ? (
            <>
              <h3>Preview</h3>
              <PromptInspector inspection={preview} />
            </>
          ) : inspection ? (
            <>
              <h3>Last actual request</h3>
              <PromptInspector inspection={inspection} />
            </>
          ) : (
            <p>No request recorded for this member yet.</p>
          )}
        </>
      )}
    </div>
  );
}
