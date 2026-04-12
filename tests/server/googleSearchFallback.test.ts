import assert from 'node:assert/strict';
import { parseRequestPayload } from '../../server/googleSearchFallback.ts';

const legacyPopulation = [
  {
    title: 'Example source',
    content: 'A short but valid content body for the regression test.',
    url: 'https://example.com/source',
  },
];

assert.deepEqual(parseRequestPayload(JSON.stringify(legacyPopulation)), {
  population: legacyPopulation,
});

const objectPayload = {
  population: [
    {
      title: 'Existing payload shape',
      content: 'This should continue to pass through unchanged.',
      url: 'https://example.com/object-shape',
    },
  ],
  generations: 4,
};

assert.deepEqual(parseRequestPayload(JSON.stringify(objectPayload)), objectPayload);

console.log('googleSearchFallback request payload regression checks passed');
