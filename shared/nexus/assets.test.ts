import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import manifest from '../../public/models/bge-small-en-v1.5/manifest.json';
import { NEXUS_MODEL_FINGERPRINT } from './model.ts';

test('offline model bundle matches its pinned manifest', async () => {
  for (const [file, entry] of Object.entries(manifest.files)) {
    const buffer = await Bun.file(
      new URL(`../../public/models/bge-small-en-v1.5/${file}`, import.meta.url),
    ).arrayBuffer();
    expect(buffer.byteLength).toBe(entry.bytes);
    expect(createHash('sha256').update(new Uint8Array(buffer)).digest('hex')).toBe(entry.sha256);
  }
  expect(NEXUS_MODEL_FINGERPRINT).toContain(
    manifest.files['onnx/model_quantized.onnx'].sha256.slice(0, 16),
  );
});
