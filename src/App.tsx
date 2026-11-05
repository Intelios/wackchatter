/**
 * The app: its state and actions (`useAppController`), rendered by a shell.
 *
 * Two halves on purpose. The controller holds everything the app knows and can do; the
 * shell is markup over it. The 3.0 interface replaces `LegacyShell` here and inherits every
 * behaviour unchanged.
 */

import { LegacyShell } from './app/LegacyShell.tsx';
import { useAppController } from './app/useAppController.ts';

export function App() {
  const controller = useAppController();
  return <LegacyShell controller={controller} />;
}
