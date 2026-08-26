import { TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, it, expect, beforeEach } from 'vitest';
import { ValidatorRegistryService } from './validator-registry.service';

describe('ValidatorRegistryService', () => {
  let service: ValidatorRegistryService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideTranslateService(), ValidatorRegistryService],
    });
    service = TestBed.inject(ValidatorRegistryService);
  });

  describe('durationValidator', () => {
    it('should allow valid duration strings and rclone units', () => {
      const validator = service.durationValidator();
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
      const validator = service.durationValidator();
      const invalidCases = ['not-a-duration', '10x', 'abc', 'hello'];

      for (const val of invalidCases) {
        const result = validator(new FormControl(val));
        expect(result, `Expected "${val}" to be invalid`).not.toBeNull();
        expect(result?.['duration']).toBeDefined();
      }
    });

    it('should allow value matching defaultValue or allowedExamples', () => {
      const validatorWithDefault = service.durationValidator('custom-default');
      expect(validatorWithDefault(new FormControl('custom-default'))).toBeNull();

      const validatorWithExamples = service.durationValidator('', [
        { Value: 'special-token' },
        'another-token',
      ]);
      expect(validatorWithExamples(new FormControl('special-token'))).toBeNull();
      expect(validatorWithExamples(new FormControl('another-token'))).toBeNull();
    });
  });

  describe('sizeSuffixValidator', () => {
    it('should allow valid size suffix values and off', () => {
      const validator = service.sizeSuffixValidator();
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
      const validator = service.sizeSuffixValidator();
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
      const validator = service.bwTimetableValidator();
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
      const validator = service.bwTimetableValidator();
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
      const validator = service.fileModeValidator();
      const validCases = ['0644', '0666', '0755', '0777', '644', '755', '777'];

      for (const val of validCases) {
        expect(validator(new FormControl(val)), `Expected "${val}" to be valid`).toBeNull();
      }
    });

    it('should reject invalid octal values', () => {
      const validator = service.fileModeValidator();
      const invalidCases = ['999', '0888', 'abc', '12', '12345'];

      for (const val of invalidCases) {
        const result = validator(new FormControl(val));
        expect(result, `Expected "${val}" to be invalid`).not.toBeNull();
        expect(result?.['fileMode']).toBeDefined();
      }
    });
  });

  describe('tristateValidator', () => {
    it('should allow boolean, unset, null, and empty string', () => {
      const validator = service.tristateValidator();
      expect(validator(new FormControl(true))).toBeNull();
      expect(validator(new FormControl(false))).toBeNull();
      expect(validator(new FormControl(null))).toBeNull();
      expect(validator(new FormControl(''))).toBeNull();
      expect(validator(new FormControl('true'))).toBeNull();
      expect(validator(new FormControl('false'))).toBeNull();
      expect(validator(new FormControl('unset'))).toBeNull();
    });

    it('should reject other values', () => {
      const validator = service.tristateValidator();
      expect(validator(new FormControl('maybe'))).not.toBeNull();
      expect(validator(new FormControl(123))).not.toBeNull();
    });
  });

  describe('integerValidator and floatValidator', () => {
    it('should validate integer values', () => {
      const validator = service.integerValidator();
      expect(validator(new FormControl('123'))).toBeNull();
      expect(validator(new FormControl('-456'))).toBeNull();
      expect(validator(new FormControl('0'))).toBeNull();
      expect(validator(new FormControl('12.34'))).not.toBeNull();
      expect(validator(new FormControl('abc'))).not.toBeNull();
    });

    it('should validate float values', () => {
      const validator = service.floatValidator();
      expect(validator(new FormControl('123'))).toBeNull();
      expect(validator(new FormControl('12.34'))).toBeNull();
      expect(validator(new FormControl('-0.56'))).toBeNull();
      expect(validator(new FormControl('abc'))).not.toBeNull();
    });
  });
});
