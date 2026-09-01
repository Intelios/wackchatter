import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from './png.ts';
import {
  centralDirectoryRecord,
  compressionFor,
  dosDateTime,
  type EntryRecord,
  endOfCentralDirectory,
  localFileHeader,
  type ZipSource,
  zipStream,
} from './zip.ts';

/* ----------------------------------------------------------------------------------- *
 * A reader, so the round-trip tests parse the archive the way any other tool would
 * rather than trusting the writer's own bookkeeping.
 * ----------------------------------------------------------------------------------- */

interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  data: Uint8Array;
  externalAttributes: number;
  flags: number;
}

function parseZip(bytes: Uint8Array): ParsedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('No end-of-central-directory record.');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`Bad central directory signature at ${offset}.`);
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`Bad local header signature for "${name}".`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    entries.push({
      name,
      method,
      crc,
      flags,
      externalAttributes,
      data: method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function source(name: string, body: Uint8Array | string): ZipSource {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return { name, mtime: new Date('2026-09-01T14:32:10Z'), read: async () => bytes };
}

function record(overrides: Partial<EntryRecord> = {}): EntryRecord {
  return {
    name: 'file.bin',
    method: 0,
    crc: 0x12345678,
    compressedSize: 10,
    uncompressedSize: 10,
    localOffset: 0,
    mtime: new Date('2026-09-01T14:32:10Z'),
    mode: 0o100644,
    ...overrides,
  };
}

/* ----------------------------------------------------------------------------------- *
 * Pure helpers
 * ----------------------------------------------------------------------------------- */

describe('crc32', () => {
  // The zip and PNG checksums are the same function, and this is the first direct test of
  // it — card.test.ts only ever exercised it through a whole PNG.
  test('matches the published vectors', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('a'))).toBe(0xe8b7be43);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('dosDateTime', () => {
  test('encodes a date into the DOS fields', () => {
    // 2026-09-01 14:32:10 local. Seconds have one-bit resolution, hence 10 >> 1 === 5.
    const { date, time } = dosDateTime(new Date(2026, 8, 1, 14, 32, 10));
    expect(date).toBe(((2026 - 1980) << 9) | (9 << 5) | 1);
    expect(time).toBe((14 << 11) | (32 << 5) | 5);
  });

  test('clamps outside the representable range rather than wrapping', () => {
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
    expect(dosDateTime(new Date(2200, 0, 1)).date >> 9).toBe(2107 - 1980);
  });

  test('falls back to now on an unreadable timestamp', () => {
    expect(dosDateTime(new Date(Number.NaN)).date >> 9).toBeGreaterThan(0);
  });
});

describe('compressionFor', () => {
  test('stores already-compressed images', () => {
    for (const name of ['card.png', 'shot.JPG', 'bg.webp', 'anim.gif']) {
      expect(compressionFor(name)).toBe(0);
    }
  });

  test('deflates the database, JSON and anything unrecognised', () => {
    for (const name of ['chats.db', 'settings.json', '.wackchatter', 'notes']) {
      expect(compressionFor(name)).toBe(8);
    }
  });

  test('stores directory entries', () => {
    expect(compressionFor('characters/Drafts/')).toBe(0);
  });
});

/* ----------------------------------------------------------------------------------- *
 * Zip64 — sizes are injected, so none of this needs a four-gigabyte fixture
 * ----------------------------------------------------------------------------------- */

describe('zip64', () => {
  const OVER_32_BITS = 0x1_0000_0000;

  test('an ordinary entry carries no zip64 field', () => {
    const local = localFileHeader(record());
    expect(new DataView(local.buffer).getUint16(28, true)).toBe(0);
    expect(new DataView(local.buffer).getUint16(4, true)).toBe(20);
  });

  test('a huge entry moves both sizes into the local header extra field', () => {
    const local = localFileHeader(
      record({ uncompressedSize: OVER_32_BITS, compressedSize: OVER_32_BITS }),
    );
    const view = new DataView(local.buffer);
    expect(view.getUint16(4, true)).toBe(45);
    expect(view.getUint32(18, true)).toBe(0xffffffff);
    expect(view.getUint32(22, true)).toBe(0xffffffff);
    expect(view.getUint16(28, true)).toBe(20);

    const extra = 30 + 'file.bin'.length;
    expect(view.getUint16(extra, true)).toBe(0x0001);
    expect(view.getUint16(extra + 2, true)).toBe(16);
    expect(Number(view.getBigUint64(extra + 4, true))).toBe(OVER_32_BITS);
    expect(Number(view.getBigUint64(extra + 12, true))).toBe(OVER_32_BITS);
  });

  test('a far-off local header moves only the offset into the directory extra field', () => {
    const central = centralDirectoryRecord(record({ localOffset: OVER_32_BITS }));
    const view = new DataView(central.buffer);
    expect(view.getUint32(42, true)).toBe(0xffffffff);
    // Both sizes still fit, so the extra field carries the offset alone.
    expect(view.getUint16(30, true)).toBe(12);
    expect(view.getUint32(20, true)).toBe(10);

    const extra = 46 + 'file.bin'.length;
    expect(view.getUint16(extra + 2, true)).toBe(8);
    expect(Number(view.getBigUint64(extra + 4, true))).toBe(OVER_32_BITS);
  });

  test('more than 65535 entries promotes the end record', () => {
    const end = endOfCentralDirectory(70_000, 1024, 2048);
    expect(end.length).toBe(76 + 22);

    const view = new DataView(end.buffer);
    expect(view.getUint32(0, true)).toBe(0x06064b50);
    expect(Number(view.getBigUint64(32, true))).toBe(70_000);
    expect(view.getUint32(56, true)).toBe(0x07064b50);
    // The locator points at where the zip64 end record begins: past the central directory.
    expect(Number(view.getBigUint64(64, true))).toBe(2048 + 1024);
    expect(view.getUint16(76 + 10, true)).toBe(0xffff);
  });

  test('an ordinary archive emits a bare 22-byte end record', () => {
    expect(endOfCentralDirectory(3, 200, 500).length).toBe(22);
  });
});

/* ----------------------------------------------------------------------------------- *
 * Round trips
 * ----------------------------------------------------------------------------------- */

describe('zipStream', () => {
  test('round-trips names, bytes and CRCs', async () => {
    const json = JSON.stringify({ hello: 'world', repeated: 'x'.repeat(500) });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

    const archive = await collect(
      zipStream([source('lib/settings.json', json), source('lib/card.png', png)]),
    );
    const entries = parseZip(archive);

    expect(entries.map((e) => e.name)).toEqual(['lib/settings.json', 'lib/card.png']);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe(json);
    expect(entries[1]!.data).toEqual(png);

    // Compressible JSON deflates; the image is stored untouched.
    expect(entries[0]!.method).toBe(8);
    expect(entries[1]!.method).toBe(0);

    for (const entry of entries) expect(entry.crc).toBe(crc32(entry.data));
  });

  test('stores rather than grows incompressible data', async () => {
    const noise = new Uint8Array(4096);
    crypto.getRandomValues(noise);
    // A .bin would deflate by the extension rule, so this pins the size fallback.
    const entries = parseZip(await collect(zipStream([source('noise.bin', noise)])));
    expect(entries[0]!.method).toBe(0);
    expect(entries[0]!.data).toEqual(noise);
  });

  test('carries non-ASCII names, flagged as UTF-8', async () => {
    const entries = parseZip(await collect(zipStream([source('characters/Café ☕.png', 'x')])));
    expect(entries[0]!.name).toBe('characters/Café ☕.png');
    expect(entries[0]!.flags & 0x0800).toBe(0x0800);
  });

  test('keeps a directory entry, so an empty folder survives', async () => {
    const entries = parseZip(
      await collect(
        zipStream([
          { name: 'characters/Drafts/', mtime: new Date(), read: async () => new Uint8Array(0) },
        ]),
      ),
    );
    expect(entries[0]!.name).toBe('characters/Drafts/');
    expect(entries[0]!.data.length).toBe(0);
    // Unix mode in the high half, DOS directory bit in the low.
    expect(entries[0]!.externalAttributes >>> 16).toBe(0o040755);
    expect(entries[0]!.externalAttributes & 0x10).toBe(0x10);
  });

  test('an empty archive is still a valid one', async () => {
    expect(parseZip(await collect(zipStream([])))).toEqual([]);
  });

  test('settles once, and on cancel', async () => {
    let settled = 0;
    const stream = zipStream([source('a.json', '{}'), source('b.json', '{}')], () => settled++);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(settled).toBe(1);
  });

  test('settles when a source throws, and surfaces the error', async () => {
    let settled = 0;
    const stream = zipStream(
      [{ name: 'gone.json', mtime: new Date(), read: () => Promise.reject(new Error('vanished')) }],
      () => settled++,
    );
    expect(collect(stream)).rejects.toThrow('vanished');
    await Bun.sleep(0);
    expect(settled).toBe(1);
  });

  test('unzip agrees it is a zip', async () => {
    const unzip = Bun.which('unzip');
    // Parsing our own output only proves we agree with ourselves.
    if (!unzip) return;

    const dir = mkdtempSync(join(tmpdir(), 'wc-zip-test-'));
    try {
      const path = join(dir, 'archive.zip');
      writeFileSync(
        path,
        await collect(
          zipStream([
            source('lib/settings.json', JSON.stringify({ a: 1 })),
            source('lib/Café ☕.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
            { name: 'lib/empty/', mtime: new Date(), read: async () => new Uint8Array(0) },
          ]),
        ),
      );

      const test = Bun.spawnSync([unzip, '-t', path]);
      expect(test.stdout.toString()).toContain('No errors detected');
      expect(test.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
