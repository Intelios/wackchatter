/** Maintainer-only acquisition. Runtime never downloads model weights. */

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const model = 'Xenova/bge-small-en-v1.5';
const revision = 'ea104da';
const root = new URL('../public/models/bge-small-en-v1.5/', import.meta.url);
const info = (await fetch(`https://huggingface.co/api/models/${model}/revision/${revision}`).then(
  (r) => r.json(),
)) as { sha: string };
if (!info.sha) throw new Error('Could not resolve the pinned model revision.');
const files = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'onnx/model_quantized.onnx',
];
const hashes: Record<string, { bytes: number; sha256: string }> = {};
await mkdir(new URL('onnx/', root), { recursive: true });
for (const name of files) {
  const response = await fetch(`https://huggingface.co/${model}/resolve/${info.sha}/${name}`);
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(new URL(name, root), bytes);
  hashes[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  console.log(name, bytes.length);
}
await Bun.write(
  new URL('manifest.json', root),
  JSON.stringify(
    {
      model,
      revision: info.sha,
      upstream: 'BAAI/bge-small-en-v1.5',
      license: 'MIT',
      pooling: 'cls',
      normalize: true,
      dimensions: 384,
      files: hashes,
    },
    null,
    2,
  ) + '\n',
);
const license = await fetch(
  'https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/LICENSE',
);
if (!license.ok) throw new Error('Could not read upstream licence.');
await Bun.write(new URL('LICENSE', root), await license.text());
