import { Injectable, inject } from '@angular/core';
import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { UiStateService } from '../../services/ui/ui-state.service';

@Injectable({
  providedIn: 'root',
})
export class ValidatorsService {
  private uiStateService = inject(UiStateService);

  /**
   * Platform-aware path validator that validates file paths based on the detected operating system.
   *
   * For Windows: Validates paths like C:\path\to\file or D:/path/to/file
   * For Unix/Linux/macOS: Validates paths like /path/to/file
   *
   * @returns ValidatorFn that returns null if valid, or { invalidPath: true } if invalid
   */
  crossPlatformPathValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;
      if (!value) return null;

      if (this.uiStateService.platform === 'windows') {
        // Windows absolute path pattern: C:, C:\, C:/, C: followed by optional path
        // Matches drive letters (C:, D:), UNC paths (\\server\share\...), and extended-length paths (\\?\C:\...)
        const winAbs =
          /^(?:[a-zA-Z]:(?:[\\/].*)?|\\\\[?]?[\\]?[^\\/]+[\\/][^\\/]+|\\\\[a-zA-Z0-9_\-.]+[\\/][^\\/]+.*)$/;
        if (winAbs.test(value)) return null;
      } else {
        // Unix/Linux/macOS absolute path pattern: starts with / followed by any valid characters
        const unixAbs = /^(\/[^\0]*)$/;
        if (unixAbs.test(value)) return null;
      }

      return { invalidPath: true };
    };
  }

  /**
   * JSON validator that checks if the provided value is valid JSON.
   *
   * @returns ValidatorFn that returns null if valid JSON, or { invalidJson: true } if invalid
   */
  jsonValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null;

      try {
        JSON.parse(control.value);
        return null;
      } catch {
        return { invalidJson: true };
      }
    };
  }

  /**
   * Custom remote name validator factory that checks for valid characters and uniqueness.
   *
   * @param existingNames Array of existing remote names to check against
   * @param allowedPattern RegExp pattern for allowed characters (optional)
   * @returns ValidatorFn that validates remote names
   */
  remoteNameValidator(existingNames: string[], allowedPattern?: RegExp): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value?.trimEnd();
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

      // Check uniqueness
      return existingNames.includes(value) ? { nameTaken: true } : null;
    };
  }

  /**
   * Validates that a URL is properly formatted.
   *
   * @returns ValidatorFn that validates URL format
   */
  urlValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null;

      try {
        new URL(control.value);
        return null;
      } catch {
        return { invalidUrl: true };
      }
    };
  }

  /**
   * Validates that a port number is within valid range (1-65535).
   *
   * @returns ValidatorFn that validates port numbers
   */
  portValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;
      if (!value) return null;

      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        return { invalidPort: true };
      }

      return null;
    };
  }

  /**
   * Creates a port range validator for a specific range.
   *
   * @param min Minimum port number
   * @param max Maximum port number
   * @returns ValidatorFn that validates port numbers within the specified range
   */
  portRangeValidator(min: number, max: number): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null;

      const port = parseInt(control.value, 10);
      if (isNaN(port) || port < min || port > max) {
        return {
          portRange: {
            message: `Port must be between ${min} and ${max}`,
            actualValue: control.value,
            min,
            max,
          },
        };
      }

      return null;
    };
  }

  /**
   * Validates an array of URLs.
   *
   * @returns ValidatorFn that validates each URL in an array
   */
  urlArrayValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null;

      // Handle both array and string input for backwards compatibility
      let urls: string[];
      if (Array.isArray(control.value)) {
        urls = control.value;
      } else if (typeof control.value === 'string') {
        // Fallback for semicolon-separated strings
        urls = control.value.split(';').map((url: string) => url.trim());
      } else {
        return {
          urlArray: {
            message: 'Value must be an array of URLs',
            actualValue: control.value,
          },
        };
      }

      const urlPattern = /^https?:\/\/[^\s;]+$/;

      for (const url of urls) {
        if (typeof url !== 'string' || !urlPattern.test(url.trim())) {
          return {
            urlArray: {
              message: 'All items must be valid URLs',
              actualValue: control.value,
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
   *
   * @returns ValidatorFn that validates bandwidth format
   */
  bandwidthValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null; // Empty is allowed for "no limit"

      const bandwidthPattern =
        /^(\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*)(:\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*|)?$/;

      if (!bandwidthPattern.test(control.value)) {
        return {
          bandwidth: {
            message:
              'The bandwidth should be of the form 1M|2M|1G|1K|1.1K etc. Can also be specified as (upload:download). Keep it empty for no limit.',
            actualValue: control.value,
          },
        };
      }

      return null;
    };
  }

  /**
   * Creates a numeric range validator.
   *
   * @param min Minimum value
   * @param max Maximum value
   * @returns ValidatorFn that validates numeric values within the specified range
   */
  numericRangeValidator(min: number, max: number): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null;

      const num = parseInt(control.value, 10);
      if (isNaN(num) || num < min || num > max) {
        return {
          numericRange: {
            message: `Must be between ${min} and ${max}`,
            actualValue: control.value,
            min,
            max,
          },
        };
      }

      return null;
    };
  }

  /**
   * Creates a regex validator with a custom message.
   *
   * @param pattern Regex pattern
   * @param message Error message
   * @returns ValidatorFn that validates against the regex pattern
   */
  regexValidator(pattern: string, message: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value) return null; // Let required validator handle empty values

      try {
        const regex = new RegExp(pattern);
        if (!regex.test(control.value)) {
          return { pattern: { message, actualValue: control.value, requiredPattern: pattern } };
        }
      } catch (error) {
        console.error('Invalid regex pattern:', pattern, error);
        return { pattern: { message: 'Invalid validation pattern', actualValue: control.value } };
      }

      return null;
    };
  }
}
