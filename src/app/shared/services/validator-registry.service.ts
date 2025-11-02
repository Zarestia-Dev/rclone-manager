import { Injectable, inject } from '@angular/core';
import { AbstractControl, ValidatorFn, ValidationErrors } from '@angular/forms';
import { ValidatorsService } from './validators.service';
import { REMOTE_NAME_REGEX } from '@app/types';

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

    // URL array validator (for arrays of URLs)
    this.registerValidator('urlList', this.validatorsService.urlArrayValidator());

    // Bandwidth format validator
    this.registerValidator('bandwidthFormat', this.validatorsService.bandwidthValidator());
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

  requiredIfLocal(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const pathGroup = control.parent;
      const opGroup = pathGroup?.parent;

      if (!pathGroup || !opGroup) {
        return null; // Cannot determine context, so don't validate.
      }

      const autoStart = opGroup.get('autoStart')?.value;
      const pathType = pathGroup.get('pathType')?.value;

      // The field is required if autoStart is on, the path type is local, and there's no value.
      if (autoStart && pathType === 'local' && !control.value) {
        return { required: true };
      }

      return null;
    };
  }

  /**
   * Create a remote name validator with existing names and regex pattern
   */
  createRemoteNameValidator(
    existingNames: string[],
    allowedPattern: RegExp = REMOTE_NAME_REGEX
  ): ValidatorFn {
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
