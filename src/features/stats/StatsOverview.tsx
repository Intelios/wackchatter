import type { CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { StatsOverview as Overview } from '@shared/types/stats.ts';
import { useMemo } from 'react';
import { characterApi } from '../../lib/api.ts';
import {
  activeDayCount,
  busiestDay,
  foldDays,
  foldHourOfDay,
  foldWeekday,
  recentDays,
  streaks,
} from './buckets.ts';
import { BarRows } from './charts/BarRows.tsx';
import { ColumnChart } from './charts/ColumnChart.tsx';
import { Donut } from './charts/Donut.tsx';
import { HourDial } from './charts/HourDial.tsx';
import { ModelTable } from './charts/ModelTable.tsx';
import { StatFacts } from './charts/StatFacts.tsx';
import { StatTile } from './charts/StatTile.tsx';
import { compact, count, duration, fullDayLabel, hourLabel, percent, WEEKDAYS } from './format.ts';
import { StatSection } from './StatSection.tsx';

/** How far back the daily chart reaches when there is that much history. */
const DAY_WINDOW = 84;

interface StatsOverviewProps {
  stats: Overview;
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
  onOpenCharacter: (avatar: string) => void;
}

export function StatsOverview({
  stats,
  characters,
  personas,
  onOpenCharacter,
}: StatsOverviewProps) {
  const { totals, habits } = stats;

  /*
   * Names are resolved here rather than server-side: the app already holds both lists, and
   * a card or persona that has since been deleted falls back to its raw id instead of
   * vanishing from its own history.
   */
  const characterName = useMemo(() => {
    const byAvatar = new Map(characters.map((entry) => [entry.avatar, entry.name]));
    return (avatar: string) => byAvatar.get(avatar) ?? avatar;
  }, [characters]);

  const personaName = useMemo(() => {
    const byId = new Map(personas.map((entry) => [entry.id, entry.name]));
    return (id: string) => (id === '' ? 'No persona' : (byId.get(id) ?? 'Deleted persona'));
  }, [personas]);

  const days = useMemo(() => foldDays(stats.hours), [stats.hours]);
  const dayWindow = useMemo(() => recentDays(days, DAY_WINDOW), [days]);
  const hourOfDay = useMemo(() => foldHourOfDay(stats.hours), [stats.hours]);
  const weekdays = useMemo(() => foldWeekday(stats.hours), [stats.hours]);
  const streak = useMemo(() => streaks(days), [days]);
  const busiest = busiestDay(days);
  const top = stats.cast[0];

  if (totals.chats === 0) {
    return (
      <div className="wc-empty">
        <p>No chats yet — your stats will fill in as you play.</p>
      </div>
    );
  }

  return (
    <div className="stats-page">
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
        <StatTile
          label="Tokens generated"
          value={totals.tokens}
          format={compact}
          hint="completion only — never a cost"
          index={2}
        />
        <StatTile
          label="Time in scene"
          value={totals.activeMinutes}
          format={duration}
          hint={`across ${count(activeDayCount(days))} days`}
          index={3}
        />
        <StatTile
          label="Longest streak"
          value={streak.longest}
          format={(value) => `${count(value)}d`}
          hint={streak.current > 0 ? `${count(streak.current)} running` : 'not running'}
          index={4}
        />
      </div>

      {top ? (
        <StatSection eyebrow="Most played" title={characterName(top.characterId)} index={1}>
          <button
            type="button"
            className="stats-hero"
            onClick={() => onOpenCharacter(top.characterId)}
          >
            <img
              className="stats-hero__avatar"
              src={characterApi.imageUrl(top.characterId)}
              alt=""
            />
            <div className="stats-hero__facts">
              <StatFacts
                facts={[
                  { label: 'Chats', value: count(top.chats) },
                  { label: 'Messages', value: count(top.messages) },
                  {
                    label: 'Share of everything',
                    value: percent(top.messages, totals.messages),
                  },
                  { label: 'Tokens', value: compact(top.tokens) },
                ]}
              />
              <span className="stats-hero__cue">See their stats →</span>
            </div>
          </button>
        </StatSection>
      ) : null}

      <StatSection
        eyebrow="The cast"
        title="Who you spend it with"
        hint="By messages exchanged. Pick one to go deeper."
        index={2}
      >
        <BarRows
          rows={stats.cast.map((entry) => ({
            id: entry.characterId,
            label: characterName(entry.characterId),
            value: entry.messages,
            display: count(entry.messages),
            hint: `${count(entry.chats)} chats · ${compact(entry.tokens)} tokens`,
            avatarUrl: characterApi.imageUrl(entry.characterId),
          }))}
          onSelect={onOpenCharacter}
        />
      </StatSection>

      <StatSection
        eyebrow="Models"
        title="What is doing the writing"
        hint="Counted per generation, including takes you swiped past."
        index={3}
        split
      >
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

      <StatSection
        eyebrow="Personas"
        title="Who you show up as"
        hint="By messages you sent as each."
        index={4}
      >
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
        title="When you play"
        hint={busiest ? `Busiest day: ${fullDayLabel(busiest.day)}.` : undefined}
        index={5}
      >
        <ColumnChart days={dayWindow} />
        <div className="stats-rhythm">
          <HourDial hours={hourOfDay} />
          <div className="stats-rhythm__weekdays">
            <BarRows
              rows={weekdays.map((value, index) => ({
                id: WEEKDAYS[index] ?? String(index),
                label: WEEKDAYS[index] ?? String(index),
                value,
                display: count(value),
                series: 1,
              }))}
            />
          </div>
        </div>
      </StatSection>

      <StatSection eyebrow="Habits" title="How you play" index={6}>
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
            { label: 'Co-Creator sessions', value: count(stats.coCreatorSessions) },
            {
              label: 'Peak hour',
              value: hourLabel(
                hourOfDay.reduce(
                  (best, value, index) => (value > (hourOfDay[best] ?? 0) ? index : best),
                  0,
                ),
              ),
            },
            stats.longestChat
              ? {
                  label: 'Longest chat',
                  value: `${count(stats.longestChat.messages)} messages`,
                  hint: stats.longestChat.title,
                }
              : { label: 'Longest chat', value: '—' },
          ]}
        />
      </StatSection>
    </div>
  );
}
