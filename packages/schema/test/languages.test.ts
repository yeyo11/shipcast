import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANGUAGE_NAMES, languageName } from '../src/index.ts';

// The map the engine's article prompt and assistant each had, and the MCP prompt's ternary

test('a language is named in English, and a code Shipcast does not know is written as it came', () => {
  assert.deepEqual(LANGUAGE_NAMES, { en: 'English', es: 'Spanish' });
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('es'), 'Spanish');
  assert.equal(languageName('fr'), 'fr');
  assert.equal(languageName(''), '');
});
