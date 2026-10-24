import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { ValidationMessageResolver, resolveMessage } from './validator.types';

const INTEGER_REGEX = /^-?\d+$/;
const FLOAT_REGEX = /^-?\d+(\.\d+)?$/;
const DURATION_REGEX = /^(\d+(?:\.\d+)?(ns|us|µs|ms|s|m|h|d|w|M|y))+$/;
const SIZE_SUFFIX_REGEX =
  /^\d+(?:\.\d+)?\s*(b|k|m|g|t|p|e|ki|mi|gi|ti|pi|ei|kb|mb|gb|tb|pb|eb|kib|mib|gib|tib|pib|eib)?$/i;
const TIME_REGEX =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[+-]\d{2}:\d{2}|Z)?)?$/;
const FILE_MODE_REGEX = /^0?[0-7]{3,4}$/;
const BW_TIMETABLE_SLOT_REGEX =
  /^(?:(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)-)?([01]?\d|2[0-3]):[0-5]\d,(?:off|\d+(?:\.\d+)?\s*(?:[bBkKmMgGtTpPeE](?:i?B)?)?)(?::(?:off|\d+(?:\.\d+)?\s*(?:[bBkKmMgGtTpPeE](?:i?B)?)?))?$/i;
const BW_PAIR_REGEX =
  /^(?:off|\d+(?:\.\d+)?\s*(?:[bBkKmMgGtTpPeE](?:i?B)?)?)(?::(?:off|\d+(?:\.\d+)?\s*(?:[bBkKmMgGtTpPeE](?:i?B)?)?))?$/i;
const BANDWIDTH_PATTERN_REGEX =
  /^(\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*)(:\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?(\|\d+(?:\.\d+)?([KMGkmg]|Mi|mi|Gi|gi|Ki|ki)?)*|)?$/;

export function isMatchingExample(
  value: string,
  examples?: readonly (string | { Value?: unknown })[]
): boolean {
  if (!examples || !examples.length) return false;
  const lower = value.toLowerCase();
  return examples.some(ex => {
    const v = typeof ex === 'object' && ex !== null ? String(ex.Value ?? '') : String(ex);
    return v.trim().toLowerCase() === lower;
  });
}

export function integerValidator(
  defaultValue?: string,
  allowedExamples?: readonly (string | { Value?: unknown })[],
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    const value = control.value.toString().trim();
    if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
    if (isMatchingExample(value, allowedExamples)) return null;
    if (!INTEGER_REGEX.test(value)) {
      return {
        integer: {
          value,
          message: resolveMessage(messageResolver, 'validators.integer'),
        },
      };
    }
    return null;
  };
}

export function floatValidator(
  defaultValue?: string,
  allowedExamples?: readonly (string | { Value?: unknown })[],
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    const value = control.value.toString().trim();
    if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
    if (isMatchingExample(value, allowedExamples)) return null;
    if (!FLOAT_REGEX.test(value)) {
      return {
        float: {
          value,
          message: resolveMessage(messageResolver, 'validators.float'),
        },
      };
    }
    return null;
  };
}

export function durationValidator(
  defaultValue?: string,
  allowedExamples?: readonly (string | { Value?: unknown })[],
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    const value = control.value.toString().trim();
    if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
    if (isMatchingExample(value, allowedExamples)) return null;
    if (value.toLowerCase() === 'off' || value === '0') return null;
    if (!DURATION_REGEX.test(value) && !/^\d+(?:\.\d+)?$/.test(value) && isNaN(Date.parse(value))) {
      return {
        duration: {
          value,
          message: resolveMessage(messageResolver, 'validators.duration'),
        },
      };
    }
    return null;
  };
}

export function sizeSuffixValidator(
  defaultValue?: string,
  allowedExamples?: readonly (string | { Value?: unknown })[],
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    const value = control.value.toString().trim();
    if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
    if (isMatchingExample(value, allowedExamples)) return null;
    if (value.toLowerCase() === 'off' || value === '0') return null;
    if (!SIZE_SUFFIX_REGEX.test(value)) {
      return {
        sizeSuffix: {
          value,
          message: resolveMessage(messageResolver, 'validators.sizeSuffix'),
        },
      };
    }
    return null;
  };
}

export function timeValidator(
  defaultValue?: string,
  allowedExamples?: readonly (string | { Value?: unknown })[],
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    const value = control.value.toString().trim();
    if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
    if (isMatchingExample(value, allowedExamples)) return null;
    if (!TIME_REGEX.test(value) && isNaN(new Date(value).getTime())) {
      return {
        time: {
          value,
          message: resolveMessage(messageResolver, 'validators.time'),
        },
      };
    }
    return null;
  };
}

export function fileModeValidator(
  defaultValue?: string,
  allowedExamples?: readonly (string | { Value?: unknown })[],
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    const value = control.value.toString().trim();
    if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
    if (isMatchingExample(value, allowedExamples)) return null;
    if (!FILE_MODE_REGEX.test(value)) {
      return {
        fileMode: {
          value,
          message: resolveMessage(messageResolver, 'validators.fileMode'),
        },
      };
    }
    return null;
  };
}

export function bwTimetableValidator(
  defaultValue?: string,
  allowedExamples?: readonly (string | { Value?: unknown })[],
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === null || control.value === undefined || control.value === '') {
      return null;
    }
    const value = control.value.toString().trim();
    if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
    if (isMatchingExample(value, allowedExamples)) return null;
    if (value.toLowerCase() === 'off') return null;
    if (BW_PAIR_REGEX.test(value)) return null;
    const slots = value.split(/\s+/);
    const isValidSchedule =
      slots.length > 0 && slots.every((slot: string) => BW_TIMETABLE_SLOT_REGEX.test(slot));
    if (!isValidSchedule) {
      return {
        bwTimetable: {
          value,
          message: resolveMessage(messageResolver, 'validators.bwTimetable'),
        },
      };
    }
    return null;
  };
}

export function bandwidthValidator(messageResolver?: ValidationMessageResolver): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (!control.value) return null;
    if (!BANDWIDTH_PATTERN_REGEX.test(control.value)) {
      return {
        bandwidth: {
          message: resolveMessage(messageResolver, 'validators.bandwidth'),
        },
      };
    }
    return null;
  };
}
