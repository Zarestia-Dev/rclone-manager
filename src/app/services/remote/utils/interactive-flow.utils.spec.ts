import { describe, it, expect } from 'vitest';
import { RcConfigQuestionResponse, RcConfigOption } from '@app/types';
import {
  createInitialInteractiveFlowState,
  convertBoolAnswerToString,
  updateInteractiveAnswer,
  getDefaultAnswerFromQuestion,
} from './interactive-flow.utils';

function createMockQuestion(partialOption?: Partial<RcConfigOption>): RcConfigQuestionResponse {
  if (!partialOption) {
    return {} as RcConfigQuestionResponse;
  }
  return {
    Option: {
      Name: 'test',
      FieldName: 'test',
      Help: 'help text',
      DefaultStr: '',
      ...partialOption,
    } as RcConfigOption,
  } as RcConfigQuestionResponse;
}

describe('interactive-flow.utils', () => {
  describe('createInitialInteractiveFlowState', () => {
    it('should return initial inactive state', () => {
      const state = createInitialInteractiveFlowState();
      expect(state).toEqual({
        isActive: false,
        question: null,
        answer: null,
        isProcessing: false,
      });
    });
  });

  describe('convertBoolAnswerToString', () => {
    it('should convert boolean true to "true"', () => {
      expect(convertBoolAnswerToString(true)).toBe('true');
    });

    it('should convert boolean false to "false"', () => {
      expect(convertBoolAnswerToString(false)).toBe('false');
    });

    it('should handle case-insensitive string "True"', () => {
      expect(convertBoolAnswerToString('True')).toBe('true');
      expect(convertBoolAnswerToString('TRUE')).toBe('true');
    });

    it('should handle other values as "false"', () => {
      expect(convertBoolAnswerToString('false')).toBe('false');
      expect(convertBoolAnswerToString(null)).toBe('false');
      expect(convertBoolAnswerToString(undefined)).toBe('false');
      expect(convertBoolAnswerToString('random')).toBe('false');
    });
  });

  describe('updateInteractiveAnswer', () => {
    it('should update the answer property without mutating the original state', () => {
      const original = createInitialInteractiveFlowState();
      const updated = updateInteractiveAnswer(original, 'new-answer');

      expect(updated.answer).toBe('new-answer');
      expect(original.answer).toBeNull();
      expect(updated.isActive).toBe(original.isActive);
    });
  });

  describe('getDefaultAnswerFromQuestion', () => {
    it('should return empty string when Option is undefined', () => {
      const q = {} as RcConfigQuestionResponse;
      expect(getDefaultAnswerFromQuestion(q)).toBe('');
    });

    it('should handle boolean option with Value', () => {
      const q = createMockQuestion({
        Name: 'fast_list',
        Type: 'bool',
        Value: false,
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe(false);
    });

    it('should handle boolean option with ValueStr', () => {
      const q = createMockQuestion({
        Name: 'fast_list',
        Type: 'bool',
        ValueStr: 'true',
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe(true);
    });

    it('should handle boolean option with DefaultStr', () => {
      const q = createMockQuestion({
        Name: 'fast_list',
        Type: 'bool',
        DefaultStr: 'false',
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe(false);
    });

    it('should handle boolean option with Default boolean', () => {
      const q = createMockQuestion({
        Name: 'fast_list',
        Type: 'bool',
        Default: false,
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe(false);
    });

    it('should default to true for boolean when no value or default is specified', () => {
      const q = createMockQuestion({
        Name: 'fast_list',
        Type: 'bool',
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe(true);
    });

    it('should handle string option with ValueStr', () => {
      const q = createMockQuestion({
        Name: 'client_id',
        Type: 'string',
        ValueStr: 'client-123',
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe('client-123');
    });

    it('should handle string option with DefaultStr', () => {
      const q = createMockQuestion({
        Name: 'scope',
        Type: 'string',
        DefaultStr: 'drive.readonly',
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe('drive.readonly');
    });

    it('should handle option with Examples and 1-based index', () => {
      const q = createMockQuestion({
        Name: 'storage_class',
        Type: 'string',
        Default: '2',
        Examples: [
          { Value: 'STANDARD', Help: 'Standard' },
          { Value: 'NEARLINE', Help: 'Nearline' },
          { Value: 'COLDLINE', Help: 'Coldline' },
        ],
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe('NEARLINE');
    });

    it('should handle option with Examples and direct matching value', () => {
      const q = createMockQuestion({
        Name: 'storage_class',
        Type: 'string',
        Default: 'COLDLINE',
        Examples: [
          { Value: 'STANDARD', Help: 'Standard' },
          { Value: 'NEARLINE', Help: 'Nearline' },
          { Value: 'COLDLINE', Help: 'Coldline' },
        ],
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe('COLDLINE');
    });

    it('should fallback to first example if no value is set', () => {
      const q = createMockQuestion({
        Name: 'provider',
        Type: 'string',
        Examples: [
          { Value: 'AWS', Help: 'Amazon Web Services' },
          { Value: 'Wasabi', Help: 'Wasabi' },
        ],
      });
      expect(getDefaultAnswerFromQuestion(q)).toBe('AWS');
    });
  });
});
