/**
 * The 3.0 shell's icons: one stroke family, drawn on a 24-unit grid, coloured by
 * `currentColor`. Decorative by default; the control that holds one carries the label.
 */

import type { ReactNode } from 'react';

const PATHS = {
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.6-3.2 3-5 5.5-5s4.9 1.8 5.5 5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 14.2c2.3.2 4 1.8 4.5 4.8" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.5h9.5a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z" />
      <path d="M5 17a3 3 0 0 1 3-3h9.5" />
    </>
  ),
  persona: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.5 18.2c1.2-2.2 3.2-3.2 5.5-3.2s4.3 1 5.5 3.2" />
    </>
  ),
  layers: (
    <>
      <path d="M12 4 3.5 8.5 12 13l8.5-4.5z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16.3 8.5 4.5 8.5-4.5" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="17" r="2" />
    </>
  ),
  memory: (
    <>
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5.5" cy="6.5" r="1.8" />
      <circle cx="18.5" cy="7" r="1.8" />
      <circle cx="17.5" cy="18" r="1.8" />
      <circle cx="6" cy="17.5" r="1.8" />
      <path d="m7 7.8 3.2 2.7M17 8.3l-3.3 2.5M16.3 16.7 13.8 13.8M7.4 16.4l2.8-2.6" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </>
  ),
  inspect: (
    <>
      <path d="M4 6h16M4 12h10M4 18h7" />
      <circle cx="17.5" cy="16.5" r="2.5" />
      <path d="m19.4 18.4 1.6 1.6" />
    </>
  ),
  chevronDown: <path d="m7 10 5 5 5-5" />,
  chevronLeft: <path d="m14 6-6 6 6 6" />,
  chevronRight: <path d="m10 6 6 6-6 6" />,
  refresh: (
    <>
      <path d="M19 12a7 7 0 1 1-2.1-5" />
      <path d="M19 4.5V9h-4.5" />
    </>
  ),
  pencil: <path d="M5 19h3.5L19 8.5 15.5 5 5 15.5z" />,
  branch: (
    <>
      <circle cx="7" cy="5.5" r="1.8" />
      <circle cx="7" cy="18.5" r="1.8" />
      <circle cx="17" cy="8" r="1.8" />
      <path d="M7 7.3v9.4M17 9.8c0 4-6 3-9.2 6.8" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  mask: (
    <>
      <path d="M4 6c5 1.5 11 1.5 16 0v5c0 5-3.6 8-8 8s-8-3-8-8z" />
      <path d="M8.5 11.5c.8-.6 1.7-.6 2.5 0M13 11.5c.8-.6 1.7-.6 2.5 0M9.5 15c1.6 1 3.4 1 5 0" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </>
  ),
  guidedSwipe: (
    <>
      <path d="M4 12h10M10 7l5 5-5 5" />
      <path d="M19 5v14" />
    </>
  ),
  forward: <path d="M5 12h11M12 7l5 5-5 5M20 6v12" />,
  plus: <path d="M12 5v14M5 12h14" />,
  chip: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
    </>
  ),
  chat: (
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z" />
  ),
  spark: (
    <>
      <path d="M12 3.5 13.8 9 19.5 10.5 13.8 12 12 17.5 10.2 12 4.5 10.5 10.2 9z" />
      <path d="M18.5 16v4M16.5 18h4" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.2v.3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c5 0 8.5 4.5 9 7-.2 1-1 2.5-2.3 3.9M6.4 6.6C4.4 8 3.3 10.4 3 12c.5 2.5 4 7 9 7 1.6 0 3-.4 4.2-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  eye: (
    <>
      <path d="M3 12c.5-2.5 4-7 9-7s8.5 4.5 9 7c-.5 2.5-4 7-9 7s-8.5-4.5-9-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.2" />
      <path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  card: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <circle cx="9" cy="11" r="2" />
      <path d="M6 15.5c.6-1.3 1.7-2 3-2s2.4.7 3 2M14 10h4M14 13.5h3" />
    </>
  ),
  pin: (
    <>
      <path d="M9 4h6l-1 5 3 3H7l3-3z" />
      <path d="M12 12v8" />
    </>
  ),
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 19h14" />,
  upload: <path d="M12 20V9M7 14l5-5 5 5M5 5h14" />,
  rewind: <path d="M11 7 5 12l6 5zM19 7l-6 5 6 5z" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  sparkles: (
    <>
      <path d="M9 4l1.5 4.5L15 10l-4.5 1.5L9 16l-1.5-4.5L3 10l4.5-1.5z" />
      <path d="M17 13l.8 2.2L20 16l-2.2.8L17 19l-.8-2.2L14 16l2.2-.8z" />
    </>
  ),
  studio: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M4 10h16M10 10v10" />
    </>
  ),
  arena: (
    <>
      <path d="M6 4l6 6 6-6M6 20l6-6 6 6" />
      <path d="M4 12h16" />
    </>
  ),
  stats: <path d="M5 19V11M10 19V5M15 19v-6M20 19V8" />,
  home: (
    <>
      <path d="M4 11 12 4l8 7" />
      <path d="M6 9.5V20h12V9.5" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 16v5" />
    </>
  ),
  brush: (
    <>
      <path d="M14 4l6 6-8 8H6v-6z" />
      <path d="M4 20l2-2" />
    </>
  ),
  lines: <path d="M5 6h14M5 12h10M5 18h14" />,
  box: (
    <>
      <path d="M4 8l8-4 8 4v8l-8 4-8-4z" />
      <path d="M4 8l8 4 8-4M12 12v8" />
    </>
  ),
  power: (
    <>
      <path d="M12 4v8" />
      <path d="M7 7a7 7 0 1 0 10 0" />
    </>
  ),
  restore: (
    <>
      <path d="M4 12a8 8 0 1 0 3-6.2" />
      <path d="M4 4v4h4" />
    </>
  ),
  bolt: <path d="M13 3 5 14h6l-1 7 8-11h-6z" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size }: { name: IconName; size?: 'sm' | 'xs' }) {
  return (
    <svg
      className={size ? `w3-ic w3-ic--${size}` : 'w3-ic'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
