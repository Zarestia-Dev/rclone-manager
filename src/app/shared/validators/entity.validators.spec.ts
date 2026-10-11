import { FormControl, FormGroup } from '@angular/forms';
import { describe, it, expect } from 'vitest';
import {
  remoteNameValidator,
  passwordValidator,
  passwordMatchValidator,
  uniqueNameValidator,
  forbiddenCharsValidator,
  duplicateNameValidator,
  duplicateHostValidator,
  requiredIfCronEnabled,
  requiredIfWatchEnabled,
} from './entity.validators';

describe('entity.validators', () => {
  describe('remoteNameValidator', () => {
    it('should validate valid remote names', () => {
      const validator = remoteNameValidator(['existing']);
      expect(validator(new FormControl('my-remote'))).toBeNull();
      expect(validator(new FormControl('gdrive123'))).toBeNull();
    });

    it('should reject names that are already taken', () => {
      const validator = remoteNameValidator(['existing']);
      expect(validator(new FormControl('existing'))).toEqual({
        nameTaken: { message: 'validators.remoteName.nameTaken' },
      });
    });

    it('should reject invalid characters and prefixes', () => {
      const validator = remoteNameValidator([]);
      expect(validator(new FormControl('-invalid'))).not.toBeNull();
      expect(validator(new FormControl('invalid '))?.['invalidEnd']).toBeDefined();
    });
  });

  describe('passwordValidator', () => {
    it('should accept valid password', () => {
      const validator = passwordValidator();
      expect(validator(new FormControl('secret123'))).toBeNull();
    });

    it('should reject short passwords and invalid quotes', () => {
      const validator = passwordValidator();
      expect(validator(new FormControl('ab'))).not.toBeNull();
      expect(validator(new FormControl('pass"word'))).not.toBeNull();
    });
  });

  describe('passwordMatchValidator', () => {
    it('should validate password match on form group', () => {
      const validator = passwordMatchValidator('pwd', 'confirm');
      const group = new FormGroup({
        pwd: new FormControl('secret'),
        confirm: new FormControl('secret'),
      });
      expect(validator(group)).toBeNull();

      group.get('confirm')?.setValue('different');
      expect(validator(group)).toEqual({
        passwordMismatch: { message: 'validators.passwordMismatch' },
      });
    });
  });

  describe('uniqueNameValidator and forbiddenCharsValidator', () => {
    it('should validate unique name', () => {
      const validator = uniqueNameValidator({ existingNames: ['box', 'drive'] });
      expect(validator(new FormControl('s3'))).toBeNull();
      expect(validator(new FormControl('box'))).toEqual({ alreadyExists: true });
    });

    it('should validate forbidden chars', () => {
      const validator = forbiddenCharsValidator(['/', ':']);
      expect(validator(new FormControl('clean-name'))).toBeNull();
      expect(validator(new FormControl('bad/name'))).toEqual({ forbiddenChars: true });
      expect(validator(new FormControl('bad:name'))).toEqual({ forbiddenChars: true });
    });
  });

  describe('duplicateNameValidator and duplicateHostValidator', () => {
    it('should validate duplicate name in create vs edit modes', () => {
      let mode: 'create' | 'edit' = 'create';
      const validator = duplicateNameValidator({
        getExisting: () => [{ name: 'backend1' }],
        getEditingName: () => 'backend1',
        getMode: () => mode,
      });

      expect(validator(new FormControl('backend2'))).toBeNull();
      expect(validator(new FormControl('backend1'))).toEqual({ duplicateName: true });

      mode = 'edit';
      expect(validator(new FormControl('backend1'))).toBeNull();
    });

    it('should validate duplicate host on form group', () => {
      const validator = duplicateHostValidator({
        getExisting: () => [{ name: 'srv1', host: 'localhost', port: 5572 }],
        getEditingName: () => 'srv2',
      });

      const group = new FormGroup({
        host: new FormControl('localhost'),
        port: new FormControl(5572),
      });

      expect(validator(group)).toEqual({ duplicateHost: true });
      expect(group.get('host')?.hasError('duplicateHost')).toBe(true);

      group.get('port')?.setValue(5573);
      expect(validator(group)).toBeNull();
      expect(group.get('host')?.hasError('duplicateHost')).toBe(false);
    });
  });

  describe('requiredIfCronEnabled and requiredIfWatchEnabled', () => {
    it('should require value only when cronEnabled is true', () => {
      const cronEnabled = new FormControl(false);
      const cronExpression = new FormControl('');
      new FormGroup({
        cronEnabled,
        cronExpression,
      });
      const validator = requiredIfCronEnabled();

      expect(validator(cronExpression)).toBeNull();

      cronEnabled.setValue(true);
      expect(validator(cronExpression)).toEqual({ required: true });

      cronExpression.setValue('0 * * * *');
      expect(validator(cronExpression)).toBeNull();
    });

    it('should require positive number only when watchEnabled is true', () => {
      const watchEnabled = new FormControl(false);
      const watchDelay = new FormControl('');
      new FormGroup({
        watchEnabled,
        watchDelay,
      });
      const validator = requiredIfWatchEnabled();

      expect(validator(watchDelay)).toBeNull();

      watchEnabled.setValue(true);
      expect(validator(watchDelay)).toEqual({ required: true });

      watchDelay.setValue('0');
      expect(validator(watchDelay)).toEqual({ min: { min: 1, actual: '0' } });

      watchDelay.setValue('10');
      expect(validator(watchDelay)).toBeNull();
    });
  });
});
