/**
 * The app: its state and actions (`useAppController`), rendered by the shell.
 *
 * Two halves on purpose. The controller holds everything the app knows and can do; the
 * shell is markup over it.
 */

import { useAppController } from './app/useAppController.ts';
import { Shell } from './shell/Shell.tsx';

export function App() {
  const controller = useAppController();
  return <Shell controller={controller} />;
}
