import { Injectable, inject } from '@angular/core';
import { ValidatorFn } from '@angular/forms';
import { TranslateService } from '@ngx-translate/core';
import { REMOTE_NAME_REGEX } from '@app/types';

import {
  ValidationMessageResolver,
  integerValidator,
  floatValidator,
  durationValidator,
  sizeSuffixValidator,
  tristateValidator,
  timeValidator,
  bwTimetableValidator,
  fileModeValidator,
  urlArrayValidator,
  bandwidthValidator,
  remoteNameValidator,
  passwordMatchValidator,
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
    this.validators.set('urlList', urlArrayValidator(this.resolver));
    this.validators.set('bandwidthFormat', bandwidthValidator(this.resolver));
  }

  getValidator(name: string): ValidatorFn | null {
    return this.validators.get(name) ?? null;
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

  createRemoteNameValidator(
    existingNames: string[],
    allowedPattern: RegExp = REMOTE_NAME_REGEX
  ): ValidatorFn {
    return remoteNameValidator(existingNames, allowedPattern, this.resolver);
  }

  passwordMatchValidator(passwordFieldName: string, confirmFieldName: string): ValidatorFn {
    return passwordMatchValidator(passwordFieldName, confirmFieldName, this.resolver);
  }
}
