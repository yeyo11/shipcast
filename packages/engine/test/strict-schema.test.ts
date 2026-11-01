import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_TASK_DEFINITIONS, SOURCES_PACK_TASK, type AiTaskDefinition } from '@shipcast/schema';
import { z } from 'zod';
import { anthropicAiProvider, fitsStrictLimits, STRICT_STRING_FORMATS, STRICT_UNSUPPORTED_KEYWORDS, strictSchemaComplexity, strictToolSchema } from '../src/index.ts';

type Node = Record<string, unknown>;

/** Every schema node of a JSON Schema, with where it is, walking only the places a schema can be */
function nodes(schema: unknown, path = '#'): Array<{ path: string; node: Node }> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [];
  const node = schema as Node;
  const out = [{ path, node }];
  for (const key of ['properties', '$defs', 'definitions']) {
    const map = node[key];
    if (map && typeof map === 'object') for (const [name, child] of Object.entries(map)) out.push(...nodes(child, `${path}/${key}/${name}`));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(node[key])) (node[key] as unknown[]).forEach((child, i) => out.push(...nodes(child, `${path}/${key}/${i}`)));
  if (Array.isArray(node.items)) node.items.forEach((child, i) => out.push(...nodes(child, `${path}/items/${i}`)));
  else out.push(...nodes(node.items, `${path}/items`));
  if (typeof node.additionalProperties === 'object') out.push(...nodes(node.additionalProperties, `${path}/additionalProperties`));
  return out;
}

const isObject = (node: Node) => node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object')) || typeof node.properties === 'object';

/** What a strict decoder refuses in a schema, as `path: problem` lines */
function strictProblems(schema: Node): string[] {
  const problems: string[] = [];
  if (schema.type !== 'object') problems.push('#: the top level is not an object');
  for (const { path, node } of nodes(schema)) {
    for (const key of STRICT_UNSUPPORTED_KEYWORDS) if (key in node) problems.push(`${path}: ${key}`);
    if ('minItems' in node && node.minItems !== 0 && node.minItems !== 1) problems.push(`${path}: minItems ${String(node.minItems)}`);
    if ('format' in node && !STRICT_STRING_FORMATS.has(String(node.format))) problems.push(`${path}: format ${String(node.format)}`);
    if (isObject(node) && node.additionalProperties !== false) problems.push(`${path}: additionalProperties is not false`);
  }
  return problems;
}

/** Every task that answers with a schema: the AI settings' tasks and the launch from sources */
const structured = ([...Object.values(AI_TASK_DEFINITIONS), SOURCES_PACK_TASK] as ReadonlyArray<AiTaskDefinition<unknown>>).flatMap((task) =>
  task.output ? [{ id: task.id, sources: task === (SOURCES_PACK_TASK as AiTaskDefinition<unknown>), output: task.output }] : [],
);

test('the relaxed schema keeps the supported subset and drops every constraint a strict decoder refuses', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    description: 'The answer',
    properties: {
      tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$', minLength: 1, maxLength: 20 }, minItems: 1, maxItems: 4, uniqueItems: true },
      slides: { type: 'array', items: { type: 'string' }, minItems: 2 },
      score: { type: 'integer', minimum: 0, maximum: 10, multipleOf: 1, exclusiveMinimum: -1 },
      site: { type: 'string', format: 'uri' },
      ref: { type: 'string', format: 'regex' },
      kind: { enum: ['a', 'b'], default: 'a' },
      fixed: { const: 'x' },
      either: { oneOf: [{ type: 'string', minLength: 3 }, { type: 'null' }] },
      both: { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }] },
      when: { if: { type: 'string' }, then: { minLength: 1 }, else: { not: { type: 'null' } }, type: 'string' },
      loose: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: {}, patternProperties: { '^x': { type: 'string' } }, propertyNames: { pattern: '^[a-z]+$' }, minProperties: 1, dependentRequired: { a: ['b'] } },
      linked: { $ref: '#/$defs/Item', description: 'dropped beside a $ref' },
    },
    required: ['tags', 'slides'],
    additionalProperties: false,
    $defs: { Item: { type: 'object', properties: { n: { type: 'number', maximum: 3 } } } },
  };
  const before = structuredClone(schema);
  const relaxed = strictToolSchema(schema) as Node & { properties: Record<string, Node>; $defs: Record<string, Node> };
  assert.deepEqual(schema, before, 'the given schema is left as it was');
  assert.deepEqual(strictProblems(relaxed), []);

  const { tags, slides, score, site, ref, kind, fixed, either, both, when, loose, linked } = relaxed.properties;
  assert.equal(relaxed.$schema, undefined);
  assert.equal(relaxed.description, 'The answer', 'a description with nothing removed beside it stays as it was');
  assert.deepEqual(relaxed.required, ['tags', 'slides']);
  assert.equal(tags!.minItems, 1, 'a minItems of 1 is supported, so kept');
  assert.equal(tags!.maxItems, undefined);
  assert.equal(tags!.description, 'max items: 4; unique items: true.', 'a removed constraint is told to the model');
  assert.deepEqual(tags!.items, { type: 'string', description: 'min length: 1; max length: 20; pattern: ^[a-z]+$.' });
  assert.equal(slides!.minItems, undefined, 'a minItems over 1 is removed');
  assert.equal(slides!.description, 'min items: 2.');
  assert.deepEqual(Object.keys(score!).sort(), ['description', 'type']);
  assert.equal(site!.format, 'uri', 'a supported format stays');
  assert.equal(ref!.format, undefined, 'any other is removed');
  assert.equal(ref!.description, 'format: regex.');
  assert.deepEqual(kind, { enum: ['a', 'b'], default: 'a' });
  assert.deepEqual(fixed, { const: 'x' });
  assert.deepEqual(either, { anyOf: [{ type: 'string', description: 'min length: 3.' }, { type: 'null' }] }, 'oneOf is sent as anyOf');
  assert.deepEqual(both, { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }] });
  assert.deepEqual(when, { type: 'string' }, 'conditionals and not are removed');
  assert.deepEqual(loose, { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false, description: 'min properties: 1.' }, 'an open object is closed');
  assert.deepEqual(linked, { $ref: '#/$defs/Item' });
  assert.deepEqual(relaxed.$defs.Item, { type: 'object', properties: { n: { type: 'number', description: 'maximum: 3.' } }, additionalProperties: false });

  // A deep copy: changing the relaxed schema leaves the task's alone
  (relaxed.properties.kind!.enum as string[]).push('c');
  assert.deepEqual(schema.properties.kind.enum, ['a', 'b']);
});

