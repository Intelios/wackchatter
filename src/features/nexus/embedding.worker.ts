import { env, type FeatureExtractionPipeline, pipeline } from '@huggingface/transformers';
import { NEXUS_MODEL } from '@shared/nexus/model.ts';
import { encodeText } from './embeddingModel.ts';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = false;
env.backends.onnx.wasm!.wasmPaths = '/nexus-runtime/';
env.backends.onnx.wasm!.numThreads = 1;
const createPipeline = pipeline as unknown as (
  task: string,
  model: string,
  options: object,
) => Promise<FeatureExtractionPipeline>;
let model: Promise<FeatureExtractionPipeline> | undefined;
self.onmessage = async (event: MessageEvent<{ id: number; text: string; query: boolean }>) => {
  const { id, text, query } = event.data;
  try {
    model ??= createPipeline('feature-extraction', NEXUS_MODEL, { dtype: 'q8', device: 'wasm' });
    const vector = await encodeText(await model, text, query);
    self.postMessage({ id, vector });
  } catch (error) {
    model = undefined;
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
