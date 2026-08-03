import type { ActivationResult } from '@shared/worldinfo/activate.ts';
import { Section } from '../../components/Section.tsx';
import { PromptInspector } from './PromptInspector.tsx';
import type { PromptInspection } from './state/chatReducer.ts';
import { WorldInfoReport } from './WorldInfoReport.tsx';

interface InspectPanelProps {
  /** The last generation's result when there is one, else the live preview. */
  worldInfo: ActivationResult | null;
  inspection: PromptInspection | null;
}

/** Read-only diagnostics: what fired, and what was actually sent. */
export function InspectPanel({ worldInfo, inspection }: InspectPanelProps) {
  return (
    <>
      <Section title="World Info" defaultOpen>
        <WorldInfoReport result={worldInfo} />
      </Section>
      <Section title="Last request" defaultOpen>
        <PromptInspector inspection={inspection} />
      </Section>
    </>
  );
}
