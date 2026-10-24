import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { ValidationMessageResolver, resolveMessage } from './validator.types';

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
