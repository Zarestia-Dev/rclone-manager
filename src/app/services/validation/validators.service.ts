import { Injectable, inject } from '@angular/core';
import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { UiStateService } from '../../services/ui/ui-state.service';

@Injectable({
  providedIn: 'root',
})
export class ValidatorsService {
  private uiStateService = inject(UiStateService);

  /**
   * Platform-aware path validator.
   */
  crossPlatformPathValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;
      // Allow empty values, as 'required' validator will handle this.
      if (!value) return null;

      if (this.uiStateService.platform === 'windows') {
        const winAbs =
          /^(?:[a-zA-Z]:(?:[\\/].*)?|\\\\[?]?[\\]?[^\\/]+[\\/][^\\/]+|\\\\[a-zA-Z0-9_\-.]+[\\/][^\\/]+.*)$/;
        if (winAbs.test(value)) return null;
      } else {
        const unixAbs = /^(\/[^\0]*)$/;
        if (unixAbs.test(value)) return null;
      }

      return { invalidPath: true };
    };
  }

  /**
   * Validates an array of URLs.
   */
  urlArrayValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      // We expect a FormArray here, but if it's a control, check its value
      const urls = control.value;
      if (!Array.isArray(urls)) return null; // Not an array, other validators will catch
      if (urls.length === 0) return null; // Empty array is valid

      const urlPattern = /^https?:\/\/[^\s;]+$/;

      for (const url of urls) {
        if (typeof url !== 'string' || !urlPattern.test(url.trim())) {
          return {
            urlArray: {
              message: 'All items must be valid URLs',
              invalidUrl: url,
            },
          };
        }
      }
      return null;
    };
  }

  /**
   * Validates bandwidth format (e.g., 10M, 5M:2M, 1G).
   */
  bandwidthValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null; // Empty is allowed for "no limit"

      const bandwidthPattern =
        /^(\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*)(:\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*|)?$/;

      if (!bandwidthPattern.test(control.value)) {
        return {
          bandwidth: {
            message: 'Invalid format (e.g., 10M or 5M:2M). Keep empty for no limit.',
          },
        };
      }
      return null;
    };
  }

  remoteNameValidator(existingNames: string[], allowedPattern?: RegExp): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const raw = control.value;
      const value = typeof raw === 'string' ? raw.trim() : raw;
      if (!value) return null;

      // Check allowed characters if pattern provided
      if (allowedPattern && !allowedPattern.test(value)) {
        return { invalidChars: true };
      }

      // Check start character
      if (value.startsWith('-') || value.startsWith(' ')) {
        return { invalidStart: true };
      }

      // Check end character
      if (control.value.endsWith(' ')) {
        return { invalidEnd: true };
      }

      // Check uniqueness (case-insensitive, trimmed)
      const normalized = String(value).toLowerCase();
      const existingNormalized = existingNames.map(n => String(n).toLowerCase());
      return existingNormalized.includes(normalized) ? { nameTaken: true } : null;
    };
  }

  /**
   * Validates that the value is a valid integer.
   */
  integerValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (control.value === null || control.value === '') return null;
      const value = String(control.value).trim();
      if (!/^-?\d+$/.test(value)) {
        return { integer: { message: 'Must be a valid integer' } };
      }
      return null;
    };
  }

  /**
   * Password validator for backend/rclone config passwords
   * Rules: minimum 3 characters, no single/double quotes
   */
  passwordValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;
      if (!value) return null;

      if (value.length < 3) {
        return {
          minLength: {
            message: 'Password must be at least 3 characters',
            actualLength: value.length,
            requiredLength: 3,
          },
        };
      }

      if (/['"]/.test(value)) {
        return { invalidChars: { message: 'Password cannot contain quotes' } };
      }

      return null;
    };
  }

  /**
   * Validator for password confirmation fields
   * Compares two password fields in a form group and returns error if they don't match
   * @param passwordFieldName Name of the main password field
   * @param confirmFieldName Name of the confirmation field
   */
  passwordMatchValidator(passwordFieldName: string, confirmFieldName: string): ValidatorFn {
    return (group: AbstractControl): ValidationErrors | null => {
      const password = group.get(passwordFieldName)?.value;
      const confirm = group.get(confirmFieldName)?.value;

      if (password && confirm && password !== confirm) {
        return { passwordMismatch: { message: 'Passwords do not match' } };
      }

      return null;
    };
  }
}
