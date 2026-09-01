/**
 * Minimal zip writer — just enough to stream a whole library out as one archive.
 *
 * Hand-rolled for the same reason png.ts is: the job here is a container format, not
 * compression, and node:zlib already does the only hard part. crc32 comes from png.ts
 * because PNG and ZIP use the identical CRC-32 (reflected, polynomial 0xEDB88320,
 * init/final XOR 0xFFFFFFFF) — one implementation, already pinned by that file's tests.
 *
 * What gets written:
 *   [local header + data] * n   [central directory record] * n   [zip64 EOCD + locator]?  [EOCD]
 *
 * Every file is read whole before its header is written, so the CRC and both sizes are
 * known up front and no data descriptors are needed. That keeps the archive readable by
 * the simplest possible parser, at the cost of holding one file in memory at a time —
 * which is the trade that lets a multi-gigabyte library stream through a fixed footprint.
 */

import { deflateRawSync } from 'node:zlib';
import { crc32 } from './png.ts';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;

/** Bit 11: the filename is UTF-8. Character folders are user-named, so this is not optional. */
const FLAG_UTF8 = 0x0800;

/** Unix host, format 2.0 — so the external attributes below are read as a file mode. */
const VERSION_MADE_BY = (3 << 8) | 20;
const VERSION_BASE = 20;
const VERSION_ZIP64 = 45;

/** Above these, the classic field carries a sentinel and the real value moves into zip64. */
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const EMPTY = new Uint8Array(0);

/** Everything needed to write one entry, in both the local header and the directory. */
export interface EntryRecord {
  /** Forward-slash path inside the archive. A trailing slash marks a directory. */
  name: string;
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Byte offset of this entry's local header from the start of the archive. */
  localOffset: number;
  mtime: Date;
  /** Unix mode, so permissions survive the round trip. */
  mode: number;
}

/**
 * Fixed-size little-endian writer.
 *
 * `done()` asserting the exact length is the point: every header below computes its size
 * twice, once to allocate and once by writing it, and a mismatch between the two is
 * precisely the bug that produces an archive no tool will open.
 */
class ByteWriter {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(value: number): this {
    this.view.setUint16(this.offset, value & 0xffff, true);
    this.offset += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
    return this;
  }

  u64(value: number): this {
    this.view.setBigUint64(this.offset, BigInt(value), true);
    this.offset += 8;
    return this;
  }

  raw(data: Uint8Array): this {
    this.bytes.set(data, this.offset);
    this.offset += data.length;
    return this;
  }

  done(): Uint8Array {
    if (this.offset !== this.bytes.length) {
      throw new Error(
        `Zip header wrote ${this.offset} bytes into a ${this.bytes.length}-byte field.`,
      );
    }
    return this.bytes;
  }
}

/**
 * MS-DOS date and time, the only timestamp a base zip carries.
 *
 * The year field is 7 bits from a 1980 epoch, so anything outside 1980-2107 is clamped
 * rather than allowed to wrap into a nonsense date. An unreadable mtime (a filesystem that
 * returned NaN) falls back to now for the same reason.
 */
export function dosDateTime(date: Date): { date: number; time: number } {
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = Math.min(2107, Math.max(1980, safe.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate(),
    time: (safe.getHours() << 11) | (safe.getMinutes() << 5) | (safe.getSeconds() >> 1),
  };
}

/**
 * Already-compressed bytes are stored; everything else is deflated.
 *
 * A real library is mostly card and background images, which deflate spends CPU on to
 * save a fraction of a percent. The database and the JSON are where the compression is.
 */
const STORED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.mp4',
  '.webm',
  '.mp3',
  '.ogg',
  '.zip',
  '.gz',
]);

export function compressionFor(name: string): 0 | 8 {
  if (name.endsWith('/')) return 0;
  const dot = name.lastIndexOf('.');
  if (dot === -1) return 8;
  return STORED_EXTENSIONS.has(name.slice(dot).toLowerCase()) ? 0 : 8;
}

export function localFileHeader(rec: EntryRecord): Uint8Array {
  const name = new TextEncoder().encode(rec.name);
  const { date, time } = dosDateTime(rec.mtime);

  /*
   * The local header's zip64 field must carry BOTH sizes when either one overflows — unlike
   * the directory record below, which carries only the fields that actually overflowed. The
   * local header has no offset field, so the offset never decides anything here.
   */
  const big = rec.uncompressedSize > U32_MAX || rec.compressedSize > U32_MAX;
  const extraLength = big ? 20 : 0;

  const out = new ByteWriter(30 + name.length + extraLength);
  out.u32(LOCAL_SIG);
  out.u16(big ? VERSION_ZIP64 : VERSION_BASE);
  out.u16(FLAG_UTF8);
  out.u16(rec.method);
  out.u16(time).u16(date);
  out.u32(rec.crc);
  out.u32(big ? U32_MAX : rec.compressedSize);
  out.u32(big ? U32_MAX : rec.uncompressedSize);
  out.u16(name.length).u16(extraLength);
  out.raw(name);
  if (big) {
    out.u16(ZIP64_EXTRA_ID).u16(16).u64(rec.uncompressedSize).u64(rec.compressedSize);
  }
  return out.done();
}

