import { describe, expect, test } from 'bun:test';
import {
  buildDerivationMessages,
  DEFAULT_PERSONA_DERIVE_PROMPT,
  MAX_FIELDS,
  PERSONA_JSON_CONTRACT,
  type PersonaField,
  type PersonaSourceProfile,
  parseDerivedPersona,
  renderPersonaDescription,
} from './derive.ts';

function reply(body: unknown): string {
  return JSON.stringify(body);
}

function labels(fields: readonly PersonaField[]): string[] {
  return fields.map((field) => field.label);
}

function fieldValue(fields: readonly PersonaField[], label: string): string | undefined {
  return fields.find((field) => field.label === label)?.value;
}

/**
 * Iris, one of the hand-written personas in `data/personas`.
 *
 * Deliberately NOT a byte-match against that file: the stored description carries trailing
 * spaces after two values and a trailing newline, both incidental to hand-editing in a
 * textarea. The renderer normalises those away on purpose, so the gate is the normalised
 * form. Someone comparing this to the file and "fixing" the difference would be pinning
 * a typo.
 */
const IRIS: PersonaField[] = [
  { label: 'Name', value: 'Iris Benedetti' },
  { label: 'Age', value: '23' },
  { label: 'Gender', value: 'Female' },
  { label: 'Nationality', value: 'Italian' },
  { label: 'Height', value: `5'6"` },
  { label: 'Hair', value: 'Long flowing natural Golden Blonde hair' },
  { label: 'Eyes', value: 'Heterochromia one emerald green eye and one sapphire blue eye' },
];

describe('renderPersonaDescription', () => {
  test('renders the labelled-line house format the hand-written personas use', () => {
    expect(renderPersonaDescription(IRIS)).toBe(
      [
        'Name: Iris Benedetti',
        'Age: 23',
        'Gender: Female',
        'Nationality: Italian',
        `Height: 5'6"`,
        'Hair: Long flowing natural Golden Blonde hair',
        'Eyes: Heterochromia one emerald green eye and one sapphire blue eye',
      ].join('\n\n'),
    );
  });

  test('puts a blank line between every fact', () => {
    const rendered = renderPersonaDescription(IRIS);
    expect(rendered.split('\n\n')).toHaveLength(IRIS.length);
    expect(rendered).not.toMatch(/[^\n]\n[^\n]/);
  });

  test('emits no trailing newline', () => {
    expect(renderPersonaDescription(IRIS)).not.toMatch(/\n$/);
  });

  test('skips a field with a blank label or value rather than writing an empty line', () => {
    const rendered = renderPersonaDescription([
      { label: 'Name', value: 'Iris' },
      { label: '   ', value: 'orphaned' },
      { label: 'Age', value: '  ' },
      { label: 'Gender', value: 'Female' },
    ]);
    expect(rendered).toBe('Name: Iris\n\nGender: Female');
  });

  test('renders nothing for an empty field list', () => {
    expect(renderPersonaDescription([])).toBe('');
  });
});

