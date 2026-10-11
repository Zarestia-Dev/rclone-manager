import { Injectable, inject, DestroyRef } from '@angular/core';
import { AbstractControl, ValidatorFn, FormGroup, FormArray } from '@angular/forms';
import { TranslateService } from '@ngx-translate/core';
import { REMOTE_NAME_REGEX } from '@app/types';
import { Observable, merge } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ValidationMessageResolver,
  arrayValidator,
  integerValidator,
  floatValidator,
  durationValidator,
  sizeSuffixValidator,
  tristateValidator,
  timeValidator,
  spaceSepListValidator,
  bwTimetableValidator,
  fileModeValidator,
  enumValidator,
  urlArrayValidator,
  bandwidthValidator,
  passwordValidator,
  remoteNameValidator,
  passwordMatchValidator,
  uniqueNameValidator,
  forbiddenCharsValidator,
  duplicateNameValidator,
  duplicateHostValidator,
  requiredIfCronEnabled,
  requiredIfWatchEnabled,
} from 'src/app/shared/validators';

@Injectable({
  providedIn: 'root',
})
export class ValidatorRegistryService {
  private readonly validators = new Map<string, ValidatorFn>();
  private readonly translate = inject(TranslateService);

  private readonly resolver: ValidationMessageResolver = (key, params) =>
    this.translate.instant(key, params);

  constructor() {
    this.validators.set('urlList', this.urlArrayValidator());
    this.validators.set('bandwidthFormat', this.bandwidthValidator());
    this.validators.set('password', this.passwordValidator());
  }

  registerValidator(name: string, validator: ValidatorFn): void {
    this.validators.set(name, validator);
  }

  getValidator(name: string): ValidatorFn | null {
    return this.validators.get(name) ?? null;
  }

  arrayValidator(): ValidatorFn {
    return arrayValidator();
  }

  integerValidator(
    defaultValue?: string,
    allowedExamples?: readonly (string | { Value?: unknown })[]
  ): ValidatorFn {
    return integerValidator(defaultValue, allowedExamples, this.resolver);
  }

  floatValidator(
    defaultValue?: string,
    allowedExamples?: readonly (string | { Value?: unknown })[]
  ): ValidatorFn {
    return floatValidator(defaultValue, allowedExamples, this.resolver);
  }

  durationValidator(
    defaultValue?: string,
    allowedExamples?: readonly (string | { Value?: unknown })[]
  ): ValidatorFn {
    return durationValidator(defaultValue, allowedExamples, this.resolver);
  }

  sizeSuffixValidator(
    defaultValue?: string,
    allowedExamples?: readonly (string | { Value?: unknown })[]
  ): ValidatorFn {
    return sizeSuffixValidator(defaultValue, allowedExamples, this.resolver);
  }

  tristateValidator(): ValidatorFn {
    return tristateValidator(this.resolver);
  }

  timeValidator(
    defaultValue?: string,
    allowedExamples?: readonly (string | { Value?: unknown })[]
  ): ValidatorFn {
    return timeValidator(defaultValue, allowedExamples, this.resolver);
  }

  spaceSepListValidator(
    defaultValue?: string,
    allowedExamples?: readonly (string | { Value?: unknown })[]
  ): ValidatorFn {
    return spaceSepListValidator(defaultValue, allowedExamples, this.resolver);
  }

  bwTimetableValidator(
    defaultValue?: string,
    allowedExamples?: readonly (string | { Value?: unknown })[]
  ): ValidatorFn {
    return bwTimetableValidator(defaultValue, allowedExamples, this.resolver);
  }

  fileModeValidator(
    defaultValue?: string,
    allowedExamples?: readonly (string | { Value?: unknown })[]
  ): ValidatorFn {
    return fileModeValidator(defaultValue, allowedExamples, this.resolver);
  }

  enumValidator(allowedValues: unknown[]): ValidatorFn {
    return enumValidator(allowedValues, this.resolver);
  }

  requiredIfCronEnabled(): ValidatorFn {
    return requiredIfCronEnabled();
  }

  requiredIfWatchEnabled(): ValidatorFn {
    return requiredIfWatchEnabled();
  }

  createRemoteNameValidator(
    existingNames: string[],
    allowedPattern: RegExp = REMOTE_NAME_REGEX
  ): ValidatorFn {
    return remoteNameValidator(existingNames, allowedPattern, this.resolver);
  }

  passwordMatchValidator(passwordFieldName: string, confirmFieldName: string): ValidatorFn {
    return passwordMatchValidator(passwordFieldName, confirmFieldName, this.resolver);
  }

  createUniqueNameValidator(config: { existingNames: string[]; typeLabel?: string }): ValidatorFn {
    return uniqueNameValidator(config);
  }

  createForbiddenCharsValidator(forbidden: string[] = ['/', ':']): ValidatorFn {
    return forbiddenCharsValidator(forbidden);
  }

  createDuplicateNameValidator(config: {
    getExisting: () => { name: string }[];
    getEditingName: () => string | undefined;
    getMode: () => 'create' | 'edit' | null;
  }): ValidatorFn {
    return duplicateNameValidator(config);
  }

  createDuplicateHostValidator(config: {
    getExisting: () => { name: string; host: string; port: number | string }[];
    getEditingName: () => string | undefined;
  }): ValidatorFn {
    return duplicateHostValidator(config);
  }

  setupOperationValidation(opGroup: FormGroup, destroyRef: DestroyRef): void {
    const autoStartCtrl = opGroup.get('autoStart');
    const cronEnabledCtrl = opGroup.get('cronEnabled');
    const cronExpressionCtrl = opGroup.get('cronExpression');
    const watchEnabledCtrl = opGroup.get('watchEnabled');
    const watchDelayCtrl = opGroup.get('watchDelay');
    const sourceCtrl = opGroup.get('source');
    const destCtrl = opGroup.get('dest');

    if (cronExpressionCtrl) {
      cronExpressionCtrl.setValidators(this.requiredIfCronEnabled());
    }
    if (watchDelayCtrl) {
      watchDelayCtrl.setValidators(this.requiredIfWatchEnabled());
    }

    const updatePathsValidity = (): void => {
      if (sourceCtrl instanceof FormArray) {
        sourceCtrl.controls.forEach((c: AbstractControl) =>
          c.get('path')?.updateValueAndValidity()
        );
      } else if (sourceCtrl instanceof FormGroup) {
        sourceCtrl.get('path')?.updateValueAndValidity();
      }
      if (destCtrl instanceof FormGroup) {
        destCtrl.get('path')?.updateValueAndValidity();
      }
    };

    const triggers: Observable<unknown>[] = [];
    if (autoStartCtrl) triggers.push(autoStartCtrl.valueChanges);
    if (cronEnabledCtrl) triggers.push(cronEnabledCtrl.valueChanges);
    if (watchEnabledCtrl) triggers.push(watchEnabledCtrl.valueChanges);

    if (triggers.length > 0) {
      merge(...triggers)
        .pipe(takeUntilDestroyed(destroyRef))
        .subscribe(() => {
          cronExpressionCtrl?.updateValueAndValidity();
          watchDelayCtrl?.updateValueAndValidity();
          updatePathsValidity();
        });
    }
  }

  private urlArrayValidator(): ValidatorFn {
    return urlArrayValidator(this.resolver);
  }

  private bandwidthValidator(): ValidatorFn {
    return bandwidthValidator(this.resolver);
  }

  private passwordValidator(): ValidatorFn {
    return passwordValidator(this.resolver);
  }
}
