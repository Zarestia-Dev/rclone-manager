import {
  Component,
  Input,
  forwardRef,
  OnDestroy,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  ViewChild,
} from '@angular/core';
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
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { RcConfigOption } from '@app/types';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { LineBreaksPipe } from '../../pipes/linebreaks.pipe';

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
    ScrollingModule,
    LineBreaksPipe,
  ],
  templateUrl: './setting-control.component.html',
  styleUrls: ['./setting-control.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SettingControlComponent),
      multi: true,
    },
  ],
})
export class SettingControlComponent implements ControlValueAccessor, OnDestroy {
  @ViewChild(CdkVirtualScrollViewport) viewport!: CdkVirtualScrollViewport;

  private _option!: RcConfigOption;
  private _optionName = '';
  private _optionType = '';

  @Input()
  get option(): RcConfigOption {
    return this._option;
  }
  set option(val: RcConfigOption) {
    if (!this._option || val.Name !== this._optionName || val.Type !== this._optionType) {
      this._option = val;
      this._optionName = val.Name;
      this._optionType = val.Type;
      this.createInternalControl();
    } else {
      this._option = val;
    }
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
  private validatorCache = new Map<string, ValidatorFn[]>();
  private regexCache = new Map<string, RegExp>();

  writeValue(value: any): void {
    if (!this.control) return;

    let internalValue = value;

    // Handle numeric types - convert string numbers to actual numbers
    if (
      this.option.Type === 'int' ||
      this.option.Type === 'int64' ||
      this.option.Type === 'uint32'
    ) {
      if (typeof value === 'string' && value.trim() !== '') {
        const numValue = parseInt(value, 10);
        internalValue = isNaN(numValue) ? value : numValue;
      }
    } else if (this.option.Type === 'float64') {
      if (typeof value === 'string' && value.trim() !== '') {
        const numValue = parseFloat(value);
        internalValue = isNaN(numValue) ? value : numValue;
      }
    } else if (this.option.Type === 'CommaSepList') {
      if (typeof value === 'string' && value) {
        internalValue = value
          .split(',')
          .map(v => v.trim())
          .filter(v => v);
      } else if (!Array.isArray(value)) {
        internalValue = [];
      }
    } else if (this.option.Type === 'Encoding' || this.option.Type === 'Bits') {
      if (typeof value === 'string' && value) {
        internalValue = value.split(',');
      } else if (!Array.isArray(value)) {
        internalValue = [];
      }
    }

    if (this.control instanceof FormArray) {
      const arrayValue = Array.isArray(internalValue) ? internalValue : [];
      const formArray = this.control as FormArray;

      if (formArray.length !== arrayValue.length) {
        formArray.clear({ emitEvent: false });
        arrayValue.forEach(val => {
          formArray.push(new FormControl(val), { emitEvent: false });
        });
      } else {
        arrayValue.forEach((val, i) => {
          formArray.at(i).setValue(val, { emitEvent: false });
        });
      }
    } else {
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

  isValueChanged(): boolean {
    if (!this.option || !this.control) return false;

    const currentValue = this.control.value;
    const defaultValue = this.option.Default;

    return !this.areValuesEqual(currentValue, defaultValue, this.option.Type);
  }
  /**
   * Reset control value to default
   */
  resetToDefault(): void {
    if (!this.option || !this.control) return;

    let defaultToSet = this.option.Default;

    // Special handling for array types
    if (this.option.Type === 'stringArray' || this.option.Type === 'CommaSepList') {
      // Ensure we have a proper array (handle null/undefined defaults)
      defaultToSet = Array.isArray(this.option.Default) ? [...this.option.Default] : [];

      // For FormArray controls, we need to rebuild the form array
      if (this.control instanceof FormArray) {
        const fa = this.control as FormArray;
        fa.clear({ emitEvent: false });
        defaultToSet.forEach((val: any) => {
          fa.push(new FormControl(val), { emitEvent: false });
        });
      } else {
        this.control.setValue(defaultToSet, { emitEvent: false });
      }
    } else {
      this.control.setValue(defaultToSet, { emitEvent: false });
    }

    this.commitValue();
  }
  /**
   * Compare if a value equals the default value
   * Enhanced version of your existing method
   */
  private areValuesEqual(currentValue: any, defaultValue: any, type: string): boolean {
    // Handle array types
    if (
      type === 'stringArray' ||
      type === 'CommaSepList' ||
      type === 'Encoding' ||
      type === 'Bits'
    ) {
      return this.areArraysEqual(currentValue, defaultValue);
    }

    // Handle null/undefined
    if (currentValue === null || currentValue === undefined) {
      return defaultValue === null || defaultValue === undefined;
    }

    // Handle arrays (fallback)
    if (Array.isArray(currentValue)) {
      if (!Array.isArray(defaultValue)) return false;
      return this.areArraysEqual(currentValue, defaultValue);
    }

    // Handle booleans
    if (typeof currentValue === 'boolean' || typeof defaultValue === 'boolean') {
      const currentBool = currentValue === true || currentValue === 'true';
      const defaultBool = defaultValue === true || defaultValue === 'true';
      return currentBool === defaultBool;
    }

    // Handle numbers
    if (typeof currentValue === 'number' || typeof defaultValue === 'number') {
      const currentNum = Number(currentValue);
      const defaultNum = Number(defaultValue);
      return currentNum === defaultNum && !isNaN(currentNum) && !isNaN(defaultNum);
    }

    // Handle strings
    if (typeof currentValue === 'string' && typeof defaultValue === 'string') {
      return currentValue.trim() === defaultValue.trim();
    }

    // Default comparison
    return currentValue === defaultValue;
  }

  private areArraysEqual(arr1: any[], arr2: any[]): boolean {
    // Handle null/undefined arrays
    if (!arr1 && !arr2) return true;
    if (!arr1 || !arr2) return false;

    // Convert to arrays if they're not already
    const array1 = Array.isArray(arr1) ? arr1 : [arr1];
    const array2 = Array.isArray(arr2) ? arr2 : [arr2];

    // Check length
    if (array1.length !== array2.length) return false;

    // Check each element
    return array1.every((item, index) => {
      const item1 = item?.toString().trim();
      const item2 = array2[index]?.toString().trim();
      return item1 === item2;
    });
  }

  private createInternalControl(): void {
    this.destroyed$.next();

    if (!this.option) return;

    const validators = this.getRCloneOptionValidators(this.option);

    if (this.option.Type === 'stringArray' || this.option.Type === 'CommaSepList') {
      let initialValues: string[] = [];

      if (this.option.Type === 'CommaSepList') {
        const valueStr = this.option.ValueStr || this.option.DefaultStr || '';
        initialValues = valueStr
          ? valueStr
              .split(',')
              .map(v => v.trim())
              .filter(v => v)
          : [];
      } else {
        initialValues = (Array.isArray(this.option.Value) ? this.option.Value : []).filter(v => v);
      }

      const controls = initialValues.map(val => new FormControl(val));
      this.control = new FormArray(controls, validators);
    } else {
      let initialValue: any = this.option.Value;
      if (this.option.Type === 'bool') {
        initialValue = initialValue === true || initialValue === 'true';
      } else if (this.option.Type === 'Encoding' || this.option.Type === 'Bits') {
        const strValue = (this.option.Value || this.option.DefaultStr || '').toString();
        initialValue = strValue ? strValue.split(',').filter((v: any) => v) : [];
      }
      this.control = new FormControl(initialValue, validators);
    }

    this.control.valueChanges.pipe(takeUntil(this.destroyed$)).subscribe(value => {
      let outputValue = value;
      if (
        this.option.Type === 'int' ||
        this.option.Type === 'int64' ||
        this.option.Type === 'uint32'
      ) {
        if (typeof value === 'string' && value.trim() !== '') {
          const numValue = parseInt(value, 10);
          outputValue = isNaN(numValue) ? value : numValue;
        }
      } else if (this.option.Type === 'float64') {
        if (typeof value === 'string' && value.trim() !== '') {
          const numValue = parseFloat(value);
          outputValue = isNaN(numValue) ? value : numValue;
        }
      } else if (this.option.Type === 'Encoding' || this.option.Type === 'Bits') {
        outputValue = Array.isArray(value) ? value.join(',') : value;
      } else if (this.option.Type === 'CommaSepList') {
        outputValue = Array.isArray(value) ? value.join(',') : value;
      }
      this.onChange(outputValue);
      this.onTouched();
    });
  }

  getRCloneOptionValidators(option: RcConfigOption): ValidatorFn[] {
    const cacheKey = `${option.Name}:${option.Type}:${option.Required}`;

    if (this.validatorCache.has(cacheKey)) {
      const cached = this.validatorCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

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

    this.validatorCache.set(cacheKey, validators);
    return validators;
  }

  private getCachedRegex(pattern: string): RegExp {
    const existing = this.regexCache.get(pattern);
    if (existing) {
      return existing;
    }
    const compiled = new RegExp(pattern);
    this.regexCache.set(pattern, compiled);
    return compiled;
  }

  private integerValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!this.getCachedRegex('^-?\\d+$').test(value)) {
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
      if (!this.getCachedRegex('^-?\\d+(\\.\\d+)?$').test(value)) {
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
      if (!this.getCachedRegex('^(\\d+(\\.\\d+)?(ns|us|µs|ms|s|m|h))+$').test(value)) {
        return { duration: { value, message: 'Invalid duration format. Use: 1h30m45s, 5m, 1h' } };
      }
      return null;
    };
  }

  private tristateValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const allowedValues = [null, true, false];
      if (allowedValues.includes(control.value)) return null;
      return {
        tristate: { value: control.value, message: 'Value must be true, false, or unset.' },
      };
    };
  }

  private timeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (
        !this.getCachedRegex(
          '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?([+-]\\d{2}:\\d{2}|Z)?$'
        ).test(value)
      ) {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return {
            time: { value, message: 'Invalid datetime format. Use ISO 8601: YYYY-MM-DDTHH:mm:ssZ' },
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
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (value.length > 0 && !/\S/.test(value)) {
        return { spaceSepList: { value, message: 'List cannot contain only whitespace' } };
      }
      return null;
    };
  }

  private sizeSuffixValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (
        !this.getCachedRegex('^\\d+(\\.\\d+)?(b|B|k|K|Ki|M|Mi|G|Gi|T|Ti|P|Pi|E|Ei)?$').test(value)
      ) {
        return {
          sizeSuffix: { value, message: 'Invalid size format. Use: 100Ki, 16Mi, 1Gi, 2.5G' },
        };
      }
      return null;
    };
  }

  private arrayValidator(control: AbstractControl): ValidationErrors | null {
    if (!control.value) return null;
    if (Array.isArray(control.value)) return null;
    try {
      const arr = JSON.parse(control.value);
      return Array.isArray(arr) ? null : { invalidArray: true };
    } catch {
      return typeof control.value === 'string' ? null : { invalidArray: true };
    }
  }

  private bwTimetableValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      const hasTimetable = value.includes(',') || value.includes('-') || value.includes(':');
      if (
        !this.getCachedRegex('^\\d+(\\.\\d+)?(B|K|M|G|T|P)?$').test(value) &&
        !hasTimetable &&
        value.length > 0
      ) {
        return { bwTimetable: { value, message: 'Invalid bandwidth format' } };
      }
      return null;
    };
  }

  private fileModeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!this.getCachedRegex('^[0-7]{3,4}$').test(value)) {
        return {
          fileMode: { value, message: 'Must be octal format (3-4 digits, each 0-7). Example: 755' },
        };
      }
      return null;
    };
  }

  private enumValidator(allowedValues: string[]): ValidatorFn {
    const lowerValues = allowedValues.map(v => v.toLowerCase());
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim().toLowerCase();
      if (!lowerValues.includes(value)) {
        return {
          enum: { value, allowedValues, message: `Must be one of: ${allowedValues.join(', ')}` },
        };
      }
      return null;
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
    this.validatorCache.clear();
    this.regexCache.clear();
  }
}
