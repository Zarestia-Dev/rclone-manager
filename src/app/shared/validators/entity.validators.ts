import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { REMOTE_NAME_REGEX } from '@app/types';
import { ValidationMessageResolver, resolveMessage } from './validator.types';

export function remoteNameValidator(
  existingNames: readonly string[],
  allowedPattern: RegExp = REMOTE_NAME_REGEX,
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = control.value;
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (!value) return null;

    if (allowedPattern && !allowedPattern.test(value)) {
      return {
        invalidChars: {
          message: resolveMessage(messageResolver, 'validators.remoteName.invalidChars'),
        },
      };
    }
    if (value.startsWith('-') || value.startsWith(' ')) {
      return {
        invalidStart: {
          message: resolveMessage(messageResolver, 'validators.remoteName.invalidStart'),
        },
      };
    }
    if (control.value.endsWith(' ')) {
      return {
        invalidEnd: {
          message: resolveMessage(messageResolver, 'validators.remoteName.invalidEnd'),
        },
      };
    }

    const existingTrimmed = existingNames.map(n => String(n).trim());
    return existingTrimmed.includes(String(value))
      ? {
          nameTaken: {
            message: resolveMessage(messageResolver, 'validators.remoteName.nameTaken'),
          },
        }
      : null;
  };
}

export function passwordValidator(messageResolver?: ValidationMessageResolver): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (!value) return null;
    if (value.length < 3) {
      return {
        minLength: {
          message: resolveMessage(messageResolver, 'validators.password.minLength'),
          actualLength: value.length,
          requiredLength: 3,
        },
      };
    }
    if (/['"]/.test(value)) {
      return {
        invalidChars: {
          message: resolveMessage(messageResolver, 'validators.password.invalidChars'),
        },
      };
    }
    return null;
  };
}

export function passwordMatchValidator(
  passwordFieldName: string,
  confirmFieldName: string,
  messageResolver?: ValidationMessageResolver
): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const password = group.get(passwordFieldName)?.value;
    const confirm = group.get(confirmFieldName)?.value;
    if (password && confirm && password !== confirm) {
      return {
        passwordMismatch: {
          message: resolveMessage(messageResolver, 'validators.passwordMismatch'),
        },
      };
    }
    return null;
  };
}

export function uniqueNameValidator(config: {
  existingNames: readonly string[];
  typeLabel?: string;
}): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const existing = (config.existingNames || []).map(e => e.toString().trim().toLowerCase());
    const val = (control.value || '').toString().trim().toLowerCase();
    return existing.some(e => e === val) ? { alreadyExists: true } : null;
  };
}

export function forbiddenCharsValidator(forbidden: readonly string[] = ['/', ':']): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const val = (control.value || '').toString();
    return forbidden.some(ch => val.includes(ch)) ? { forbiddenChars: true } : null;
  };
}

export function duplicateNameValidator(config: {
  getExisting: () => { name: string }[];
  getEditingName: () => string | undefined;
  getMode: () => 'create' | 'edit' | null;
}): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const name = control.value?.trim().toLowerCase();
    if (!name) return null;
    if (config.getMode() === 'edit' && config.getEditingName()?.toLowerCase() === name) {
      return null;
    }
    const exists = config.getExisting().some(b => b.name.toLowerCase() === name);
    return exists ? { duplicateName: true } : null;
  };
}

export function duplicateHostValidator(config: {
  getExisting: () => { name: string; host: string; port: number | string }[];
  getEditingName: () => string | undefined;
}): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const hostCtrl = group.get('host');
    const portCtrl = group.get('port');
    if (!hostCtrl?.value || !portCtrl?.value) return null;

    const editingName = config.getEditingName();
    const exists = config
      .getExisting()
      .some(
        b =>
          b.name !== editingName &&
          b.host === hostCtrl.value &&
          Number(b.port) === Number(portCtrl.value)
      );

    const hasDup = hostCtrl.hasError('duplicateHost');
    if (exists && !hasDup) {
      hostCtrl.setErrors({ ...hostCtrl.errors, duplicateHost: true });
    } else if (!exists && hasDup) {
      const { duplicateHost: _, ...errors } = hostCtrl.errors || {};
      hostCtrl.setErrors(Object.keys(errors).length ? errors : null);
    }

    return exists ? { duplicateHost: true } : null;
  };
}

export function requiredIfCronEnabled(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const opGroup = control.parent;
    if (!opGroup) return null;
    if (opGroup.get('cronEnabled')?.value && !control.value) return { required: true };
    return null;
  };
}

export function requiredIfWatchEnabled(): ValidatorFn {
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