describe('parseDerivedPersona', () => {
  test('reads a fenced reply', () => {
    const text = `\`\`\`json\n${reply({ name: 'Iris', fields: IRIS })}\n\`\`\``;
    const parsed = parseDerivedPersona(text, 'Fallback');
    expect(parsed.error).toBeUndefined();
    expect(parsed.name).toBe('Iris');
    expect(parsed.fields).toHaveLength(IRIS.length);
  });

  test('reads a reply with prose around it', () => {
    const text = `Sure! Here is the persona:\n\n${reply({ name: 'Iris', fields: IRIS })}\n\nHope that helps.`;
    expect(parseDerivedPersona(text, 'Fallback').fields).toHaveLength(IRIS.length);
  });

  test('recovers from a trailing comma', () => {
    const text = '{"name":"Iris","fields":[{"label":"Age","value":"23"},]}';
    const parsed = parseDerivedPersona(text, 'Fallback');
    expect(parsed.error).toBeUndefined();
    expect(fieldValue(parsed.fields, 'Age')).toBe('23');
  });

  test('a reply that is not JSON reports an error and yields no fields', () => {
    const parsed = parseDerivedPersona('I am unable to help with that.', 'Fallback');
    expect(parsed.error).toBeTruthy();
    expect(parsed.fields).toEqual([]);
  });

  test('a reply without a fields list reports an error', () => {
    const parsed = parseDerivedPersona(reply({ name: 'Iris' }), 'Fallback');
    expect(parsed.error).toBeTruthy();
    expect(parsed.fields).toEqual([]);
  });

  test('orders known labels canonically however the model ordered them', () => {
    const parsed = parseDerivedPersona(
      reply({
        name: 'Iris',
        fields: [
          { label: 'Eyes', value: 'Green' },
          { label: 'Age', value: '23' },
          { label: 'Hair', value: 'Blonde' },
          { label: 'Name', value: 'Iris Benedetti' },
          { label: 'Gender', value: 'Female' },
        ],
      }),
      'Fallback',
    );
    expect(labels(parsed.fields)).toEqual(['Name', 'Age', 'Gender', 'Hair', 'Eyes']);
  });

  test('normalises synonyms onto the canonical labels', () => {
    const parsed = parseDerivedPersona(
      reply({
        name: 'Iris',
        fields: [
          { label: 'Full Name', value: 'Iris Benedetti' },
          { label: 'Sex', value: 'Female' },
          { label: 'Race', value: 'Human' },
          { label: 'Eye Color', value: 'Green' },
          { label: 'Build', value: 'Slim' },
          { label: 'Distinguishing Features', value: 'A scar' },
        ],
      }),
      'Fallback',
    );
    expect(labels(parsed.fields)).toEqual([
      'Name',
      'Gender',
      'Species',
      'Body',
      'Eyes',
      'Physical',
    ]);
  });

  test('tolerates a trailing colon and odd casing on a label', () => {
    const parsed = parseDerivedPersona(
      reply({ name: 'Iris', fields: [{ label: 'age:', value: '23' }] }),
      'Fallback',
    );
    expect(labels(parsed.fields)).toEqual(['Name', 'Age']);
  });

  test('drops a second field normalising onto a label already taken', () => {
    const parsed = parseDerivedPersona(
      reply({
        name: 'Iris',
        fields: [
          { label: 'Eyes', value: 'Green' },
          { label: 'Eye Colour', value: 'Blue' },
        ],
      }),
      'Fallback',
    );
    expect(fieldValue(parsed.fields, 'Eyes')).toBe('Green');
    expect(parsed.fields.filter((field) => field.label === 'Eyes')).toHaveLength(1);
  });

  test('drops prose labels entirely', () => {
    const parsed = parseDerivedPersona(
      reply({
        name: 'Iris',
        fields: [
          { label: 'Age', value: '23' },
          { label: 'Personality', value: 'Warm but guarded, quick to anger.' },
          { label: 'Backstory', value: 'Raised in a monastery after the war.' },
          { label: 'Scenario', value: 'She is trapped in the tower.' },
          { label: 'Relationships', value: 'Estranged from her brother.' },
        ],
      }),
      'Fallback',
    );
    expect(labels(parsed.fields)).toEqual(['Name', 'Age']);
  });

  test('keeps at most three unknown labels, after the known block', () => {
    const parsed = parseDerivedPersona(
      reply({
        name: 'Iris',
        fields: [
          { label: 'Accent', value: 'Milanese' },
          { label: 'Scent', value: 'Bergamot' },
          { label: 'Handedness', value: 'Left' },
          { label: 'Shoe size', value: '38' },
          { label: 'Age', value: '23' },
        ],
      }),
      'Fallback',
    );
    expect(labels(parsed.fields)).toEqual(['Name', 'Age', 'Accent', 'Scent', 'Handedness']);
  });

  test('drops an unknown label longer than the label cap', () => {
    const parsed = parseDerivedPersona(
      reply({
        name: 'Iris',
        fields: [
          { label: 'Age', value: '23' },
          { label: 'Her general demeanour towards strangers', value: 'Cold' },
        ],
      }),
      'Fallback',
    );
    expect(labels(parsed.fields)).toEqual(['Name', 'Age']);
  });

  test('truncates a long value at a word boundary', () => {
    const value = `${'wordy '.repeat(40)}end`;
    const parsed = parseDerivedPersona(
      reply({ name: 'Iris', fields: [{ label: 'Hair', value }] }),
      'Fallback',
    );
    const hair = fieldValue(parsed.fields, 'Hair') ?? '';
    expect(hair.length).toBeLessThanOrEqual(120);
    expect(hair).not.toMatch(/\s$/);
    expect(hair.endsWith('wordy')).toBe(true);
  });

  test('collapses newlines inside a value to single spaces', () => {
    const parsed = parseDerivedPersona(
      reply({ name: 'Iris', fields: [{ label: 'Hair', value: 'Long\n\nand   blonde' }] }),
      'Fallback',
    );
    expect(fieldValue(parsed.fields, 'Hair')).toBe('Long and blonde');
  });

  test('clamps the total field count', () => {
    const many = [
      { label: 'Name', value: 'Iris Benedetti' },
      { label: 'Age', value: '23' },
      { label: 'Gender', value: 'Female' },
      { label: 'Species', value: 'Human' },
      { label: 'Nationality', value: 'Italian' },
      { label: 'Height', value: `5'6"` },
      { label: 'Body', value: 'Slim' },
      { label: 'Hair', value: 'Blonde' },
      { label: 'Eyes', value: 'Green' },
      { label: 'Physical', value: 'A scar' },
      { label: 'Accent', value: 'Milanese' },
      { label: 'Scent', value: 'Bergamot' },
      { label: 'Handedness', value: 'Left' },
    ];
    const parsed = parseDerivedPersona(reply({ name: 'Iris', fields: many }), 'Fallback');
    expect(parsed.fields).toHaveLength(MAX_FIELDS);
  });

  test('skips a field whose label or value is not a string', () => {
    const parsed = parseDerivedPersona(
      reply({
        name: 'Iris',
        fields: [
          { label: 'Age', value: 23 },
          { label: 7, value: 'Female' },
          { label: 'Hair', value: 'Blonde' },
          null,
          'Eyes: Green',
        ],
      }),
      'Fallback',
    );
    expect(labels(parsed.fields)).toEqual(['Name', 'Hair']);
  });

  /**
   * The "omit, never invent" gate.
   *
   * The contract tells the model to leave a fact out rather than write "unknown", but prompt
   * compliance must not be the only thing standing between the user and an invented age —
   * a persona rides in every single request, and a wrong fact there is read as true forever.
   */
  test('drops placeholder values so an unstated fact is simply absent', () => {
    const parsed = parseDerivedPersona(
      reply({
        name: 'Iris',
        fields: [
          { label: 'Age', value: 'Unknown' },
          { label: 'Nationality', value: 'N/A' },
          { label: 'Height', value: 'not specified' },
          { label: 'Body', value: '—' },
          { label: 'Species', value: '???' },
          { label: 'Physical', value: '' },
          { label: 'Hair', value: 'Blonde' },
        ],
      }),
      'Fallback',
    );
    expect(labels(parsed.fields)).toEqual(['Name', 'Hair']);
  });

  test('falls back to the Name field, then the card name, when name is missing', () => {
    const withField = parseDerivedPersona(
      reply({ fields: [{ label: 'Name', value: 'Iris Benedetti' }] }),
      'Iris.png',
    );
    expect(withField.name).toBe('Iris Benedetti');

    const withNothing = parseDerivedPersona(
      reply({ fields: [{ label: 'Age', value: '23' }] }),
      'Seraphina',
    );
    expect(withNothing.name).toBe('Seraphina');
  });

  test('synthesises the Name line from name when the model omitted the field', () => {
    const parsed = parseDerivedPersona(
      reply({ name: 'Iris', fields: [{ label: 'Age', value: '23' }] }),
      'Fallback',
    );
    expect(parsed.fields[0]).toEqual({ label: 'Name', value: 'Iris' });
  });

  test('does not overwrite a Name field the model already wrote', () => {
    const parsed = parseDerivedPersona(
      reply({ name: 'Iris', fields: [{ label: 'Name', value: 'Iris Benedetti' }] }),
      'Fallback',
    );
    expect(parsed.fields).toEqual([{ label: 'Name', value: 'Iris Benedetti' }]);
    expect(parsed.name).toBe('Iris');
  });
});

