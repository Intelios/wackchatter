import type { PortraitPalette } from './portraitPalette.ts';

/** One bounded cache owns pending work and synchronous results; versioned URLs are its keys. */
export function createPaletteCache(
  extract: (url: string) => Promise<PortraitPalette | null>,
  limit = 50,
) {
  interface Entry {
    pending: Promise<PortraitPalette | null>;
    result?: PortraitPalette | null;
  }
  const entries = new Map<string, Entry>();
  return {
    peek(url: string) {
      return entries.get(url)?.result;
    },
    get(url: string): Promise<PortraitPalette | null> {
      const known = entries.get(url);
      if (known) {
        entries.delete(url);
        entries.set(url, known);
        return known.pending;
      }
      const entry: Entry = { pending: Promise.resolve(null) };
      entry.pending = extract(url)
        .catch(() => null)
        .then((result) => {
          if (entries.get(url) === entry) entry.result = result;
          return result;
        });
      entries.set(url, entry);
      if (entries.size > limit) entries.delete(entries.keys().next().value!);
      return entry.pending;
    },
  };
}
