import { Injectable, inject } from '@angular/core';
import { AbstractControl, ValidatorFn, ValidationErrors } from '@angular/forms';
import { TranslateService } from '@ngx-translate/core';
import { UiStateService } from '../state/ui-state.service';
import { REMOTE_NAME_REGEX } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class ValidatorRegistryService {
  private readonly validators = new Map<string, ValidatorFn>();
  private readonly translate = inject(TranslateService);
  private readonly uiStateService = inject(UiStateService);
  private readonly regexCache = new Map<string, RegExp>();

  constructor() {
    this.validators.set('crossPlatformPath', this.crossPlatformPathValidator());
    this.validators.set('urlList', this.urlArrayValidator());
    this.validators.set('bandwidthFormat', this.bandwidthValidator());
    this.validators.set('password', this.passwordValidator());
  }

  private getCachedRegex(pattern: string): RegExp {
    let compiled = this.regexCache.get(pattern);
    if (!compiled) {
      compiled = new RegExp(pattern);
      this.regexCache.set(pattern, compiled);
    }
    return compiled;
  }

  registerValidator(name: string, validator: ValidatorFn): void {
    this.validators.set(name, validator);
  }

  getValidator(name: string): ValidatorFn | null {
    return this.validators.get(name) ?? null;
  }

  arrayValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || Array.isArray(control.value)) return null;
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
        return { sizeSuffix: { value, message: this.translate.instant('validators.sizeSuffix') } };
      }
      return null;
    };
  }

  tristateValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if ([null, true, false].includes(control.value)) return null;
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
        ).test(value) &&
        isNaN(new Date(value).getTime())
      ) {
        return { time: { value, message: this.translate.instant('validators.time') } };
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
        return { fileMode: { value, message: this.translate.instant('validators.fileMode') } };
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

  requiredIfLocal(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const pathGroup = control.parent;
      const opGroup = pathGroup?.parent;
      if (!pathGroup || !opGroup) return null;

      const autoStart = opGroup.get('autoStart')?.value;
      const type = pathGroup.get('type')?.value;
      if (autoStart && type === 'local' && !control.value) return { required: true };
      return null;
    };
  }

  requiredIfCronEnabled(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const opGroup = control.parent;
      if (!opGroup) return null;
      if (opGroup.get('cronEnabled')?.value && !control.value) return { required: true };
      return null;
    };
  }

  requiredIfWatchEnabled(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const opGroup = control.parent;
      if (!opGroup) return null;
      if (!opGroup.get('watchEnabled')?.value) return null;

      if (control.value === null || control.value === undefined || control.value === '') {
        return { required: true };
      }
      const val = Number(control.value);
      if (isNaN(val) || val < 1) {
        return { min: { min: 1, actual: control.value } };
      }
      return null;
    };
  }

  createRemoteNameValidator(
    existingNames: string[],
    allowedPattern: RegExp = REMOTE_NAME_REGEX
  ): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const raw = control.value;
      const value = typeof raw === 'string' ? raw.trim() : raw;
      if (!value) return null;

      if (allowedPattern && !allowedPattern.test(value)) {
        return {
          invalidChars: { message: this.translate.instant('validators.remoteName.invalidChars') },
        };
      }
      if (value.startsWith('-') || value.startsWith(' ')) {
        return {
          invalidStart: { message: this.translate.instant('validators.remoteName.invalidStart') },
        };
      }
      if (control.value.endsWith(' ')) {
        return {
          invalidEnd: { message: this.translate.instant('validators.remoteName.invalidEnd') },
        };
      }

      const existingTrimmed = existingNames.map(n => String(n).trim());
      return existingTrimmed.includes(String(value))
        ? { nameTaken: { message: this.translate.instant('validators.remoteName.nameTaken') } }
        : null;
    };
  }

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

  private crossPlatformPathValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;
      if (!value) return null;

      if (this.uiStateService.platform === 'windows') {
        const winAbs =
          /^(?:[a-zA-Z]:(?:[\\/].*)?|\\\\[?]?[\\]?[^\\/]+[\\/][^\\/]+|\\\\[a-zA-Z0-9_\-.]+[\\/][^\\/]+.*)$/;
        if (winAbs.test(value)) return null;
      } else {
        if (/^(\/[^\0]*)$/.test(value)) return null;
      }

      return { invalidPath: { message: this.translate.instant('validators.invalidPath') } };
    };
  }

  private urlArrayValidator(): ValidatorFn {
    const urlPattern = /^https?:\/\/[^\s;]+$/;
    return (control: AbstractControl): ValidationErrors | null => {
      const urls = control.value;
      if (!Array.isArray(urls) || urls.length === 0) return null;

      for (const url of urls) {
        if (typeof url !== 'string' || !urlPattern.test(url.trim())) {
          return {
            urlArray: { message: this.translate.instant('validators.urlArray'), invalidUrl: url },
          };
        }
      }
      return null;
    };
  }

  private bandwidthValidator(): ValidatorFn {
    const bandwidthPattern =
      /^(\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*)(:\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*|)?$/;
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null;
      if (!bandwidthPattern.test(control.value)) {
        return { bandwidth: { message: this.translate.instant('validators.bandwidth') } };
      }
      return null;
    };
  }

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
}
