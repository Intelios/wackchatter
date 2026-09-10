import { type MessageState, toChatMessage } from '@shared/chat/message.ts';
import type { ChatMessage, MessageExtra } from '@shared/types/chat.ts';
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  initialChatState,
} from '../chat/state/chatReducer.ts';

export interface PendingReply {
  messageId: string;
  mode: 'send' | 'swipe';
  original?: MessageState;
}
export interface GroupState extends ChatState {
  jobs: Record<string, PendingReply>;
  conversationRunning: boolean;
}
export const initialGroupState: GroupState = {
  ...initialChatState,
  jobs: {},
  conversationRunning: false,
};
export type GroupAction =
  | ChatAction
  | { type: 'group/running'; running: boolean }
  | {
      type: 'group/start';
      jobId: string;
      memberId: string;
      characterId: string;
      name: string;
      mode: 'send' | 'swipe';
    }
  | { type: 'group/settle'; jobId: string; text: string; extra: MessageExtra; failed?: boolean }
  | { type: 'group/error'; message: string };

function status(state: GroupState): GroupState {
  return {
    ...state,
    streamingId: null,
    mode: null,
    status: state.conversationRunning || Object.keys(state.jobs).length ? 'streaming' : 'idle',
  };
}
export function groupReducer(state: GroupState, action: GroupAction): GroupState {
  if (action.type === 'chat/loaded' || action.type === 'chat/closed')
    return { ...chatReducer(state, action), jobs: {}, conversationRunning: false };
  if (action.type === 'group/running')
    return status({ ...state, conversationRunning: action.running });
  if (action.type === 'group/error') return { ...state, error: action.message };
  if (action.type === 'group/start') {
    const original = action.mode === 'swipe' ? state.messages.at(-1) : undefined;
    const next = chatReducer(
      { ...state, status: 'idle' },
      { type: 'gen/started', mode: action.mode, newId: action.jobId, name: action.name },
    );
    if (!next.streamingId) return state;
    return status({
      ...state,
      messages: next.messages.map((m) =>
        m.id === next.streamingId
          ? { ...m, memberId: action.memberId, characterId: action.characterId }
          : m,
      ),
      jobs: {
        ...state.jobs,
        [action.jobId]: { messageId: next.streamingId, mode: action.mode, original },
      },
      error: null,
    });
  }
  if (action.type === 'group/settle') {
    const job = state.jobs[action.jobId];
    if (!job) return state;
    const next = chatReducer(
      { ...state, status: 'streaming', streamingId: job.messageId, mode: job.mode },
      { type: 'gen/finished', text: action.text, extra: action.extra },
    );
    const jobs = { ...state.jobs };
    delete jobs[action.jobId];
    return status({ ...state, messages: next.messages, revision: next.revision, jobs });
  }
  return status({ ...state, ...chatReducer(state, action) });
}
export function persistedGroupMessages(state: GroupState): ChatMessage[] {
  const pending = new Map(Object.values(state.jobs).map((j) => [j.messageId, j]));
  return state.messages.flatMap((m) => {
    const job = pending.get(m.id);
    return job ? (job.original ? [toChatMessage(job.original)] : []) : [toChatMessage(m)];
  });
}
export function completedGroupMessages(state: GroupState): ChatMessage[] {
  const pending = new Set(Object.values(state.jobs).map((j) => j.messageId));
  return state.messages.filter((m) => !pending.has(m.id)).map(toChatMessage);
}
