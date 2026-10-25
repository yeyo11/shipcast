/**
 * Checks for what server functions receive: a request can carry anything, whatever the page sent,
 * so every input is checked for shape before it is used.
 */
export class InvalidInput extends Error {}

export function text(value: unknown, name: string, max = 100_000): string {
  if (typeof value !== 'string' || value.length > max) throw new InvalidInput(`${name} must be text`);
  return value;
}

export function id(value: unknown, name = 'id'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new InvalidInput(`${name} must be a positive integer`);
  return value;
}

export function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInput(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function texts(value: unknown, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(object(value, name))) out[key] = text(v, `${name}.${key}`);
  return out;
}

export function list(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new InvalidInput(`${name} must be a list`);
  return value.map((v, i) => text(v, `${name}[${i}]`, 200));
}
