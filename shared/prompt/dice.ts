/**
 * Dice.
 *
 * Its own module rather than a helper inside `macros.ts` because two callers want two
 * different things from one roll: `{{roll}}` wants the total and nothing else, while
 * `/roll` wants the individual dice so the transcript can show its working.
 *
 * The grammar is droll's, which is the library SillyTavern hands `{{roll}}` to. That is the
 * whole specification: a formula written for a card in ST has to roll here, and one written
 * here has to roll there.
 */

/** One resolved roll. `rolls` holds the dice as they fell, before the modifier. */
export interface DiceRoll {
  /** Normalised — a bare `20` comes back as `1d20`, matching what ST rolls. */
  formula: string;
  rolls: number[];
  modifier: number;
  total: number;
}

/**
 * Bounds droll does not have.
 *
 * ST validates the shape and then loops, so `{{roll:99999999d6}}` in a card is a hang. That
 * text now runs on every send as well as every assembly, so the loop needs a ceiling. Both
 * limits sit far above any formula a person would write, and past them the formula is
 * treated as invalid — the same empty string ST already produces for a malformed one.
 */
const MAX_DICE = 1000;
const MAX_SIDES = 1_000_000;

/** droll's grammar: an optional count, `d`, sides, and an optional flat modifier. */
const FORMULA = /^(\d*)d(\d+)([+-]\d+)?$/i;

export interface DiceFormula {
  count: number;
  sides: number;
  modifier: number;
  /** The formula as it will be reported, with the implied count made explicit. */
  formula: string;
}

/** Parse without rolling. Null means "not a formula", which callers render as empty. */
export function parseDiceFormula(input: string): DiceFormula | null {
  const raw = input.trim();
  // A bare number is `1dN` — ST's `isDigitsOnly` branch, and the reason `{{roll:6}}` works.
  const normalised = /^\d+$/.test(raw) ? `1d${raw}` : raw;

  const match = FORMULA.exec(normalised);
  if (!match) return null;

  const count = match[1] ? Number(match[1]) : 1;
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;

  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_DICE) return null;
  if (!Number.isSafeInteger(sides) || sides < 1 || sides > MAX_SIDES) return null;

  const suffix = modifier === 0 ? '' : modifier > 0 ? `+${modifier}` : String(modifier);
  return { count, sides, modifier, formula: `${count}d${sides}${suffix}` };
}

export function rollDice(input: string): DiceRoll | null {
  const parsed = parseDiceFormula(input);
  if (!parsed) return null;

  const rolls: number[] = [];
  for (let i = 0; i < parsed.count; i++) {
    rolls.push(Math.floor(Math.random() * parsed.sides) + 1);
  }

  const total = rolls.reduce((sum, value) => sum + value, 0) + parsed.modifier;
  return { formula: parsed.formula, rolls, modifier: parsed.modifier, total };
}

/**
 * The line `/roll` posts into the transcript.
 *
 * The model reads this, so it is plain prose with the arithmetic spelled out rather than a
 * bare number: a character can react to "you rolled a 3 and a 4" in a way it cannot react
 * to `7`. The working is dropped for a single unmodified die, where `14 = 14` is noise.
 */
export function formatRoll(roll: DiceRoll): string {
  const bare = roll.rolls.length === 1 && roll.modifier === 0;
  if (bare) return `🎲 ${roll.formula}: ${roll.total}`;

  const parts = roll.rolls.map(String);
  if (roll.modifier !== 0) {
    parts.push(`${roll.modifier > 0 ? '+' : '-'} ${Math.abs(roll.modifier)}`);
  }
  // The modifier already carries its own sign, so it is joined without another plus.
  const working = parts.reduce((line, part) =>
    part.startsWith('+ ') || part.startsWith('- ') ? `${line} ${part}` : `${line} + ${part}`,
  );
  return `🎲 ${roll.formula}: ${working} = ${roll.total}`;
}
