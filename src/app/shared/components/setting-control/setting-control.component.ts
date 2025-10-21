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
import { LinebreaksPipe } from '../../pipes/linebreaks.pipe';

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
    LinebreaksPipe,
  ],
  templateUrl: './setting-control.component.html',
  styleUrls: ['./setting-control.component.scss'],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SettingControlComponent),
      multi: true,
    },
  ],
})
export class SettingControlComponent implements ControlValueAccessor, OnDestroy {
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

  public control!: AbstractControl;

  public encodingFlags = [
    'Slash',
    'BackSlash',
    'Del',
    'Ctl',
    'InvalidUtf8',
    'Dot',
    'LeftSpace',
    'RightSpace',
    'LeftCrLfHtVt',
    'RightCrLfHtVt',
    'LeftPeriod',
    'LeftTilde',
    'LtGt',
    'DoubleQuote',
    'SingleQuote',
    'BackQuote',
    'Dollar',
    'Colon',
    'Question',
    'Asterisk',
    'Pipe',
    'Hash',
    'Percent',
    'CrLf',
    'SquareBracket',
    'Semicolon',
    'Exclamation',
  ].sort();

  public bitsFlags = ['date', 'time', 'microseconds', 'longfile', 'shortfile', 'pid'].sort();

  private onChange: (value: any) => void = () => {
    /* empty */
  };
  private onTouched: () => void = () => {
    /* empty */
  };
  private destroyed$ = new Subject<void>();

  writeValue(value: any): void {
    if (this.control) {
      let internalValue = value;
      if (this.option.Type === 'Encoding' || this.option.Type === 'Bits') {
        if (typeof value === 'string' && value) {
          internalValue = value.split(',');
        } else if (!Array.isArray(value)) {
          internalValue = [];
        }
      }
      this.control.setValue(internalValue, { emitEvent: false });
    }
  }

  commitValue(): void {
    this.valueCommit.emit();
  }

  registerOnChange(fn: any): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }

  setDisabledState?(isDisabled: boolean): void {
    if (isDisabled) {
      this.control?.disable({ emitEvent: false });
    } else {
      this.control?.enable({ emitEvent: false });
    }
  }

  private createInternalControl(): void {
    this.destroyed$.next();

    if (!this.option) return;

    const validators = this.getRCloneOptionValidators(this.option);

    if (this.option.Type === 'stringArray' || this.option.Type === 'CommaSepList') {
      const arrayValues = (Array.isArray(this.option.Value) ? this.option.Value : []).filter(
        v => v
      );
      this.control = new FormArray(
        arrayValues.map(val => new FormControl(val)),
        validators
      );
    } else {
      let initialValue: any = this.option.Value;
      if (this.option.Type === 'bool') {
        initialValue = initialValue === true || initialValue === 'true';
      } else if (this.option.Type === 'Encoding' || this.option.Type === 'Bits') {
        const strValue = (this.option.Value || this.option.DefaultStr || '').toString();
        initialValue = strValue ? strValue.split(',').filter(v => v) : [];
      }
      this.control = new FormControl(initialValue, validators);
    }

    this.control.valueChanges.pipe(takeUntil(this.destroyed$)).subscribe(value => {
      let outputValue = value;
      if (this.option.Type === 'Encoding' || this.option.Type === 'Bits') {
        outputValue = Array.isArray(value) ? value.join(',') : value;
      }
      this.onChange(outputValue);
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
      case 'Encoding':
        validators.push(this.arrayValidator);
        break;
      case 'Tristate':
        validators.push(this.tristateValidator());
        break;
    }

    const multiSelectTypes = ['DumpFlags', 'Encoding', 'Bits', 'stringArray', 'CommaSepList'];
    if (option.Examples && !multiSelectTypes.includes(option.Type)) {
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

  private timeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }
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

  private arrayValidator(control: AbstractControl): ValidationErrors | null {
    if (!control.value) return null;
    if (Array.isArray(control.value)) {
      return null;
    }
    try {
      const arr = JSON.parse(control.value);
      if (!Array.isArray(arr)) {
        return { invalidArray: true };
      }
      return null;
    } catch {
      // It could be a simple string if not an array, so don't fail here if it's not JSON
      if (typeof control.value === 'string') return null;
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
