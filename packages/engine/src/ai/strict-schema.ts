/*
 * The JSON Schema a provider's constrained decoder is given: a strict tool's input or a response
 * format. Anthropic compiles such a schema into a grammar and refuses (400) every keyword its
 * decoder does not support, so the schema sent is a relaxed copy of the task's, as Anthropic's own
 * SDKs make it: the constraints it cannot enforce are removed and named in the description instead,
 * so the model still reads them. The task's zod schema is never relaxed: the runner validates the
 * answer against it, and a violation goes back to the model through the one repair.
 */

type Schema = Record<string, unknown>;

/** The string formats Anthropic's strict decoding supports; any other `format` is dropped */
export const STRICT_STRING_FORMATS: ReadonlySet<string> = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

/**
 * Keywords that never reach a strict schema. Constraints (numbers, strings, arrays beyond a
 * `minItems` of 0 or 1, objects), conditionals and the dialect: everything outside the supported
 * subset, which `strictToolSchema` keeps by listing it instead (anything not listed is dropped).
 */
export const STRICT_UNSUPPORTED_KEYWORDS = [
  '$schema',
  '$id',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
  'unevaluatedProperties',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
  'oneOf',
  'examples',
] as const;

/** The constraints worth telling the model about when they are removed, in the order they are told */
const TOLD = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'] as const;

const isSchema = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);

const isObjectSchema = (schema: Schema): boolean =>
  schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object')) || isSchema(schema.properties);

const each = (definitions: unknown): Schema | undefined =>
  isSchema(definitions) ? Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, strictNode(definition)])) : undefined;

/**
 * A deep copy of `schema` that a strict tool or a response format accepts: only the supported
 * keywords (types, `properties`/`required`, `items`, `enum`, `const`, `anyOf` (`oneOf` becomes one),
 * `allOf`, `$ref`/`$defs`/`definitions`, `title`, `description`, `default`, a supported `format`, a
 * `minItems` of 0 or 1), and `additionalProperties: false` on every object. An object with
 * `additionalProperties` as a schema (a zod `record`, a `looseObject`) is closed too, which leaves a
 * record no keys: no task's answer has one, and a test keeps it so. A removed constraint is added
 * to the description (`max items: 8.`), as Anthropic's SDKs do.
 */
export function strictToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return strictNode(schema) as Record<string, unknown>;
}

function strictNode(node: unknown): unknown {
  if (!isSchema(node)) return structuredClone(node);
  // A reference stands alone: its siblings are ignored by draft-7 and refused by a strict decoder
  if (typeof node.$ref === 'string') return { $ref: node.$ref };
  const out: Schema = {};
  if (node.title !== undefined) out.title = node.title;
  if (node.description !== undefined) out.description = node.description;
  if (node.default !== undefined) out.default = structuredClone(node.default);
  if (node.const !== undefined) out.const = structuredClone(node.const);
  if (node.enum !== undefined) out.enum = structuredClone(node.enum);
  if (node.type !== undefined) out.type = structuredClone(node.type);
  const anyOf = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (anyOf) out.anyOf = anyOf.map(strictNode);
  if (Array.isArray(node.allOf)) out.allOf = node.allOf.map(strictNode);
  const defs = each(node.$defs);
  if (defs) out.$defs = defs;
  const definitions = each(node.definitions);
  if (definitions) out.definitions = definitions;
  if (isObjectSchema(node)) {
    const properties = each(node.properties);
    if (properties) out.properties = properties;
    if (Array.isArray(node.required)) out.required = [...node.required];
    out.additionalProperties = false;
  }
  if (node.items !== undefined) out.items = Array.isArray(node.items) ? node.items.map(strictNode) : strictNode(node.items);
  if (typeof node.format === 'string' && STRICT_STRING_FORMATS.has(node.format)) out.format = node.format;
  if (node.minItems === 0 || node.minItems === 1) out.minItems = node.minItems;
  const told = removedConstraints(node);
  if (told) out.description = typeof out.description === 'string' && out.description ? `${out.description}\n${told}` : told;
  return out;
}

/** What was removed from one node and the model should still follow, as a sentence for its description */
function removedConstraints(node: Schema): string | undefined {
  const said = TOLD.flatMap((key) => {
    const value = node[key];
    if (value === undefined || value === false) return [];
    if (key === 'minItems' && (value === 0 || value === 1)) return [];
    return [`${key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)}: ${typeof value === 'string' ? value : JSON.stringify(value)}`];
  });
  if (typeof node.format === 'string' && !STRICT_STRING_FORMATS.has(node.format)) said.push(`format: ${node.format}`);
  return said.length > 0 ? `${said.join('; ')}.` : undefined;
}

/**
 * What a provider's strict decoding can compile in one request, over all its strict schemas.
 * Anthropic's: 24 optional parameters (a property not in its object's `required`) and 16 parameters
 * with a union type (`anyOf` or a type array); past either, a 400 "Schema is too complex for compilation".
 */
export interface StrictSchemaLimits {
  optionalParams: number;
  unionParams: number;
}

/** How much of a strict decoder's limits a schema uses */
export function strictSchemaComplexity(schema: Record<string, unknown>): StrictSchemaLimits {
  const count = { optionalParams: 0, unionParams: 0 };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isSchema(node)) return;
    if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.type)) count.unionParams++;
    if (isSchema(node.properties)) {
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      count.optionalParams += Object.keys(node.properties).filter((key) => !required.has(key)).length;
    }
    for (const key of ['properties', '$defs', 'definitions'] as const) if (isSchema(node[key])) Object.values(node[key]).forEach(walk);
    for (const key of ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties'] as const) walk(node[key]);
  };
  walk(schema);
  return count;
}

/** Whether a (relaxed) schema compiles within a strict decoder's limits */
export function fitsStrictLimits(schema: Record<string, unknown>, limits: StrictSchemaLimits): boolean {
  const used = strictSchemaComplexity(schema);
  return used.optionalParams <= limits.optionalParams && used.unionParams <= limits.unionParams;
}
