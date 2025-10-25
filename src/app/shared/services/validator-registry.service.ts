import { Injectable, inject } from '@angular/core';
import { AbstractControl, ValidatorFn, ValidationErrors } from '@angular/forms';
import { ValidatorsService } from './validators.service';

@Injectable({
  providedIn: 'root',
})
export class ValidatorRegistryService {
  private validators = new Map<string, ValidatorFn>();
  private validatorsService = inject(ValidatorsService);
  private regexCache = new Map<string, RegExp>();

  constructor() {
    this.registerBuiltinValidators();
  }

  private getCachedRegex(pattern: string): RegExp {
    const existing = this.regexCache.get(pattern);
    if (existing) return existing;
    const compiled = new RegExp(pattern);
    this.regexCache.set(pattern, compiled);
    return compiled;
  }

  // ------- Validator factories moved from SettingControlComponent -------

  arrayValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null;
      if (Array.isArray(control.value)) return null;
      return { invalidArray: true };
    };
  }

  integerValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!this.getCachedRegex('^-?\\d+$').test(value)) {
        return { integer: { value, message: 'Must be a valid integer' } };
      }
      return null;
    };
  }

  floatValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!this.getCachedRegex('^-?\\d+(\\.\\d+)?$').test(value)) {
        return { float: { value, message: 'Must be a valid decimal number' } };
      }
      return null;
    };
  }

  durationValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!this.getCachedRegex('^(\\d+(\\.\\d+)?(ns|us|µs|ms|s|m|h))+$').test(value)) {
        return { duration: { value, message: 'Invalid duration format. Use: 1h30m45s, 5m, 1h' } };
      }
      return null;
    };
  }

  sizeSuffixValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (value.toLowerCase() === 'off') return null;
      if (
        !this.getCachedRegex('^\\d+(\\.\\d+)?(b|B|k|K|Ki|M|Mi|G|Gi|T|Ti|P|Pi|E|Ei)?$').test(value)
      ) {
        return {
          sizeSuffix: { value, message: 'Invalid size format. Use: 100Ki, 16Mi, 1Gi, or "off"' },
        };
      }
      return null;
    };
  }

  tristateValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const allowedValues = [null, true, false];
      if (allowedValues.includes(control.value)) return null;
      return {
        tristate: { value: control.value, message: 'Value must be true, false, or unset.' },
      };
    };
  }

  timeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (
        !this.getCachedRegex(
          '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?([+-]\\d{2}:\\d{2}|Z)?$'
        ).test(value)
      ) {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return {
            time: { value, message: 'Invalid datetime format. Use ISO 8601: YYYY-MM-DDTHH:mm:ssZ' },
          };
        }
      }
      return null;
    };
  }

  spaceSepListValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (value.length > 0 && !/\S/.test(value)) {
        return { spaceSepList: { value, message: 'List cannot contain only whitespace' } };
      }
      return null;
    };
  }

  bwTimetableValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (value.toLowerCase() === 'off') return null;
      const hasTimetable = value.includes(',') || value.includes('-') || value.includes(':');
      if (
        !this.getCachedRegex('^\\d+(\\.\\d+)?(B|K|M|G|T|P)?$').test(value) &&
        !hasTimetable &&
        value.length > 0
      ) {
        return { bwTimetable: { value, message: 'Invalid bandwidth format' } };
      }
      return null;
    };
  }

  fileModeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!this.getCachedRegex('^[0-7]{3,4}$').test(value)) {
        return {
          fileMode: { value, message: 'Must be octal format (3-4 digits, each 0-7). Example: 755' },
        };
      }
      return null;
    };
  }

  enumValidator(allowedValues: string[]): ValidatorFn {
    const lowerValues = allowedValues.map(v => v.toLowerCase());
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim().toLowerCase();
      if (!lowerValues.includes(value)) {
        return {
          enum: { value, allowedValues, message: `Must be one of: ${allowedValues.join(', ')}` },
        };
      }
      return null;
    };
  }

  /**
   * Register built-in validators that can be referenced by name from backend metadata
   */
  private registerBuiltinValidators(): void {
    // Cross-platform path validator
    this.registerValidator(
      'crossPlatformPath',
      this.validatorsService.crossPlatformPathValidator()
    );

    // URL validator
    this.registerValidator('url', this.validatorsService.urlValidator());

    // Port validator
    this.registerValidator('port', this.validatorsService.portValidator());

    // Port range validator
    this.registerValidator('portRange', this.validatorsService.portRangeValidator(1024, 65535));

    // URL array validator (for arrays of URLs)
    this.registerValidator('urlList', this.validatorsService.urlArrayValidator());

    // Bandwidth format validator
    this.registerValidator('bandwidthFormat', this.validatorsService.bandwidthValidator());

    // Numeric range validators
    this.registerValidator('trayItemsRange', this.validatorsService.numericRangeValidator(1, 40));
  }

  /**
   * Register a custom validator with a given name
   */
  registerValidator(name: string, validator: ValidatorFn): void {
    this.validators.set(name, validator);
  }

  /**
   * Get a validator by name
   */
  getValidator(name: string): ValidatorFn | null {
    return this.validators.get(name) || null;
  }

  /**
   * Get all registered validator names
   */
  getValidatorNames(): string[] {
    return Array.from(this.validators.keys());
  }

  /**
   * Create a validator from metadata (supports both regex and named validators)
   */
  createValidatorFromMetadata(metadata: {
    validation_type?: string;
    validation_pattern?: string;
    validation_message?: string;
    value_type?: string;
  }): ValidatorFn | null {
    // If validation_type starts with "frontend:", use the named validator
    if (metadata.validation_type?.startsWith('frontend:')) {
      const validatorName = metadata.validation_type.substring('frontend:'.length);
      const validator = this.getValidator(validatorName);

      if (!validator) {
        console.warn(`Frontend validator '${validatorName}' not found in registry`);
        return null;
      }

      return validator;
    }

    // If validation_type is "regex" or we have a validation_pattern, use regex
    if (metadata.validation_type === 'regex' || metadata.validation_pattern) {
      const pattern = metadata.validation_pattern;
      const message = metadata.validation_message || 'Invalid format';

      if (pattern) {
        return this.validatorsService.regexValidator(pattern, message);
      }
    }

    // For path types, always apply cross-platform path validation
    if (metadata.value_type === 'path') {
      return this.getValidator('crossPlatformPath');
    }

    return null;
  }

  /**
   * Create a remote name validator with existing names and regex pattern
   */
  createRemoteNameValidator(existingNames: string[], allowedPattern?: RegExp): ValidatorFn {
    return this.validatorsService.remoteNameValidator(existingNames, allowedPattern);
  }

  /**
   * Create a regex validator
   */
  /**
   * Debug method to test validators from console
   * Usage: (window as any).validatorRegistry.testValidator('crossPlatformPath', '/invalid<>path')
   */
  testValidator(
    validatorName: string,
    value: unknown
  ):
    | {
        validatorName: string;
        value: unknown;
        isValid: boolean;
        errors: Record<string, unknown> | null;
      }
    | { error: string } {
    const validator = this.getValidator(validatorName);
    if (!validator) {
      return { error: `Validator '${validatorName}' not found` };
    }

    const control = { value } as AbstractControl;
    const result = validator(control);

    return {
      validatorName,
      value,
      isValid: result === null,
      errors: result,
    };
  }
}
