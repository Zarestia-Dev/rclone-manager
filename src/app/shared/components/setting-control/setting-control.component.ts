import { Component, Input, forwardRef, OnDestroy, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AbstractControl,
  ControlValueAccessor,
  FormArray,
  FormControl,
  FormsModule,
  NG_VALUE_ACCESSOR,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators,
} from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';

import { RcConfigOption } from '@app/types';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-setting-control',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatIconModule,
    MatButtonModule,
  ],
  templateUrl: './setting-control.component.html',
  styleUrls: ['./setting-control.component.scss'],
  // This provider hooks our component into Angular's form system
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SettingControlComponent),
      multi: true,
    },
  ],
})
export class SettingControlComponent implements ControlValueAccessor, OnDestroy {
  // The 'option' input is now the single source of truth for what to render
  private _option!: RcConfigOption;
  @Input()
  get option(): RcConfigOption {
    return this._option;
  }
  set option(val: RcConfigOption) {
    this._option = val;
    this.createInternalControl();
  }
  @Output() valueCommit = new EventEmitter<void>();

  // This is the internal control that the template will use
  public control!: AbstractControl;

  private onChange: (value: any) => void = () => {
    /* empty */
  };
  private onTouched: () => void = () => {
    /* empty */
  };
  private destroyed$ = new Subject<void>();

  // --- ControlValueAccessor Implementation ---

  // Writes a new value from the parent form into our component
  writeValue(value: any): void {
    if (this.control) {
      this.control.setValue(value, { emitEvent: false });
    }
  }

  commitValue(): void {
    this.valueCommit.emit();
  }

  // Registers a callback function that should be called when the control's value changes in the UI
  registerOnChange(fn: any): void {
    this.onChange = fn;
  }

