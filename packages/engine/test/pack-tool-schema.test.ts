import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_TASK_DEFINITIONS, packTaskFor, SOURCES_PACK_TASK, type AiTaskDefinition, type Language } from '@shipcast/schema';
import { strictToolSchema } from '../src/index.ts';

/*
 * The submit tool's input schema for a pack, as the Anthropic API is sent it, for a brand's
 * languages. A brand that writes in English alone must be asked for the same shape as one in English
 * and Spanish, minus the Spanish keys: the language keys are plain properties of plain objects, never
 * a record, a reference or a union, so the model has nothing to answer with but an object.
 */

type Node = Record<string, unknown>;

const sentFor = (task: AiTaskDefinition<unknown>, languages: Language[]): Node =>
  strictToolSchema(packTaskFor(task, { blog: languages, newsletter: languages }).output!.jsonSchema()) as Node;

const props = (node: Node): Record<string, Node> => node.properties as Record<string, Node>;

/** The schema with every per-language key of the article and the newsletter renamed or dropped */
function withLanguages(schema: Node, rename: (lang: string) => string | undefined): Node {
  const copy = structuredClone(schema);
  for (const piece of ['article', 'newsletter']) {
    const node = props(copy)[piece]!;
    node.properties = Object.fromEntries(
      Object.entries(props(node)).flatMap(([key, value]) => (key === 'tags' ? [[key, value]] : rename(key) === undefined ? [] : [[rename(key)!, value]])),
    );
  }
  return copy;
}

const VERSION_REQUIRED = { article: ['slug', 'title', 'description', 'markdown'], newsletter: ['subject', 'previewText', 'markdown'] } as const;

for (const [name, task] of [
  ['pack', AI_TASK_DEFINITIONS.pack],
  ['sources pack', SOURCES_PACK_TASK],
] as const) {
  for (const languages of [['en'], ['en', 'es'], ['de']] as Language[][]) {
    test(`the ${name}'s submit tool for [${languages.join(', ')}] is an object with a plain object per language`, () => {
      const sent = sentFor(task as AiTaskDefinition<unknown>, languages);
      assert.equal(sent.type, 'object', 'the answer is an object at the top');
      assert.equal(sent.additionalProperties, false);
      assert.deepEqual(sent.required, ['schemaVersion', 'kind', 'project', 'analysis']);
      for (const piece of ['article', 'newsletter'] as const) {
        const node = props(sent)[piece]!;
        assert.equal(node.type, 'object', `${piece} is an object`);
        assert.equal(node.additionalProperties, false, `${piece} takes no keys but its own`);
        for (const key of ['$ref', 'anyOf', 'oneOf', 'allOf', 'patternProperties', 'propertyNames']) assert.equal(node[key], undefined, `${piece} has no ${key}`);
        assert.deepEqual(Object.keys(props(node)), [...(piece === 'article' ? ['tags'] : []), ...languages], `${piece} names exactly the brand's languages`);
        for (const lang of languages) {
          const version = props(node)[lang]!;
          assert.equal(version.type, 'object', `${piece}.${lang} is an object`);
          assert.equal(version.additionalProperties, false);
          assert.deepEqual(version.required, VERSION_REQUIRED[piece], `${piece}.${lang} requires its fields`);
          for (const key of ['$ref', 'anyOf', 'oneOf', 'allOf']) assert.equal(version[key], undefined, `${piece}.${lang} has no ${key}`);
        }
      }
      // No reference, union or definitions anywhere: nothing a decoder could resolve into a string
      assert.doesNotMatch(JSON.stringify(sent), /"\$ref"|"anyOf"|"oneOf"|"\$defs"|"definitions"/);
    });
  }

  test(`the ${name}'s submit tool differs between language lists only in the language keys`, () => {
    const both = sentFor(task as AiTaskDefinition<unknown>, ['en', 'es']);
    assert.deepEqual(sentFor(task as AiTaskDefinition<unknown>, ['en']), withLanguages(both, (lang) => (lang === 'en' ? 'en' : undefined)));
    assert.deepEqual(sentFor(task as AiTaskDefinition<unknown>, ['de']), withLanguages(both, (lang) => (lang === 'en' ? 'de' : undefined)));
    // The task definitions' own schema, the one asked for before languages were configurable, is [en, es]'s
    assert.deepEqual(strictToolSchema((task as AiTaskDefinition<unknown>).output!.jsonSchema()), both);
  });
}
