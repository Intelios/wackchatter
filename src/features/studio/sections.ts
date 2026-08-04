export const STUDIO_SECTIONS = [
  { id: 'identity', label: 'Identity' },
  { id: 'definition', label: 'Definition' },
  { id: 'greetings', label: 'Greetings' },
  { id: 'examples', label: 'Examples' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'lorebook', label: 'Lorebook' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'raw-json', label: 'Raw JSON' },
] as const;

export type StudioSection = (typeof STUDIO_SECTIONS)[number]['id'];