test('the relaxed schema of a zod record or loose object is closed, and an untyped object with properties counts as an object', () => {
  const record = strictToolSchema(z.toJSONSchema(z.strictObject({ counts: z.record(z.string(), z.number()), extra: z.looseObject({ a: z.string() }) }), { target: 'draft-7', io: 'input' }));
  assert.deepEqual(strictProblems(record), []);
  assert.deepEqual((record.properties as Record<string, Node>).counts, { type: 'object', additionalProperties: false });
  assert.deepEqual(strictToolSchema({ properties: { a: { type: 'string' } } }), { properties: { a: { type: 'string' } }, additionalProperties: false });
});

test('a strict decoder’s limits count the optional parameters and the unions over the whole schema', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: ['string', 'null'] },
      c: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      nested: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } }, required: ['x'] },
      list: { type: 'array', items: { type: 'object', properties: { z: { type: 'string' } } } },
    },
    required: ['a', 'nested'],
  };
  assert.deepEqual(strictSchemaComplexity(schema), { optionalParams: 5, unionParams: 2 }, 'b, c, list at the top, y, and z in the items');
  assert.equal(fitsStrictLimits(schema, { optionalParams: 5, unionParams: 2 }), true);
  assert.equal(fitsStrictLimits(schema, { optionalParams: 4, unionParams: 2 }), false);
  assert.equal(fitsStrictLimits(schema, { optionalParams: 5, unionParams: 1 }), false);
});

test('every task answer’s schema, relaxed, is one a strict decoder takes: an object, every object closed, no unsupported keyword', () => {
  assert.ok(structured.length >= 6, 'the pack, the article, the check, the reply, the profile review and the launch from sources');
  assert.ok(strictProblems(AI_TASK_DEFINITIONS.pack.output!.jsonSchema()).length > 0, 'the check finds what the pack’s own schema has that a strict decoder refuses');
  for (const task of structured) {
    const original = task.output.jsonSchema();
    // A record would be closed to no keys at all: an answer must not have one (strictToolSchema's doc)
    const open = nodes(original).filter(({ node }) => isObject(node) && node.additionalProperties !== undefined && node.additionalProperties !== false);
    assert.deepEqual(open.map((o) => o.path), [], `${task.id}/${task.output.name} has an open object, which the strict schema closes`);
    const relaxed = strictToolSchema(original);
    assert.deepEqual(strictProblems(relaxed), [], `${task.id}/${task.output.name}`);
    const descriptions = (schema: Node) => nodes(schema).filter(({ node }) => typeof node.description === 'string').length;
    assert.ok(descriptions(relaxed) >= descriptions(original), `${task.id}/${task.output.name} keeps its descriptions`);
  }
});

test('which task answers fit Anthropic’s strict limits, and so go through a strict submit tool or the response format', () => {
  const limits = anthropicAiProvider.capabilities.strictSchemas;
  assert.ok(limits, 'the Anthropic API declares its strict decoding limits');
  const fits = Object.fromEntries(structured.map((task) => [`${task.id}/${task.output.name}${task.sources ? ' (sources)' : ''}`, fitsStrictLimits(strictToolSchema(task.output.jsonSchema()), limits)]));
  // The content pack has more optional fields than 24: it answers through a submit tool that is not strict
  assert.deepEqual(fits, {
    'pack/content_pack': false,
    'article/content_pack': false,
    'assistant-check/check': true,
    'replies/reply': true,
    'profile/profile_review': true,
    'pack/content_pack (sources)': false,
  });
});
