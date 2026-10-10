import { RcConfigQuestionResponse, InteractiveFlowState } from '@app/types';

/**
 * Creates a clean, inactive initial state for the interactive config questionnaire.
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
 * Coerces a boolean or truthy/falsy answer value into 'true' or 'false' string.
 */
export function convertBoolAnswerToString(answer: unknown): string {
  return answer === true || String(answer).toLowerCase() === 'true' ? 'true' : 'false';
}

/**
 * Returns an updated interactive flow state with the new answer.
 */
export function updateInteractiveAnswer(
  state: InteractiveFlowState,
  newAnswer: string | number | boolean | null
): InteractiveFlowState {
  return { ...state, answer: newAnswer };
}

/**
 * Extracts the default answer value from an rclone config question response.
 */
export function getDefaultAnswerFromQuestion(
  q: RcConfigQuestionResponse
): string | boolean | number {
  const opt = q.Option;
  if (!opt) return '';

  if (opt.Type === 'bool') {
    if (typeof opt.Value === 'boolean') return opt.Value;
    if (opt.ValueStr !== undefined && opt.ValueStr !== '') {
      return opt.ValueStr.toLowerCase() === 'true';
    }
    if (opt.DefaultStr !== undefined && opt.DefaultStr !== '') {
      return opt.DefaultStr.toLowerCase() === 'true';
    }
    return typeof opt.Default === 'boolean' ? opt.Default : true;
  }

  let defVal = '';
  if (opt.ValueStr) {
    defVal = opt.ValueStr;
  } else if (opt.DefaultStr) {
    defVal = opt.DefaultStr;
  } else if (opt.Default !== undefined && opt.Default !== null) {
    defVal = String(opt.Default);
  } else if (opt.Examples?.length) {
    defVal = opt.Examples[0].Value;
  }

  if (opt.Examples?.length) {
    const hasExactMatch = opt.Examples.some(ex => ex.Value === defVal);
    if (!hasExactMatch) {
      const num = parseInt(defVal, 10);
      // rclone uses 1-based numeric indices for example selection
      if (!isNaN(num) && num >= 1 && num <= opt.Examples.length) {
        return opt.Examples[num - 1].Value;
      }
    }
  }

  return defVal;
}