  // Registers a callback function that should be called when the control receives a blur event
  registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }

  // This function is called by the forms API when the control status changes to or from 'DISABLED'
  setDisabledState?(isDisabled: boolean): void {
    if (isDisabled) {
      this.control?.disable({ emitEvent: false });
    } else {
      this.control?.enable({ emitEvent: false });
    }
  }

  // --- Internal Logic ---

  private createInternalControl(): void {
    this.destroyed$.next(); // Clean up previous subscription if any

    if (!this.option) return;

    const validators = this.getRCloneOptionValidators(this.option);

    // Create either a FormArray or a FormControl based on the option type
    if (this.option.Type === 'stringArray' || this.option.Type === 'CommaSepList') {
      const arrayValues = (Array.isArray(this.option.Value) ? this.option.Value : []).filter(
        v => v
      );
      this.control = new FormArray(
        arrayValues.map(val => new FormControl(val)),
        validators
      );
    } else {
      let initialValue = this.option.Value;
      if (this.option.Type === 'bool') {
        initialValue = initialValue === true || initialValue === 'true';
      }
      this.control = new FormControl(initialValue, validators);
    }

    // Subscribe to changes in the internal control and propagate them to the parent form
    this.control.valueChanges.pipe(takeUntil(this.destroyed$)).subscribe(value => {
      this.onChange(value);
      this.onTouched();
    });
  }

  getRCloneOptionValidators(option: RcConfigOption): ValidatorFn[] {
    const validators: ValidatorFn[] = [];

    if (option.Required) {
      validators.push(Validators.required);
    }

    switch (option.Type) {
      case 'stringArray':
      case 'CommaSepList':
        validators.push(this.arrayValidator);
        break;
      case 'int':
      case 'int64':
      case 'uint32':
        validators.push(this.integerValidator(option.DefaultStr));
        break;
      case 'float64':
        validators.push(this.floatValidator(option.DefaultStr));
        break;
      case 'Duration':
        validators.push(this.durationValidator(option.DefaultStr));
        break;
      case 'SizeSuffix':
        validators.push(this.sizeSuffixValidator(option.DefaultStr));
        break;
      case 'BwTimetable':
        validators.push(this.bwTimetableValidator(option.DefaultStr));
        break;
      case 'FileMode':
        validators.push(this.fileModeValidator(option.DefaultStr));
        break;
      case 'Time':
        validators.push(this.timeValidator(option.DefaultStr));
        break;
      case 'SpaceSepList':
        validators.push(this.spaceSepListValidator(option.DefaultStr));
        break;
      case 'Bits':
        validators.push(this.bitsValidator(option.DefaultStr));
        break;
      case 'Tristate': // ADD THIS CASE
        validators.push(this.tristateValidator());
        break;
      case 'LogLevel':
      case 'CacheMode':
        if (option.Examples) {
          validators.push(this.enumValidator(option.Examples.map(e => e.Value)));
        }
        break;
    }

    if (option.Exclusive && option.Examples) {
      validators.push(this.enumValidator(option.Examples.map(e => e.Value)));
    }

    return validators;
  }

  private integerValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!/^-?\d+$/.test(value)) {
        return { integer: { value, message: 'Must be a valid integer' } };
      }
      return isNaN(parseInt(value, 10)) ? { integer: { value, message: 'Invalid integer' } } : null;
    };
  }

  private floatValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!/^-?\d+(\.\d+)?$/.test(value)) {
        return { float: { value, message: 'Must be a valid decimal number' } };
      }
      return isNaN(parseFloat(value)) ? { float: { value, message: 'Invalid float' } } : null;
    };
  }

  private durationValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      const durationPattern = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;
      return !durationPattern.test(value)
        ? { duration: { value, message: 'Invalid duration format. Use: 1h30m45s, 5m, 1h' } }
        : null;
    };
  }

  private tristateValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const allowedValues = [null, true, false];
      if (allowedValues.includes(control.value)) {
        return null; // Value is valid
      }
      return {
        tristate: { value: control.value, message: 'Value must be true, false, or unset.' },
      };
    };
  }

  private bitsValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }
      if (value.length > 0 && !/^[a-zA-Z0-9_-]+(,\s*[a-zA-Z0-9_-]+)*$/.test(value)) {
        return {
          bits: {
            value,
            message: 'Must be comma-separated flags (alphanumeric, underscore, and hyphen)',
          },
        };
      }

      return null;
    };
  }

  private timeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }

      // ISO 8601 datetime format check
      const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)?$/;

      if (!isoPattern.test(value)) {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return {
            time: {
              value,
              message: 'Invalid datetime format. Use ISO 8601: YYYY-MM-DDTHH:mm:ssZ',
            },
          };
        }
      }

      return null;
    };
  }

  private spaceSepListValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }
      if (value.length > 0 && !/\S/.test(value)) {
        return {
          spaceSepList: {
            value,
            message: 'List cannot contain only whitespace',
          },
        };
      }

      return null;
    };
  }

  private sizeSuffixValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      const sizePattern = /^\d+(\.\d+)?(b|B|k|K|Ki|M|Mi|G|Gi|T|Ti|P|Pi|E|Ei)?$/;
      return !sizePattern.test(value)
        ? { sizeSuffix: { value, message: 'Invalid size format. Use: 100Ki, 16Mi, 1Gi, 2.5G' } }
        : null;
    };
  }

  // Validator for fields that are expected to be arrays (stringArray / CommaSepList)
  // The remote-config flow sometimes represents these as JSON strings; accept either
  // an actual array or a JSON string that parses to an array.
  private arrayValidator(control: AbstractControl): ValidationErrors | null {
    if (!control.value) return null;
    try {
      const arr = Array.isArray(control.value) ? control.value : JSON.parse(control.value);
      if (!Array.isArray(arr)) {
        return { invalidArray: true };
      }
      return null;
    } catch {
      return { invalidArray: true };
    }
  }

  private bwTimetableValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      const simpleBandwidth = /^\d+(\.\d+)?(B|K|M|G|T|P)?$/i;
      const hasTimetable = value.includes(',') || value.includes('-') || value.includes(':');
      return !simpleBandwidth.test(value) && !hasTimetable && value.length > 0
        ? { bwTimetable: { value, message: 'Invalid bandwidth format' } }
        : null;
    };
  }

  private fileModeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      return !/^[0-7]{3,4}$/.test(value)
        ? {
            fileMode: {
              value,
              message: 'Must be octal format (3-4 digits, each 0-7). Example: 755',
            },
          }
        : null;
    };
  }

  private enumValidator(allowedValues: string[]): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim().toLowerCase();
      const allowed = allowedValues.map(v => v.toLowerCase());
      return !allowed.includes(value)
        ? { enum: { value, allowedValues, message: `Must be one of: ${allowedValues.join(', ')}` } }
        : null;
    };
  }

  get formArrayControls(): AbstractControl[] {
    return this.control instanceof FormArray ? this.control.controls : [];
  }

  addArrayItem(): void {
    if (this.control instanceof FormArray) {
      this.control.push(new FormControl(''));
    }
  }

  removeArrayItem(index: number): void {
    if (this.control instanceof FormArray) {
      this.control.removeAt(index);
      this.commitValue();
    }
  }

  // This logic is now self-contained within the component
  getControlError(): string | null {
    if (!this.control || !this.control.errors) return null;
    const errors = this.control.errors;
    return (
      errors['required']?.message ||
      errors['integer']?.message ||
      errors['float']?.message ||
      errors['duration']?.message ||
      errors['sizeSuffix']?.message ||
      errors['bwTimetable']?.message ||
      errors['fileMode']?.message ||
      errors['enum']?.message ||
      'Invalid value'
    );
  }

  ngOnDestroy(): void {
    this.destroyed$.next();
    this.destroyed$.complete();
  }
}
