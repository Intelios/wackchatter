import type { FeatureExtractionPipeline } from '@huggingface/transformers';

/** Tokenizer-aware splitting avoids the model's silent 512-token truncation. */
export async function encodeText(
  pipe: FeatureExtractionPipeline,
  text: string,
  query = false,
): Promise<number[]> {
  const prefix = query ? 'Represent this sentence for searching relevant passages: ' : '';
  const pieces: string[] = [];
  const split = (part: string) => {
    const tokens = pipe.tokenizer(prefix + part, { truncation: false });
    if (tokens.input_ids.size <= 500 || part.length < 2) {
      pieces.push(part);
      return;
    }
    const middle = Math.floor(part.length / 2);
    const boundary = part.lastIndexOf(' ', middle);
    const cut = boundary > middle / 2 ? boundary : middle;
    split(part.slice(0, cut));
    split(part.slice(cut));
  };
  split(text);
  const result = Array<number>(384).fill(0);
  for (const piece of pieces) {
    const output = await pipe(prefix + piece, { pooling: 'cls', normalize: true });
    for (let i = 0; i < result.length; i++)
      result[i] = result[i]! + Number(output.data[i]) / pieces.length;
  }
  const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
  return result.map((v) => (norm ? v / norm : 0));
}
