import { FormControl } from '@angular/forms';
import { describe, it, expect } from 'vitest';
import {
  integerValidator,
  floatValidator,
  durationValidator,
  sizeSuffixValidator,
  timeValidator,
  fileModeValidator,
  bwTimetableValidator,
  bandwidthValidator,
} from './format.validators';

describe('format.validators', () => {
  describe('durationValidator', () => {
    it('should allow valid duration strings and rclone units', () => {
      const validator = durationValidator();
      const validCases = [
        'off',
        '0',
        '0s',
        '10s',
        '1.5h',
        '1h30m45s',
        '5m',
        '2w',
        '1M',
        '1y',
        '500ms',
        '100us',
        '100µs',
        '100ns',
      ];

      for (const val of validCases) {
        expect(validator(new FormControl(val)), `Expected "${val}" to be valid`).toBeNull();
      }
    });

    it('should reject invalid duration strings', () => {
      const validator = durationValidator();
      const invalidCases = ['not-a-duration', '10x', 'abc', 'hello'];

      for (const val of invalidCases) {
        const result = validator(new FormControl(val));
        expect(result, `Expected "${val}" to be invalid`).not.toBeNull();
        expect(result?.['duration']).toBeDefined();
      }
    });

    it('should allow value matching defaultValue or allowedExamples', () => {
      const validatorWithDefault = durationValidator('custom-default');
      expect(validatorWithDefault(new FormControl('custom-default'))).toBeNull();

      const validatorWithExamples = durationValidator('', [
        { Value: 'special-token' },
        'another-token',
      ]);
      expect(validatorWithExamples(new FormControl('special-token'))).toBeNull();
      expect(validatorWithExamples(new FormControl('another-token'))).toBeNull();
    });
  });

  describe('sizeSuffixValidator', () => {
    it('should allow valid size suffix values and off', () => {
      const validator = sizeSuffixValidator();
      const validCases = [
        'off',
        '0',
        '512',
        '512k',
        '512K',
        '1M',
        '1Mi',
        '1MiB',
        '10G',
        '100GB',
        '1T',
        '1.5M',
      ];

      for (const val of validCases) {
        expect(validator(new FormControl(val)), `Expected "${val}" to be valid`).toBeNull();
      }
    });

    it('should reject invalid size suffix strings', () => {
      const validator = sizeSuffixValidator();
      const invalidCases = ['not-a-size', '100xyz', 'abc'];

      for (const val of invalidCases) {
        const result = validator(new FormControl(val));
        expect(result, `Expected "${val}" to be invalid`).not.toBeNull();
        expect(result?.['sizeSuffix']).toBeDefined();
      }
    });
  });

  describe('bwTimetableValidator', () => {
    it('should allow valid bandwidth rates, split pairs, and timetables', () => {
      const validator = bwTimetableValidator();
      const validCases = [
        'off',
        '512k',
        '1M',
        '10M:50M',
        'off:50M',
        '08:00,512k 18:00,10M 23:00,off',
        'Mon-10:00,10G Mon-11:30,1G Tue-18:00,off',
      ];

      for (const val of validCases) {
        expect(validator(new FormControl(val)), `Expected "${val}" to be valid`).toBeNull();
      }
    });

    it('should reject invalid bandwidth timetable strings', () => {
      const validator = bwTimetableValidator();
      const invalidCases = ['bad-timetable', '25:00,10M', 'NotADay-10:00,10M'];

      for (const val of invalidCases) {
        const result = validator(new FormControl(val));
        expect(result, `Expected "${val}" to be invalid`).not.toBeNull();
        expect(result?.['bwTimetable']).toBeDefined();
      }
    });
  });

  describe('fileModeValidator', () => {
    it('should allow 3 or 4 digit octal file modes', () => {
      const validator = fileModeValidator();
      const validCases = ['0644', '0666', '0755', '0777', '644', '755', '777'];

      for (const val of validCases) {
        expect(validator(new FormControl(val)), `Expected "${val}" to be valid`).toBeNull();
      }
    });

    it('should reject invalid octal values', () => {
      const validator = fileModeValidator();
      const invalidCases = ['999', '0888', 'abc', '12', '12345'];

      for (const val of invalidCases) {
        const result = validator(new FormControl(val));
        expect(result, `Expected "${val}" to be invalid`).not.toBeNull();
        expect(result?.['fileMode']).toBeDefined();
      }
    });
  });

  describe('integerValidator and floatValidator', () => {
    it('should validate integer values', () => {
      const validator = integerValidator();
      expect(validator(new FormControl('123'))).toBeNull();
      expect(validator(new FormControl('-456'))).toBeNull();
      expect(validator(new FormControl('0'))).toBeNull();
      expect(validator(new FormControl('12.34'))).not.toBeNull();
      expect(validator(new FormControl('abc'))).not.toBeNull();
    });

    it('should validate float values', () => {
      const validator = floatValidator();
      expect(validator(new FormControl('123'))).toBeNull();
      expect(validator(new FormControl('12.34'))).toBeNull();
      expect(validator(new FormControl('-0.56'))).toBeNull();
      expect(validator(new FormControl('abc'))).not.toBeNull();
    });
  });

  describe('timeValidator and bandwidthValidator', () => {
    it('should validate time strings', () => {
      const validator = timeValidator();
      expect(validator(new FormControl('2024-01-15T12:00:00Z'))).toBeNull();
      expect(validator(new FormControl('2024-01-15'))).toBeNull();
      expect(validator(new FormControl('invalid-time'))).not.toBeNull();
    });

    it('should validate bandwidth pattern', () => {
      const validator = bandwidthValidator();
      expect(validator(new FormControl('10M'))).toBeNull();
      expect(validator(new FormControl('10M:50M'))).toBeNull();
      expect(validator(new FormControl('invalid bandwidth'))).not.toBeNull();
    });
  });
});
