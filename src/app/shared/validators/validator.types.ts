export type ValidationMessageResolver = (key: string, params?: Record<string, unknown>) => string;

export function resolveMessage(
  resolver: ValidationMessageResolver | undefined,
  key: string,
  params?: Record<string, unknown>
): string {
  return resolver ? resolver(key, params) : key;
}
