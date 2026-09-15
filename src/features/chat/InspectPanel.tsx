import type { MemoryRecall } from '@shared/memory/source.ts';
import type { NexusRecall } from '@shared/nexus/types.ts';
import type { ActivationResult } from '@shared/worldinfo/activate.ts';
import { Section } from '../../components/Section.tsx';
import { NexusReport } from '../nexus/NexusReport.tsx';
import { PromptInspector } from './PromptInspector.tsx';
import type { PromptInspection } from './state/chatReducer.ts';
import { WorldInfoReport } from './WorldInfoReport.tsx';

interface InspectPanelProps {
  /** The last generation's result when there is one, else the live preview. */
  worldInfo: ActivationResult | null;
  /**
   * The last generation's memory pass. Its own section because it is its own pass, with
   * its own budget — reporting the two together would imply they compete, and they do not.
   */
  memoryRecall: MemoryRecall | null;
  nexusRecall?: NexusRecall | null;
  nexusPreview?: NexusRecall;
  inspection: PromptInspection | null;
}

/** Read-only diagnostics: what fired, and what was actually sent. */
export function InspectPanel({
  worldInfo,
  memoryRecall,
  nexusRecall,
  nexusPreview,
  inspection,
}: InspectPanelProps) {
  return (
    <>
      <Section title="World Info" defaultOpen>
        <WorldInfoReport result={worldInfo} />
      </Section>
      <Section title="Nexus request">
        <NexusReport recall={nexusRecall} />
      </Section>
      <Section title="Nexus preview">
        <NexusReport recall={nexusPreview} />
      </Section>
      <Section title="Legacy memory recall">
        <WorldInfoReport
          result={memoryRecall?.activation ?? null}
          emptyLabel="No memories were recalled for this chat."
        />
      </Section>
      <Section title="Last request" defaultOpen>
        <PromptInspector inspection={inspection} />
      </Section>
    </>
  );
}