describe('buildDerivationMessages', () => {
  const card: PersonaSourceProfile = {
    name: 'Seraphina',
    description: 'A tall elven guardian with silver hair and violet eyes.',
    personality: 'Gentle, watchful, slow to trust.',
    firstMessage: 'The forest parts before you. *She steps out, robes trailing.*',
  };

  function joined(profile: PersonaSourceProfile): string {
    return buildDerivationMessages({ derivePrompt: DEFAULT_PERSONA_DERIVE_PROMPT, card: profile })
      .map((message) => message.content)
      .join('\n');
  }

  /** The card block alone — the system prompt's own length would drown the payload assertions. */
  function payload(profile: PersonaSourceProfile): string {
    return (
      buildDerivationMessages({ derivePrompt: DEFAULT_PERSONA_DERIVE_PROMPT, card: profile })[1]
        ?.content ?? ''
    );
  }

  test('sends exactly two messages, with no preset prompts', () => {
    const messages = buildDerivationMessages({
      derivePrompt: DEFAULT_PERSONA_DERIVE_PROMPT,
      card,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  test('appends the JSON contract to the style prompt', () => {
    const messages = buildDerivationMessages({ derivePrompt: 'Be terse.', card });
    expect(messages[0]?.content).toBe(`Be terse.\n\n${PERSONA_JSON_CONTRACT}`);
  });

  /**
   * The contract must not live inside the editable style prompt: a reply that no longer
   * parses is the one failure a user could not diagnose from the panel.
   */
  test('keeps the contract out of the editable style prompt', () => {
    expect(DEFAULT_PERSONA_DERIVE_PROMPT).not.toContain(PERSONA_JSON_CONTRACT);
    expect(DEFAULT_PERSONA_DERIVE_PROMPT).not.toContain('"fields"');
  });

  test('never sends scenario, example dialogue, creator notes or tags', () => {
    // The type has no slot for them, which is the real guard. This pins the payload shape
    // so that widening `PersonaSourceProfile` cannot quietly widen what reaches the model.
    const text = joined(card);
    expect(text).toContain('Description:');
    expect(text).toContain('Personality:');
    expect(text).not.toContain('Scenario:');
    expect(text).not.toContain('Example dialogue');
    expect(text).not.toContain('Creator notes');
    expect(text).not.toContain('Tags:');
  });

  test('truncates the opening message to the opening budget', () => {
    const long = `${'a'.repeat(400)}\n\n${'b'.repeat(400)}\n\n${'c'.repeat(2000)}`;
    const text = payload({ ...card, firstMessage: long });
    expect(text).not.toContain('c'.repeat(2000));
    expect(text.length).toBeLessThan(long.length);
  });

  test('cuts the opening message at a paragraph break near the budget', () => {
    const long = `${'a'.repeat(1100)}\n\n${'b'.repeat(2000)}`;
    const text = joined({ ...card, firstMessage: long });
    expect(text).toContain('a'.repeat(1100));
    expect(text).not.toContain('b'.repeat(50));
  });

  test('omits an empty personality block rather than sending a bare label', () => {
    const text = joined({ ...card, personality: '   ', firstMessage: '' });
    expect(text).not.toContain('Personality:');
    expect(text).not.toContain('Opening message');
    expect(text).toContain('Description:');
  });

  test('always sends the name', () => {
    const text = joined({ name: 'Seraphina' });
    expect(text).toContain('Seraphina');
  });
});
