/**
 * The app: its state and actions (`useAppController`), rendered by a shell.
 *
 * Two halves on purpose. The controller holds everything the app knows and can do; the
 * shell is markup over it. While 3.0 is being built both shells exist: the new one by
 * default, the 2.x one a keypress away (Ctrl+Shift+U) until the new one reaches parity.
 */

import { LegacyShell } from './app/LegacyShell.tsx';
import { useUiChoice } from './app/uiChoice.ts';
import { useAppController } from './app/useAppController.ts';
import { Shell } from './shell/Shell.tsx';

export function App() {
  const controller = useAppController();
  const [ui, choose] = useUiChoice();
  if (ui === 'legacy') {
    return <LegacyShell controller={controller} onUseNewInterface={() => choose('3')} />;
  }
  return <Shell controller={controller} onUiChoice={choose} />;
}
