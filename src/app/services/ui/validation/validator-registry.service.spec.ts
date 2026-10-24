import { TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { describe, it, expect, beforeEach, vi, assert } from 'vitest';
import { ValidatorRegistryService } from './validator-registry.service';

describe('ValidatorRegistryService', () => {
  let service: ValidatorRegistryService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideTranslateService(), ValidatorRegistryService],
    });
    service = TestBed.inject(ValidatorRegistryService);
  });

  it.each([
    {
      name: 'urlList',
      valid: ['https://example.com/Arşiv?q=1'],
      invalid: ['invalid-url'],
      error: 'urlArray',
      translationKey: 'validators.urlArray',
    },
    {
      name: 'bandwidthFormat',
      valid: '10M',
      invalid: 'not-bandwidth',
      error: 'bandwidth',
      translationKey: 'validators.bandwidth',
    },
  ])('resolves $name with translated errors and optional empty values', testCase => {
    vi.spyOn(TestBed.inject(TranslateService), 'instant').mockImplementation(
      key => `translated:${key}`
    );
    const validator = service.getValidator(testCase.name);
    assert(validator, `Missing validator: ${testCase.name}`);
    expect(validator(new FormControl<unknown>(testCase.valid))).toBeNull();
    for (const empty of [null, undefined, '']) {
      expect(validator(new FormControl(empty))).toBeNull();
    }
    expect(validator(new FormControl<unknown>(testCase.invalid))).toMatchObject({
      [testCase.error]: { message: `translated:${testCase.translationKey}` },
    });
  });

  it('returns no validator for unknown or empty names', () => {
    expect(service.getValidator('unknown')).toBeNull();
    expect(service.getValidator('')).toBeNull();
  });

  it('matches passwords using the supplied field names and current translations', () => {
    let language = 'en';
    vi.spyOn(TestBed.inject(TranslateService), 'instant').mockImplementation(
      key => `${language}:${key}`
    );
    const validator = service.passwordMatchValidator('secret', 'repeated');
    const group = new FormGroup({
      secret: new FormControl('Arşiv & 旅行'),
      repeated: new FormControl('Arşiv & 旅行'),
    });
    expect(validator(group)).toBeNull();
    group.controls.repeated.setValue('different');
    expect(validator(group)).toEqual({
      passwordMismatch: { message: 'en:validators.passwordMismatch' },
    });
    language = 'tr';
    expect(validator(group)).toEqual({
      passwordMismatch: { message: 'tr:validators.passwordMismatch' },
    });
    for (const empty of ['', null]) {
      group.controls.repeated.setValue(empty);
      expect(validator(group)).toBeNull();
    }
  });

  it('validates remote names with the default pattern and translated duplicate errors', () => {
    vi.spyOn(TestBed.inject(TranslateService), 'instant').mockImplementation(
      key => `translated:${key}`
    );
    const validator = service.createRemoteNameValidator(['existing']);
    expect(validator(new FormControl('new-remote'))).toBeNull();
    expect(validator(new FormControl('existing'))).toEqual({
      nameTaken: { message: 'translated:validators.remoteName.nameTaken' },
    });
    expect(validator(new FormControl('bad:remote'))).toEqual({
      invalidChars: { message: 'translated:validators.remoteName.invalidChars' },
    });
  });

  it('passes custom remote name patterns and preserves optional empty values', () => {
    const validator = service.createRemoteNameValidator(['旅行'], /^[\p{L}\p{N} _-]+$/u);
    expect(validator(new FormControl('Arşiv'))).toBeNull();
    expect(validator(new FormControl('旅行'))?.['nameTaken']).toBeDefined();
    expect(validator(new FormControl('bad/path'))?.['invalidChars']).toBeDefined();
    for (const empty of [null, undefined, '']) {
      expect(validator(new FormControl(empty))).toBeNull();
    }
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
