import { FormControl } from '@angular/forms';
import { describe, it, expect } from 'vitest';
import { arrayValidator, tristateValidator, urlArrayValidator } from './collection.validators';

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

  describe('urlArrayValidator', () => {
    it('should validate url array', () => {
      const validator = urlArrayValidator();
      expect(validator(new FormControl([]))).toBeNull();
      expect(validator(new FormControl(['https://example.com', 'http://test.org']))).toBeNull();
      expect(validator(new FormControl(['not-a-url']))).not.toBeNull();
    });
  });
});
