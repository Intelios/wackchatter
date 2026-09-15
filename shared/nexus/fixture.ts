/** Frozen story evidence and queries. Held-out cases are not used for score calibration. */
export const STORY_FACTS = [
  ['origin', 'Joe said he is from London.', ['Joe', 'London'], ['hometown', 'origin']],
  [
    'secret',
    'Anna promised Joe to keep his departure secret from Mary.',
    ['Anna', 'Joe', 'Mary'],
    ['promise', 'confidential', 'departure'],
  ],
  ['allergy', 'Joe is allergic to peanuts.', ['Joe'], ['allergy', 'food']],
  [
    'key',
    'Anna put the brass key under the flowerpot beside the back door.',
    ['Anna', 'brass key'],
    ['key', 'hidden'],
  ],
  [
    'meeting',
    'Joe and Anna agreed to meet at the old observatory at midnight.',
    ['Joe', 'Anna', 'observatory'],
    ['meeting', 'time'],
  ],
  ['mary-origin', 'Mary grew up in Edinburgh.', ['Mary', 'Edinburgh'], ['hometown']],
  [
    'residence',
    'Joe now lives in Paris after leaving his flat in London.',
    ['Joe', 'Paris', 'London'],
    ['residence', 'current home'],
  ],
  ['dog', 'Anna adopted a black dog named Pepper.', ['Anna', 'Pepper'], ['pet', 'dog']],
  [
    'injury',
    'Mary sprained her ankle and cannot run until it heals.',
    ['Mary'],
    ['injury', 'mobility'],
  ],
  [
    'gift',
    'Joe gave Anna a silver compass for her birthday.',
    ['Joe', 'Anna', 'silver compass'],
    ['gift', 'birthday'],
  ],
  ['job', 'Joe repairs antique watches for a living.', ['Joe'], ['occupation', 'work']],
  [
    'boat',
    'The ferry to the island leaves every morning at six.',
    ['ferry', 'island'],
    ['transport', 'schedule'],
  ],
] as const;

export const RETRIEVAL_QUERIES = [
  { query: 'Which city is Joe originally from?', expected: 'origin', split: 'development' },
  { query: 'What is Joe allergic to?', expected: 'allergy', split: 'development' },
  { query: 'Where did Anna hide the brass key?', expected: 'key', split: 'development' },
  { query: 'Where does Mary come from?', expected: 'mary-origin', split: 'development' },
  {
    query: 'What time is our appointment at the observatory?',
    expected: 'meeting',
    split: 'development',
  },
  {
    query: 'Joe asks Anna not to betray his confidence by telling Mary why he went away.',
    expected: 'secret',
    split: 'development',
  },
  { query: 'What colour is Joe’s spaceship?', expected: null, split: 'development' },
  {
    query: 'I am making dinner for Joe. Are there ingredients that could make him ill?',
    expected: 'allergy',
    split: 'held-out',
  },
  {
    query: 'Anna wants to unlock the back entrance. Where should she look?',
    expected: 'key',
    split: 'held-out',
  },
  { query: 'What does Joe do to earn money?', expected: 'job', split: 'held-out' },
  {
    query: 'Joe and Anna are discussing her birthday. What present did he give her?',
    expected: 'gift',
    split: 'held-out',
  },
  { query: 'Why is Mary limping?', expected: 'injury', split: 'held-out' },
  { query: 'When can we catch a boat to the island?', expected: 'boat', split: 'held-out' },
  { query: 'Does Anna have a pet?', expected: 'dog', split: 'held-out' },
  { query: 'Where is Joe living these days?', expected: 'residence', split: 'held-out' },
  { query: 'What is the password to the lunar bunker?', expected: null, split: 'held-out' },
] as const;
