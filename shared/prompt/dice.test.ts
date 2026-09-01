import { describe, expect, test } from 'bun:test';
import { formatRoll, parseDiceFormula, rollDice } from './dice.ts';

describe('formula parsing', () => {
  test('reads droll formulas, filling in the implied count', () => {
    expect(parseDiceFormula('2d6')).toMatchObject({ count: 2, sides: 6, modifier: 0 });
    expect(parseDiceFormula('d20')).toMatchObject({ count: 1, sides: 20, formula: '1d20' });
    expect(parseDiceFormula('3d6+4')).toMatchObject({ count: 3, sides: 6, modifier: 4 });
    expect(parseDiceFormula('2d8-1')).toMatchObject({ count: 2, sides: 8, modifier: -1 });
  });

  // ST's isDigitsOnly branch: {{roll:6}} has always meant one d6, and cards rely on it.
  test('a bare number is one die of that many sides', () => {
    expect(parseDiceFormula('6')).toMatchObject({ count: 1, sides: 6, formula: '1d6' });
  });

  test('tolerates whitespace and case', () => {
    expect(parseDiceFormula('  2D6+1  ')).toMatchObject({ count: 2, sides: 6, modifier: 1 });
  });

  test('a zero modifier is not written back into the formula', () => {
    expect(parseDiceFormula('2d6+0')?.formula).toBe('2d6');
  });

  test('rejects anything that is not a formula', () => {
    for (const input of ['', '   ', 'abc', '2x6', 'd', '2d', '2d6+', '2d6*2', '1d6+1d4', '-3']) {
      expect(parseDiceFormula(input)).toBeNull();
    }
  });

  test('rejects dice that cannot roll', () => {
    expect(parseDiceFormula('0d6')).toBeNull();
    expect(parseDiceFormula('2d0')).toBeNull();
  });

  /*
   * The bound droll lacks. Without it a card carrying {{roll:99999999d6}} hangs the loop,
   * and since send-time resolution runs card and user text alike, that is a hang somebody
   * else's card can hand you.
   */
  test('caps the dice count and the sides rather than looping forever', () => {
    expect(parseDiceFormula('1000d6')).not.toBeNull();
    expect(parseDiceFormula('1001d6')).toBeNull();
    expect(parseDiceFormula('1d1000000')).not.toBeNull();
    expect(parseDiceFormula('1d1000001')).toBeNull();
  });
});

describe('rolling', () => {
  test('every die lands within its own range', () => {
    for (let i = 0; i < 200; i++) {
      const roll = rollDice('3d6')!;
      expect(roll.rolls).toHaveLength(3);
      for (const die of roll.rolls) {
        expect(die).toBeGreaterThanOrEqual(1);
        expect(die).toBeLessThanOrEqual(6);
      }
      expect(roll.total).toBe(roll.rolls.reduce((sum, die) => sum + die, 0));
    }
  });

  test('the modifier is added once, not per die', () => {
    for (let i = 0; i < 200; i++) {
      const roll = rollDice('2d6+10')!;
      expect(roll.total).toBeGreaterThanOrEqual(12);
      expect(roll.total).toBeLessThanOrEqual(22);
    }
  });

  test('a negative modifier can take the total below one', () => {
    const roll = rollDice('1d4-10')!;
    expect(roll.total).toBeLessThan(0);
  });

  test('an unparseable formula rolls nothing', () => {
    expect(rollDice('2x6')).toBeNull();
  });
});

describe('formatting', () => {
  test('a single unmodified die skips the redundant working', () => {
    expect(formatRoll({ formula: '1d20', rolls: [14], modifier: 0, total: 14 })).toBe(
      '🎲 1d20: 14',
    );
  });

  test('shows the dice as they fell', () => {
    expect(formatRoll({ formula: '2d6+3', rolls: [4, 5], modifier: 3, total: 12 })).toBe(
      '🎲 2d6+3: 4 + 5 + 3 = 12',
    );
  });

  test('a negative modifier subtracts rather than adding a minus', () => {
    expect(formatRoll({ formula: '2d8-1', rolls: [3, 6], modifier: -1, total: 8 })).toBe(
      '🎲 2d8-1: 3 + 6 - 1 = 8',
    );
  });

  test('one die with a modifier still shows its working', () => {
    expect(formatRoll({ formula: '1d20+5', rolls: [14], modifier: 5, total: 19 })).toBe(
      '🎲 1d20+5: 14 + 5 = 19',
    );
  });
});
