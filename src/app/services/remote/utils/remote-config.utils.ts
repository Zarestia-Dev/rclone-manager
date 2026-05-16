import { RcConfigQuestionResponse, InteractiveFlowState, RcConfigOption } from '@app/types';

/**
 * Creates the initial/reset state for interactive flow.
 */
export function createInitialInteractiveFlowState(): InteractiveFlowState {
  return {
    isActive: false,
    question: null,
    answer: null,
    isProcessing: false,
  };
}

/**
 * Checks if the interactive continue button should be disabled.
 */
export function isInteractiveContinueDisabled(
  state: InteractiveFlowState,
  isAuthCancelled: boolean
): boolean {
  if (isAuthCancelled || state.isProcessing) return true;
  if (!state.question?.Option?.Required) return false;
  const { answer } = state;
  return (
    answer === null || answer === undefined || (typeof answer === 'string' && answer.trim() === '')
  );
}

/**
 * Converts a boolean answer to the string format expected by rclone API.
 */
export function convertBoolAnswerToString(answer: unknown): string {
  if (typeof answer === 'boolean') return answer ? 'true' : 'false';
  return String(answer).toLowerCase() === 'true' ? 'true' : 'false';
}

/**
 * Returns a new state object with the given answer applied.
 */
export function updateInteractiveAnswer(
  state: InteractiveFlowState,
  newAnswer: string | number | boolean | null
): InteractiveFlowState {
  return { ...state, answer: newAnswer };
}

/**
 * Extracts the default answer from an interactive config question response.
 */
export function getDefaultAnswerFromQuestion(
  q: RcConfigQuestionResponse
): string | boolean | number {
  const opt = q.Option;
  if (!opt) return '';

  if (opt.Type === 'bool') {
    if (typeof opt.Value === 'boolean') return opt.Value;
    if (opt.ValueStr !== undefined) return opt.ValueStr.toLowerCase() === 'true';
    if (opt.DefaultStr !== undefined) return opt.DefaultStr.toLowerCase() === 'true';
    return typeof opt.Default === 'boolean' ? opt.Default : true;
  }

  return (
    opt.ValueStr || opt.DefaultStr || String(opt.Default || '') || opt.Examples?.[0]?.Value || ''
  );
}

/**
 * Normalizes an rclone config key for flexible searching
 * (lowercase, hyphens/spaces → underscores).
 */
export function normalizeRcloneKey(val: string | undefined | null): string {
  if (!val) return '';
  return val.toLowerCase().replace(/[- ]/g, '_');
}

/**
 * Returns true if a config field name or help text matches the given search query.
 */
export function matchesConfigSearch(field: RcConfigOption, query: string): boolean {
  if (!query) return true;

  const trimmedQuery = query.toLowerCase().trim();
  const flexibleQuery = normalizeRcloneKey(trimmedQuery);

  return (
    (field.Name?.toLowerCase() ?? '').includes(trimmedQuery) ||
    (field.FieldName?.toLowerCase() ?? '').includes(trimmedQuery) ||
    (field.Help?.toLowerCase() ?? '').includes(trimmedQuery) ||
    normalizeRcloneKey(field.Name).includes(flexibleQuery) ||
    normalizeRcloneKey(field.FieldName).includes(flexibleQuery)
  );
}

/**
 * Groups an array of items by a derived key.
 */
export function groupBy<T, K extends PropertyKey>(
  array: T[],
  keyGetter: (item: T) => K
): Record<K, T[]> {
  return array.reduce(
    (acc, item) => {
      const key = keyGetter(item);
      (acc[key] ??= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>
  );
}
