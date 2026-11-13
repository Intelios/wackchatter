import type { SettingsPatch, SettingsResponse } from '@shared/types/settings.ts';

/**
 * Paint settings responses in the order the server wrote them, never the order the
 * browser received them. Every persisted change bumps `settingsRevision`, so a slow
 * response from before a newer save describes a world that has been replaced — painting
 * it would put a deleted connection, or the previous chat model, back on screen.
 */
export function createSettingsPainter(paint: (settings: SettingsResponse) => void) {
  let painted = -1;
  return (saved: SettingsResponse): boolean => {
    if (saved.settingsRevision < painted) return false;
    painted = saved.settingsRevision;
    paint(saved);
    return true;
  };
}

// A strict model save must publish its own confirmed fields even when another write is queued.
export function applySavedChatModelSettings(
  current: SettingsResponse,
  saved: SettingsResponse,
  patch: SettingsPatch,
): SettingsResponse {
  return {
    ...current,
    settingsRevision: Math.max(current.settingsRevision, saved.settingsRevision),
    models:
      patch.models?.chat !== undefined
        ? { ...current.models, chat: saved.models.chat }
        : current.models,
    chatReasoningEfforts:
      patch.chatReasoningEfforts !== undefined
        ? saved.chatReasoningEfforts
        : current.chatReasoningEfforts,
  };
}
