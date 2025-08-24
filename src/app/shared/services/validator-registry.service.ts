import { Injectable, inject } from '@angular/core';
import { AbstractControl, ValidatorFn } from '@angular/forms';
import { ValidatorsService } from './validators.service';

@Injectable({
  providedIn: 'root',
})
export class ValidatorRegistryService {
  private validators = new Map<string, ValidatorFn>();
  private validatorsService = inject(ValidatorsService);

  constructor() {
    this.registerBuiltinValidators();
  }

  /**
   * Register built-in validators that can be referenced by name from backend metadata
   */
  private registerBuiltinValidators(): void {
    // Cross-platform path validator
    this.registerValidator(
      'crossPlatformPath',
      this.validatorsService.crossPlatformPathValidator()
    );

    // JSON validator
    this.registerValidator('json', this.validatorsService.jsonValidator());

    // URL validator
    this.registerValidator('url', this.validatorsService.urlValidator());

    // Port validator
    this.registerValidator('port', this.validatorsService.portValidator());

    // Port range validator
    this.registerValidator('portRange', this.validatorsService.portRangeValidator(1024, 65535));

    // URL array validator (for arrays of URLs)
    this.registerValidator('urlList', this.validatorsService.urlArrayValidator());

    // Bandwidth format validator
    this.registerValidator('bandwidthFormat', this.validatorsService.bandwidthValidator());

    // Numeric range validators
    this.registerValidator('trayItemsRange', this.validatorsService.numericRangeValidator(1, 40));
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

  /**
   * Create a validator from metadata (supports both regex and named validators)
   */
  createValidatorFromMetadata(metadata: {
    validation_type?: string;
    validation_pattern?: string;
    validation_message?: string;
    value_type?: string;
  }): ValidatorFn | null {
    // If validation_type starts with "frontend:", use the named validator
    if (metadata.validation_type?.startsWith('frontend:')) {
      const validatorName = metadata.validation_type.substring('frontend:'.length);
      const validator = this.getValidator(validatorName);

      if (!validator) {
        console.warn(`Frontend validator '${validatorName}' not found in registry`);
        return null;
      }

      return validator;
    }

    // If validation_type is "regex" or we have a validation_pattern, use regex
    if (metadata.validation_type === 'regex' || metadata.validation_pattern) {
      const pattern = metadata.validation_pattern;
      const message = metadata.validation_message || 'Invalid format';

      if (pattern) {
        return this.validatorsService.regexValidator(pattern, message);
      }
    }

    // For path types, always apply cross-platform path validation
    if (metadata.value_type === 'path') {
      return this.getValidator('crossPlatformPath');
    }

    return null;
  }

  /**
   * Create a remote name validator with existing names and regex pattern
   */
  createRemoteNameValidator(existingNames: string[], allowedPattern?: RegExp): ValidatorFn {
    return this.validatorsService.remoteNameValidator(existingNames, allowedPattern);
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
