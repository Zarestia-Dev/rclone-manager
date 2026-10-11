import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { ValidationMessageResolver, resolveMessage } from './validator.types';
import { isMatchingExample } from './format.validators';

const URL_PATTERN_REGEX = /^https?:\/\/[^\s;]+$/;

export function arrayValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (!control.value || Array.isArray(control.value) || typeof control.value === 'string') {
      return null;
    }
    return { invalidArray: true };
  };
}

export function tristateValidator(messageResolver?: ValidationMessageResolver): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    if (typeof control.value === 'boolean') return null;
    const str = String(control.value).trim().toLowerCase();
    if (['true', 'false', 'unset'].includes(str)) return null;
    return {
      tristate: {
        value: control.value,
        message: resolveMessage(messageResolver, 'validators.tristate'),
      },
    };
  };
}

export function spaceSepListValidator(
  defaultValue?: string,
  allowedExamples?: readonly (string | { Value?: unknown })[],
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    const raw = control.value.toString();
    const value = raw.trim();
    if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
    if (isMatchingExample(value, allowedExamples)) return null;
    if (raw.length > 0 && !/\S/.test(raw)) {
      return {
        spaceSepList: {
          value,
          message: resolveMessage(messageResolver, 'validators.spaceSepList'),
        },
      };
    }
    return null;
  };
}

export function enumValidator(
  allowedValues: readonly unknown[],
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  const lowerValues = allowedValues.map(v => String(v ?? '').toLowerCase());
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    const value = control.value.toString().trim().toLowerCase();
    if (lowerValues.includes(value)) {
      return null;
    }
    return {
      enum: {
        value,
        allowedValues,
        message: resolveMessage(messageResolver, 'validators.enum', {
          values: allowedValues.map(v => String(v)).join(', '),
        }),
      },
    };
  };
}

export function urlArrayValidator(messageResolver?: ValidationMessageResolver): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const urls = control.value;
    if (!Array.isArray(urls) || urls.length === 0) return null;

    for (const url of urls) {
      if (typeof url !== 'string' || !URL_PATTERN_REGEX.test(url.trim())) {
        return {
          urlArray: {
            message: resolveMessage(messageResolver, 'validators.urlArray'),
            invalidUrl: url,
          },
        };
      }
    }
    return null;
  };
}