export function centralDirectoryRecord(rec: EntryRecord): Uint8Array {
  const name = new TextEncoder().encode(rec.name);
  const { date, time } = dosDateTime(rec.mtime);
  const isDirectory = rec.name.endsWith('/');

  const bigUncompressed = rec.uncompressedSize > U32_MAX;
  const bigCompressed = rec.compressedSize > U32_MAX;
  const bigOffset = rec.localOffset > U32_MAX;

  // Spec order for the zip64 extra field is fixed — uncompressed, compressed, offset, disk —
  // and only the fields whose classic counterpart holds the sentinel are present at all.
  const zip64Fields = Number(bigUncompressed) + Number(bigCompressed) + Number(bigOffset);
  const extraLength = zip64Fields === 0 ? 0 : 4 + zip64Fields * 8;

  const out = new ByteWriter(46 + name.length + extraLength);
  out.u32(CENTRAL_SIG);
  out.u16(VERSION_MADE_BY);
  out.u16(zip64Fields === 0 ? VERSION_BASE : VERSION_ZIP64);
  out.u16(FLAG_UTF8);
  out.u16(rec.method);
  out.u16(time).u16(date);
  out.u32(rec.crc);
  out.u32(bigCompressed ? U32_MAX : rec.compressedSize);
  out.u32(bigUncompressed ? U32_MAX : rec.uncompressedSize);
  out.u16(name.length).u16(extraLength).u16(0);
  out.u16(0); // disk number start
  out.u16(0); // internal attributes
  // Unix mode in the high half; the low half keeps the DOS directory bit for old readers.
  out.u32(((rec.mode & 0xffff) << 16) | (isDirectory ? 0x10 : 0));
  out.u32(bigOffset ? U32_MAX : rec.localOffset);
  out.raw(name);
  if (zip64Fields > 0) {
    out.u16(ZIP64_EXTRA_ID).u16(zip64Fields * 8);
    if (bigUncompressed) out.u64(rec.uncompressedSize);
    if (bigCompressed) out.u64(rec.compressedSize);
    if (bigOffset) out.u64(rec.localOffset);
  }
  return out.done();
}

/**
 * The end record, preceded by a zip64 EOCD and locator when any of the three values
 * overflows its classic field. Emitting zip64 only when it is needed keeps ordinary
 * archives readable by tools that predate it.
 */
export function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const big = count > U16_MAX || size > U32_MAX || offset > U32_MAX;

  const out = new ByteWriter((big ? 76 : 0) + 22);
  if (big) {
    out.u32(ZIP64_EOCD_SIG);
    out.u64(44); // size of this record beyond these first twelve bytes
    out.u16(VERSION_MADE_BY);
    out.u16(VERSION_ZIP64);
    out.u32(0).u32(0);
    out.u64(count).u64(count);
    out.u64(size).u64(offset);

    out.u32(ZIP64_LOCATOR_SIG);
    out.u32(0);
    // The zip64 end record begins where the central directory finishes.
    out.u64(offset + size);
    out.u32(1);
  }

  out.u32(EOCD_SIG);
  out.u16(0).u16(0);
  out.u16(big ? U16_MAX : count).u16(big ? U16_MAX : count);
  out.u32(big ? U32_MAX : size);
  out.u32(big ? U32_MAX : offset);
  out.u16(0); // no archive comment
  return out.done();
}

/** One file to put in the archive. `read` is called once, and only when its turn comes. */
export interface ZipSource {
  /** Forward-slash path inside the archive. A trailing slash marks a directory entry. */
  name: string;
  mtime: Date;
  mode?: number;
  read(): Promise<Uint8Array>;
}

/**
 * Stream the sources as one zip.
 *
 * Pull-based on purpose: one entry per pull means the consumer's backpressure paces the
 * reads, so peak memory is the largest single file rather than the whole library.
 *
 * `onSettled` runs exactly once, on close, on error, and on cancel — it is where a caller
 * releases whatever the archive was holding open. A browser that abandons a download
 * reaches here through cancel and nowhere else.
 */
export function zipStream(
  sources: ZipSource[],
  onSettled: () => void = () => {},
): ReadableStream<Uint8Array> {
  const records: EntryRecord[] = [];
  let index = 0;
  let offset = 0;
  let settled = false;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    onSettled();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (index < sources.length) {
          const source = sources[index++]!;
          const isDirectory = source.name.endsWith('/');
          const body = isDirectory ? EMPTY : await source.read();

          let method = compressionFor(source.name);
          let payload: Uint8Array = body;
          if (method === 8) {
            const deflated = deflateRawSync(body);
            // Deflate grows incompressible data. Storing it is both smaller and cheaper to
            // read back, so the extension list above is a shortcut rather than the rule.
            if (deflated.length < body.length) payload = deflated;
            else method = 0;
          }

          const record: EntryRecord = {
            name: source.name,
            method,
            crc: crc32(body),
            compressedSize: payload.length,
            uncompressedSize: body.length,
            localOffset: offset,
            mtime: source.mtime,
            mode: source.mode ?? (isDirectory ? 0o040755 : 0o100644),
          };
          records.push(record);

          const header = localFileHeader(record);
          controller.enqueue(header);
          if (payload.length > 0) controller.enqueue(payload);
          offset += header.length + payload.length;
          return;
        }

        const directoryOffset = offset;
        let directorySize = 0;
        for (const record of records) {
          const entry = centralDirectoryRecord(record);
          controller.enqueue(entry);
          directorySize += entry.length;
        }
        controller.enqueue(endOfCentralDirectory(records.length, directorySize, directoryOffset));
        controller.close();
        settle();
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    cancel() {
      settle();
    },
  });
}
