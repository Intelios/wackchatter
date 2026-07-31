/**
 * Minimal PNG chunk reader/writer — just enough to read and write tEXt metadata.
 *
 * We never touch the image data. Character cards are transported by splicing tEXt chunks
 * into an otherwise untouched PNG, so there is no need for an image codec, and avoiding
 * one keeps the install light (SillyTavern pulls in png-chunks-extract + png-chunk-text
 * for the same job, and jimp for resizing).
 *
 * Chunk framing per the PNG spec:
 *   [4-byte BE length][4-byte ASCII type][length bytes of data][4-byte BE CRC32 of type+data]
 * preceded by the 8-byte signature.
 */

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngChunk {
  name: string;
  data: Uint8Array;
}

// --- CRC32 (PNG variant: reflected, polynomial 0xEDB88320, init/final XOR 0xFFFFFFFF) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * Split a PNG into its chunks, in file order.
 * @throws if the signature is missing or a chunk runs past the end of the buffer.
 */
export function extractChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) {
    throw new Error('Not a PNG file (bad signature).');
  }

  const chunks: PngChunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error(`Truncated PNG: chunk header at ${offset} runs past end of file.`);
    }

    const length = view.getUint32(offset);
    const name = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );

    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`Truncated PNG: chunk "${name}" declares ${length} bytes but the file ends.`);
    }

    chunks.push({ name, data: bytes.subarray(dataStart, dataEnd) });

    // Skip the trailing CRC. We don't verify on read — a card with a stale CRC in an
    // ancillary chunk is still readable, and rejecting it would lose the user's character.
    offset = dataEnd + 4;

    if (name === 'IEND') break;
  }

  return chunks;
}

/** Reassemble chunks into a complete PNG, recomputing every CRC. */
export function encodeChunks(chunks: PngChunk[]): Uint8Array {
  let totalLength = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    totalLength += 12 + chunk.data.length; // length + type + data + crc
  }

  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;

  for (const chunk of chunks) {
    view.setUint32(offset, chunk.data.length);
    offset += 4;

    // type + data must be contiguous for the CRC, so write them then checksum in place.
    const typeStart = offset;
    for (let i = 0; i < 4; i++) {
      out[offset + i] = chunk.name.charCodeAt(i);
    }
    offset += 4;
    out.set(chunk.data, offset);
    offset += chunk.data.length;

    view.setUint32(offset, crc32(out.subarray(typeStart, offset)));
    offset += 4;
  }

  return out;
}

// --- tEXt chunks ---

export interface TextChunk {
  keyword: string;
  text: string;
}

/**
 * Decode a tEXt chunk's payload: `<keyword><0x00><text>`.
 * Both halves are Latin-1 per the PNG spec — the card JSON is base64 inside, so it is
 * ASCII-safe regardless.
 */
export function decodeTextChunk(data: Uint8Array): TextChunk {
  const separator = data.indexOf(0);
  if (separator === -1) {
    throw new Error('Malformed tEXt chunk: no null separator.');
  }

  let keyword = '';
  for (let i = 0; i < separator; i++) {
    keyword += String.fromCharCode(data[i]!);
  }

  let text = '';
  for (let i = separator + 1; i < data.length; i++) {
    text += String.fromCharCode(data[i]!);
  }

  return { keyword, text };
}

/** Build a tEXt chunk from a keyword and (Latin-1 safe) text. */
export function encodeTextChunk(keyword: string, text: string): PngChunk {
  const data = new Uint8Array(keyword.length + 1 + text.length);
  for (let i = 0; i < keyword.length; i++) {
    data[i] = keyword.charCodeAt(i) & 0xff;
  }
  data[keyword.length] = 0;
  for (let i = 0; i < text.length; i++) {
    data[keyword.length + 1 + i] = text.charCodeAt(i) & 0xff;
  }
  return { name: 'tEXt', data };
}

/** Every tEXt chunk in the file, decoded, in file order. */
export function readTextChunks(bytes: Uint8Array): TextChunk[] {
  return extractChunks(bytes)
    .filter((chunk) => chunk.name === 'tEXt')
    .map((chunk) => decodeTextChunk(chunk.data));
}

/**
 * Replace the tEXt chunks whose keyword matches one of `keywords` (case-insensitive)
 * with the supplied entries, spliced in immediately before IEND.
 */
export function replaceTextChunks(
  bytes: Uint8Array,
  keywords: string[],
  entries: TextChunk[],
): Uint8Array {
  const lowered = keywords.map((k) => k.toLowerCase());

  const kept = extractChunks(bytes).filter((chunk) => {
    if (chunk.name !== 'tEXt') return true;
    try {
      return !lowered.includes(decodeTextChunk(chunk.data).keyword.toLowerCase());
    } catch {
      return true; // leave chunks we can't parse alone
    }
  });

  const iendIndex = kept.findIndex((chunk) => chunk.name === 'IEND');
  const insertAt = iendIndex === -1 ? kept.length : iendIndex;
  const newChunks = entries.map((entry) => encodeTextChunk(entry.keyword, entry.text));

  kept.splice(insertAt, 0, ...newChunks);
  return encodeChunks(kept);
}
