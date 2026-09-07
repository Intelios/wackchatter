import type { UseChat } from '../chat/useChat.ts';
export function NexusActivity({ chat, configured }: { chat: UseChat; configured: boolean }) {
  const n = chat.nexus;
  const enabled = chat.memoryMode === 'nexus';
  return (
    <div className="nexus-activity">
      <p role="status">
        {n.run.running
          ? `${n.run.kind === 'collection' ? 'Remembering' : 'Searching'}… ${n.run.processed} / ${n.run.total}`
          : `${n.pending} ${n.pending === 1 ? 'message' : 'messages'} awaiting collection`}
      </p>
      {n.run.error ? <p role="alert">{n.run.error}</p> : null}
      {!configured ? (
        <p>
          Select a saved connection and a Nexus model in Settings to collect or search more deeply.
        </p>
      ) : null}
      {n.run.running ? (
        <button type="button" className="wc-button" onClick={n.cancel}>
          Cancel
        </button>
      ) : (
        <div className="nexus-actions">
          {!n.data.initialized ? (
            <>
              <button
                type="button"
                className="wc-button"
                disabled={!enabled || !configured}
                onClick={n.build}
              >
                Build from this conversation
              </button>
              <button type="button" className="wc-button" disabled={!enabled} onClick={n.startHere}>
                Start from here
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="wc-button"
                disabled={!enabled || !configured || !n.pending}
                onClick={() => void n.collect(true)}
              >
                {n.run.error ? 'Retry' : 'Remember now'}
              </button>
              <button
                type="button"
                className="wc-button"
                disabled={!enabled}
                onClick={() => n.update((s) => ({ ...s, paused: !s.paused }))}
              >
                {n.data.paused ? 'Resume collection' : 'Pause collection'}
              </button>
            </>
          )}
        </div>
      )}
      {n.indexStatus.total > 0 ? (
        <p role="status">
          Local index: {n.indexStatus.done} / {n.indexStatus.total}
          {n.indexStatus.done < n.indexStatus.total
            ? ' · Text and graph search remain available.'
            : ''}
        </p>
      ) : null}
      {n.indexStatus.error ? (
        <p role="status">{n.indexStatus.error} Text and graph search remain available.</p>
      ) : null}
    </div>
  );
}
