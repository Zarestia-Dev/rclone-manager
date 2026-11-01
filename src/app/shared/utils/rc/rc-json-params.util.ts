import { parseJsonObject } from './rc-console.util';

/**
 * The object in a JSON parameter text. Blank text is an empty object; anything that is not a JSON
 * object, such as text holding `{{ }}` workflow tokens, is `null`.
 */
export function jsonObjectOrNull(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return {};
  const parsed = parseJsonObject(text);
  return parsed.ok ? parsed.value : null;
}

/**
 * The JSON text with `name` added as an empty string. Text that is not a JSON object is returned
 * as it is rather than rewritten.
 */
export function addParamKey(raw: string, name: string): string {
  const object = jsonObjectOrNull(raw);
  if (object === null || name in object) return raw;
  return JSON.stringify({ ...object, [name]: '' }, null, 2);
}
