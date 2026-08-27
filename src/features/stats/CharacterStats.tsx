import type { CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { CharacterStats as CardStats } from '@shared/types/stats.ts';
import { useMemo } from 'react';
import { characterApi } from '../../lib/api.ts';
import { personaDisplayName } from '../persona/personaRoster.ts';
import { activeDayCount, busiestDay, foldDays, foldHourOfDay, recentDays } from './buckets.ts';
import { BarRows } from './charts/BarRows.tsx';
import { ColumnChart } from './charts/ColumnChart.tsx';
import { Donut } from './charts/Donut.tsx';
import { HourDial } from './charts/HourDial.tsx';
import { ModelTable } from './charts/ModelTable.tsx';
import { StatFacts } from './charts/StatFacts.tsx';
import { StatTile } from './charts/StatTile.tsx';
import { compact, count, duration, fullDayLabel, monthYearLabel, percent } from './format.ts';
import { StatSection } from './StatSection.tsx';

const DAY_WINDOW = 84;

interface CharacterStatsProps {
  stats: CardStats;
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
}

/** One card's history, in the same vocabulary as the overview so the two read as one screen. */
export function CharacterStats({ stats, characters, personas }: CharacterStatsProps) {
  const { totals, habits } = stats;

  const name = useMemo(
    () => characters.find((entry) => entry.avatar === stats.characterId)?.name ?? stats.characterId,
    [characters, stats.characterId],
  );

  const personaName = useMemo(() => {
    // Variant labels included — same reason as the overview: two rows both reading
    // "John Doe" would hide the one difference between them.
    const byId = new Map(personas.map((entry) => [entry.id, personaDisplayName(entry)]));
    return (id: string) => (id === '' ? 'No persona' : (byId.get(id) ?? 'Deleted persona'));
  }, [personas]);

  const days = useMemo(() => foldDays(stats.hours), [stats.hours]);
  const dayWindow = useMemo(() => recentDays(days, DAY_WINDOW), [days]);
  const hourOfDay = useMemo(() => foldHourOfDay(stats.hours), [stats.hours]);
  const busiest = busiestDay(days);

  if (totals.chats === 0) {
    return (
      <div className="wc-empty">
        <p>No chats with {name} yet.</p>
      </div>
    );
  }

  return (
    <div className="stats-page">
      <div className="stats-card-hero">
        <img
          className="stats-card-hero__avatar"
          src={characterApi.imageUrl(stats.characterId)}
          alt=""
        />
        <div>
          <p className="stats-section__eyebrow">Together since</p>
          <h1>{stats.firstChat === null ? name : monthYearLabel(stats.firstChat)}</h1>
          <p className="wc-hint">
            {stats.lastChat === null
              ? name
              : `Last spoke ${fullDayLabel(stats.lastChat)} · ${count(activeDayCount(days))} days together`}
          </p>
        </div>
      </div>

      <div className="stats-tiles">
        <StatTile label="Chats" value={totals.chats} format={count} index={0} />
        <StatTile
          label="Messages"
          value={totals.messages}
          format={count}
          hint={`${count(totals.userMessages)} from you`}
          index={1}
          hero
        />
        <StatTile label="Tokens" value={totals.tokens} format={compact} index={2} />
        <StatTile label="Time in scene" value={totals.activeMinutes} format={duration} index={3} />
        <StatTile
          label="Avg per chat"
          value={totals.chats > 0 ? Math.round(totals.messages / totals.chats) : 0}
          format={count}
          hint="messages"
          index={4}
        />
      </div>

      <StatSection
        eyebrow="Chats"
        title="The long conversations"
        hint="By length. The top fifty."
        index={1}
      >
        <BarRows
          rows={stats.chats.map((chat, index) => ({
            id: chat.id,
            label: chat.title,
            value: chat.messages,
            display: count(chat.messages),
            hint: `${compact(chat.tokens)} tokens · last touched ${fullDayLabel(chat.modified)}`,
            series: index,
          }))}
        />
      </StatSection>

      <StatSection eyebrow="Models" title={`Who has been writing ${name}`} index={2} split>
        <Donut
          slices={stats.models.map((model) => ({
            id: `${model.model}:${model.api}`,
            label: model.model,
            value: model.swipes,
            detail: count(model.swipes),
          }))}
          totalLabel={count(totals.swipes)}
          totalHint="generations"
        />
        <ModelTable models={stats.models} />
      </StatSection>

      <StatSection eyebrow="Personas" title={`Who you are to ${name}`} index={3}>
        <BarRows
          rows={stats.personas.map((persona, index) => ({
            id: persona.personaId || 'none',
            label: personaName(persona.personaId),
            value: persona.messages,
            display: count(persona.messages),
            hint: `${count(persona.chats)} chats`,
            series: index,
          }))}
        />
      </StatSection>

      <StatSection
        eyebrow="Rhythm"
        title="When you two talk"
        hint={busiest ? `Busiest day: ${fullDayLabel(busiest.day)}.` : undefined}
        index={4}
      >
        <ColumnChart days={dayWindow} />
        <div className="stats-rhythm">
          <HourDial hours={hourOfDay} />
        </div>
      </StatSection>

      <StatSection eyebrow="Habits" title={`How ${name} reads`} index={5}>
        <StatFacts
          facts={[
            {
              label: 'Replies you rerolled',
              value: `${percent(habits.rerolledReplies, habits.eligibleReplies)} (${count(habits.rerolls)} rerolls)`,
              hint: 'Opening greetings excluded — alternate greetings are not rerolls.',
            },
            { label: 'Your average message', value: `${count(habits.avgUserChars)} chars` },
            { label: 'Their average reply', value: `${count(habits.avgReplyChars)} chars` },
            { label: 'Longest single reply', value: `${count(habits.longestReplyChars)} chars` },
            {
              label: 'Replies that thought first',
              value: percent(habits.reasoningSwipes, totals.swipes),
            },
            { label: 'Branches taken', value: count(habits.branchedChats) },
            { label: 'Chats in the bin', value: count(habits.deletedChats) },
          ]}
        />
      </StatSection>
    </div>
  );
}
