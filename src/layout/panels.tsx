/**
 * What each sidebar can show.
 *
 * Both sides are multi-destination: the top bar carries a button per panel, and pressing
 * one swaps that side's contents. Pressing the button of the panel already showing closes
 * the side. `null` means closed, which is why these are ids rather than a pair of booleans
 * plus a tab — a boolean and a tab can disagree, an id cannot.
 *
 * Specs live here, beside the ids, so a new panel is one entry rather than an id in one
 * file and a button in another.
 */

import type { ReactNode } from 'react';
import {
  BookIcon,
  ImageIcon,
  MessagesIcon,
  PlugIcon,
  SearchIcon,
  SlidersIcon,
  UserIcon,
  UsersIcon,
} from './icons.tsx';

export type LeftPanelId = 'connection' | 'prompts' | 'generation' | 'inspect';
export type RightPanelId = 'characters' | 'lorebooks' | 'persona' | 'appearance';

export interface PanelSpec<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
}

/** Left is how the model behaves. */
export const LEFT_PANELS: readonly PanelSpec<LeftPanelId>[] = [
  { id: 'connection', label: 'Connection', icon: <PlugIcon /> },
  { id: 'prompts', label: 'Prompts', icon: <MessagesIcon /> },
  { id: 'generation', label: 'Generation', icon: <SlidersIcon /> },
  { id: 'inspect', label: 'Inspect', icon: <SearchIcon /> },
];

/** Right is who is in the scene, and how it all looks. */
export const RIGHT_PANELS: readonly PanelSpec<RightPanelId>[] = [
  { id: 'characters', label: 'Characters', icon: <UsersIcon /> },
  { id: 'lorebooks', label: 'Lorebooks', icon: <BookIcon /> },
  { id: 'persona', label: 'Persona', icon: <UserIcon /> },
  { id: 'appearance', label: 'Appearance', icon: <ImageIcon /> },
];
