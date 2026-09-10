import { type AssembleOptions, assemblePrompt } from '@shared/prompt/assemble.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import { memoizeCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { GroupMember, GroupScene } from '@shared/types/group.ts';
import type { WorldInfoBook, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { characterApi, lorebookApi, presetApi } from '../../lib/api.ts';
import { encodingForModel, loadCounter } from '../../lib/tokenizer.ts';
import { composeLorebookSources } from '../lore/useLorebooks.ts';
import { worldInfoForChat } from '../lore/worldInfoForChat.ts';

export function groupConnection(connections: Connection[], id: string, model: string): Connection {
  const connection = connections.find((c) => c.id === id);
  if (!connection || !model.trim())
    throw new Error('Choose a saved connection and model in group settings.');
  return { ...connection, model };
}
export async function memberResources(
  scene: GroupScene,
  member: GroupMember,
  connections: Connection[],
  encoding?: string,
) {
  const config = { ...scene.generation, ...member.generation };
  const connection = groupConnection(connections, config.connectionId, config.model);
  if (!config.presetId) throw new Error(`Choose a preset for ${member.name}.`);
  const [detail, preset, raw] = await Promise.all([
    characterApi.get(member.characterId),
    presetApi.get(config.presetId),
    loadCounter(encodingForModel(config.model, encoding)),
  ]);
  return {
    card: detail.card.data,
    preset,
    presetId: config.presetId,
    connection,
    counter: memoizeCounter(raw),
  };
}

export async function assembleMember(
  resources: Awaited<ReturnType<typeof memberResources>>,
  scene: GroupScene,
  memberId: string,
  input: Omit<AssembleOptions, 'character' | 'preset' | 'countTokens' | 'group'>,
  globalBooks: string[],
  persona: Persona | null,
  worldInfoSettings: WorldInfoSettings,
  chatId: string,
) {
  const { card, preset, counter } = resources;
  const linkedName = typeof card.extensions?.world === 'string' ? card.extensions.world : null;
  const ids = [
    ...new Set([
      ...globalBooks,
      ...scene.lorebookIds,
      ...(linkedName ? [linkedName] : []),
      ...(persona?.lorebookId ? [persona.lorebookId] : []),
    ]),
  ];
  const loaded = Object.fromEntries(
    await Promise.all(ids.map(async (id) => [id, await lorebookApi.get(id)])),
  ) as Record<string, WorldInfoBook>;
  const sources = composeLorebookSources({
    character: card,
    linkedName,
    loaded,
    globalIds: [...globalBooks, ...scene.lorebookIds],
    personaId: persona?.lorebookId ?? undefined,
  });
  const lore = worldInfoForChat({
    sources,
    messages: input.messages,
    settings: worldInfoSettings,
    preset: { ...preset, names_behavior: 2 },
    chatId,
    countTokens: counter,
  });
  return assemblePrompt({
    ...input,
    character: card,
    preset,
    countTokens: counter,
    persona,
    group: { scene, memberId },
    worldInfoBefore: lore?.before,
    worldInfoAfter: lore?.after,
    worldInfoDepth: lore?.depth,
  });
}
export function directorBody(
  scene: GroupScene,
  connection: Connection,
  messages: Parameters<typeof buildRequestBody>[0]['messages'],
) {
  return buildRequestBody({
    connection,
    messages,
    completions: 1,
    stream: false,
    preset: {
      ...createDefaultPreset(),
      openai_max_tokens: scene.director.maxTokens,
      openai_max_context: scene.director.contextTokens,
      temperature: 0.3,
      reasoning_effort: 'low',
    },
  });
}
