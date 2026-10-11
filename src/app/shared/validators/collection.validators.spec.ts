import { FormControl } from '@angular/forms';
import { describe, it, expect } from 'vitest';
import {
  arrayValidator,
  tristateValidator,
  spaceSepListValidator,
  enumValidator,
  urlArrayValidator,
} from './collection.validators';

describe('collection.validators', () => {
  describe('arrayValidator', () => {
    it('should validate array or null/empty', () => {
      const validator = arrayValidator();
      expect(validator(new FormControl(null))).toBeNull();
      expect(validator(new FormControl(['a', 'b']))).toBeNull();
      expect(validator(new FormControl('string-value'))).toBeNull();
      expect(validator(new FormControl(123))).toEqual({ invalidArray: true });
    });
  });

  describe('tristateValidator', () => {
    it('should allow boolean, unset, null, and empty string', () => {
      const validator = tristateValidator();
      expect(validator(new FormControl(true))).toBeNull();
      expect(validator(new FormControl(false))).toBeNull();
      expect(validator(new FormControl(null))).toBeNull();
      expect(validator(new FormControl(''))).toBeNull();
      expect(validator(new FormControl('true'))).toBeNull();
      expect(validator(new FormControl('false'))).toBeNull();
      expect(validator(new FormControl('unset'))).toBeNull();
    });

    it('should reject other values', () => {
      const validator = tristateValidator();
      expect(validator(new FormControl('maybe'))).not.toBeNull();
      expect(validator(new FormControl(123))).not.toBeNull();
    });
  });

  describe('spaceSepListValidator', () => {
    it('should validate space separated list', () => {
      const validator = spaceSepListValidator();
      expect(validator(new FormControl(''))).toBeNull();
      expect(validator(new FormControl('item1 item2 item3'))).toBeNull();
      expect(validator(new FormControl('   '))).not.toBeNull();
    });
  });

  describe('enumValidator', () => {
    it('should allow allowed values case-insensitively', () => {
      const validator = enumValidator(['OptionA', 'OptionB']);
      expect(validator(new FormControl(''))).toBeNull();
      expect(validator(new FormControl(null))).toBeNull();
      expect(validator(new FormControl('optiona'))).toBeNull();
      expect(validator(new FormControl('OPTIONB'))).toBeNull();
    });

    it('should reject invalid values', () => {
      const validator = enumValidator(['OptionA', 'OptionB']);
      const res = validator(new FormControl('OptionC'));
      expect(res).not.toBeNull();
      expect(res?.['enum']).toBeDefined();
      expect(res?.['enum'].allowedValues).toEqual(['OptionA', 'OptionB']);
    });
  });

  describe('urlArrayValidator', () => {
    it('should validate url array', () => {
      const validator = urlArrayValidator();
      expect(validator(new FormControl([]))).toBeNull();
      expect(validator(new FormControl(['https://example.com', 'http://test.org']))).toBeNull();
      expect(validator(new FormControl(['not-a-url']))).not.toBeNull();
    });
  });
});
