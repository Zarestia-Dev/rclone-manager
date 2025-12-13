import { RcConfigQuestionResponse, InteractiveFlowState } from '@app/types';

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
 * @param state - The current interactive flow state.
 * @param isAuthCancelled - Whether auth has been cancelled.
 * @returns True if the continue button should be disabled.
 */
export function isInteractiveContinueDisabled(
  state: InteractiveFlowState,
  isAuthCancelled: boolean
): boolean {
  if (isAuthCancelled || state.isProcessing) return true;
  if (!state.question?.Option?.Required) return false;
  const answer = state.answer;
  return (
    answer === null || answer === undefined || (typeof answer === 'string' && answer.trim() === '')
  );
}

/**
 * Converts a boolean answer to the string format expected by rclone API.
 * @param answer - The answer value (boolean or string).
 * @returns The string 'true' or 'false'.
 */
export function convertBoolAnswerToString(answer: unknown): string {
  return typeof answer === 'boolean'
    ? answer
      ? 'true'
      : 'false'
    : String(answer).toLowerCase() === 'true'
      ? 'true'
      : 'false';
}

/**
 * Updates the interactive flow state with a new answer value.
 * Returns the updated state object.
 *
 * @param state - The current interactive flow state.
 * @param newAnswer - The new answer value from the user.
 * @returns The updated state object with the new answer.
 */
export function updateInteractiveAnswer(
  state: InteractiveFlowState,
  newAnswer: string | number | boolean | null
): InteractiveFlowState {
  return {
    ...state,
    answer: newAnswer,
  };
}

/**
 * Builds a path string (e.g., "myRemote:path") from a form path group object.
 * Handles various path types: local, currentRemote, otherRemote.
 *
 * @param pathGroup - The path group object from the form, or a simple string for local paths.
 * @param currentRemoteName - The name of the current remote being configured.
 * @returns The formatted path string.
 */
export function buildPathString(pathGroup: any, currentRemoteName: string): string {
  if (pathGroup === null || pathGroup === undefined) return '';

  // Handle simple string path (e.g., mount dest which is always local)
  if (typeof pathGroup === 'string') {
    return pathGroup;
  }

  const { pathType, path, otherRemoteName } = pathGroup;
  const p = path || '';

  // Handle "otherRemote:remoteName" format
  if (typeof pathType === 'string' && pathType.startsWith('otherRemote:')) {
    const remote = otherRemoteName || pathType.split(':')[1];
    return `${remote}:${p}`;
  }

  switch (pathType) {
    case 'local':
      return p;
    case 'currentRemote':
      return `${currentRemoteName}:${p}`;
    default:
      return '';
  }
}

/**
 * Extracts the default answer from an interactive config question response.
 * Handles boolean, string, and numeric types.
 *
 * @param q - The RcConfigQuestionResponse from the rclone backend.
 * @returns The default answer value.
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
