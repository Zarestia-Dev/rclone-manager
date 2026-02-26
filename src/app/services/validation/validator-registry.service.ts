import { Injectable, inject } from '@angular/core';
import { AbstractControl, ValidatorFn, ValidationErrors } from '@angular/forms';
import { TranslateService } from '@ngx-translate/core';
import { UiStateService } from '../ui/ui-state.service';
import { REMOTE_NAME_REGEX } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class ValidatorRegistryService {
  private validators = new Map<string, ValidatorFn>();
  private translate = inject(TranslateService);
  private uiStateService = inject(UiStateService);
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
        return { integer: { value, message: this.translate.instant('validators.integer') } };
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
        return { float: { value, message: this.translate.instant('validators.float') } };
      }
      return null;
    };
  }

  durationValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!this.getCachedRegex('^(\\d+(\\.\\d+)?(ns|us|µs|ms|s|m|h|d))+$').test(value)) {
        return { duration: { value, message: this.translate.instant('validators.duration') } };
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
          sizeSuffix: { value, message: this.translate.instant('validators.sizeSuffix') },
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
        tristate: { value: control.value, message: this.translate.instant('validators.tristate') },
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
            time: { value, message: this.translate.instant('validators.time') },
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
        return {
          spaceSepList: { value, message: this.translate.instant('validators.spaceSepList') },
        };
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
        return {
          bwTimetable: { value, message: this.translate.instant('validators.bwTimetable') },
        };
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
          fileMode: { value, message: this.translate.instant('validators.fileMode') },
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
          enum: {
            value,
            allowedValues,
            message: this.translate.instant('validators.enum', {
              values: allowedValues.join(', '),
            }),
          },
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
    this.registerValidator('crossPlatformPath', this.crossPlatformPathValidator());

    // URL array validator (for arrays of URLs)
    this.registerValidator('urlList', this.urlArrayValidator());

    // Bandwidth format validator
    this.registerValidator('bandwidthFormat', this.bandwidthValidator());

    // Password validator
    this.registerValidator('password', this.passwordValidator());

    // Remote name validator (requires existingNames parameter, so not pre-registered)
    // Use createRemoteNameValidator() instead
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
    return this.remoteNameValidator(existingNames, allowedPattern);
  }

  /**
   * Remote name validator implementation
   */
  private remoteNameValidator(existingNames: string[], allowedPattern?: RegExp): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const raw = control.value;
      const value = typeof raw === 'string' ? raw.trim() : raw;
      if (!value) return null;

      // Check allowed characters if pattern provided
      if (allowedPattern && !allowedPattern.test(value)) {
        return {
          invalidChars: { message: this.translate.instant('validators.remoteName.invalidChars') },
        };
      }

      // Check start character
      if (value.startsWith('-') || value.startsWith(' ')) {
        return {
          invalidStart: { message: this.translate.instant('validators.remoteName.invalidStart') },
        };
      }

      // Check end character
      if (control.value.endsWith(' ')) {
        return {
          invalidEnd: { message: this.translate.instant('validators.remoteName.invalidEnd') },
        };
      }

      // Check uniqueness (trimmed)
      const existingNormalized = existingNames.map(n => String(n).toLowerCase());
      return existingNormalized.includes(String(value))
        ? { nameTaken: { message: this.translate.instant('validators.remoteName.nameTaken') } }
        : null;
    };
  }

  /**
   * Platform-aware path validator
   */
  private crossPlatformPathValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;
      if (!value) return null;

      if (this.uiStateService.platform === 'windows') {
        const winAbs =
          /^(?:[a-zA-Z]:(?:[\\/].*)?|\\\\[?]?[\\]?[^\\/]+[\\/][^\\/]+|\\\\[a-zA-Z0-9_\-.]+[\\/][^\\/]+.*)$/;
        if (winAbs.test(value)) return null;
      } else {
        const unixAbs = /^(\/[^\0]*)$/;
        if (unixAbs.test(value)) return null;
      }

      return { invalidPath: { message: this.translate.instant('validators.invalidPath') } };
    };
  }

  /**
   * URL array validator
   */
  private urlArrayValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const urls = control.value;
      if (!Array.isArray(urls)) return null;
      if (urls.length === 0) return null;

      const urlPattern = /^https?:\/\/[^\s;]+$/;

      for (const url of urls) {
        if (typeof url !== 'string' || !urlPattern.test(url.trim())) {
          return {
            urlArray: {
              message: this.translate.instant('validators.urlArray'),
              invalidUrl: url,
            },
          };
        }
      }
      return null;
    };
  }

  /**
   * Bandwidth format validator
   */
  private bandwidthValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null;

      const bandwidthPattern =
        /^(\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*)(:\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*|)?$/;

      if (!bandwidthPattern.test(control.value)) {
        return {
          bandwidth: {
            message: this.translate.instant('validators.bandwidth'),
          },
        };
      }
      return null;
    };
  }

  /**
   * Password validator for backend/rclone config passwords
   */
  private passwordValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;
      if (!value) return null;

      if (value.length < 3) {
        return {
          minLength: {
            message: this.translate.instant('validators.password.minLength'),
            actualLength: value.length,
            requiredLength: 3,
          },
        };
      }

      if (/['"]/.test(value)) {
        return {
          invalidChars: { message: this.translate.instant('validators.password.invalidChars') },
        };
      }

      return null;
    };
  }

  /**
   * Password match validator for confirmation fields
   */
  passwordMatchValidator(passwordFieldName: string, confirmFieldName: string): ValidatorFn {
    return (group: AbstractControl): ValidationErrors | null => {
      const password = group.get(passwordFieldName)?.value;
      const confirm = group.get(confirmFieldName)?.value;

      if (password && confirm && password !== confirm) {
        return {
          passwordMismatch: { message: this.translate.instant('validators.passwordMismatch') },
        };
      }

      return null;
    };
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
