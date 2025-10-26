import {
  Component,
  Input,
  forwardRef,
  OnDestroy,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  inject,
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
  ValidatorFn,
  Validators,
} from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { RcConfigOption } from '@app/types';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { LineBreaksPipe } from '../../pipes/linebreaks.pipe';
import { RcloneValueMapperService } from '../../services/rclone-value-mapper.service';
import { ValidatorRegistryService } from '../../services/validator-registry.service';

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
  private valueMapper = inject(RcloneValueMapperService);
  private validatorRegistry = inject(ValidatorRegistryService);
  /** Caller-provided per-option overrides. Parent components may bind to this Input to change
   * how specific options are presented (for example override DefaultStr for certain options).
   */
  @Input() optionOverrides: Record<string, Partial<RcConfigOption>> = {};

  /** Built-in default overrides for specific option names. These are merged with
   * any caller-provided overrides (caller overrides take precedence).
   */
  private defaultOptionOverrides: Record<string, Partial<RcConfigOption>> = {
    min_age: { DefaultStr: '0s', Default: 0 },
    max_age: { DefaultStr: '0s', Default: 0 },
  };

  private _option!: RcConfigOption;
  public uiDefaultValue: any;

  @Input()
  get option(): RcConfigOption {
    return this._option;
  }
  set option(val: RcConfigOption) {
    // Merge built-in and caller-provided overrides for this option
    const builtIn = this.defaultOptionOverrides[val.Name] || {};
    const caller = this.optionOverrides[val.Name] || {};
    this._option = { ...val, ...builtIn, ...caller } as RcConfigOption;
    this.uiDefaultValue = this.calculateDefaultValue(this._option);
    this.createControl();
  }

  @Input() selectedProvider?: string; // For remote-specific settings

  @Output() valueCommit = new EventEmitter<void>();
  @Output() valueChanged = new EventEmitter<boolean>();

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

  // Array-like types that split on comma
  private readonly COMMA_ARRAY_TYPES = ['Bits', 'Encoding', 'CommaSepList', 'DumpFlags'];
  // Types that need machine-to-human conversion
  private readonly CONVERTIBLE_TYPES = ['Duration', 'SizeSuffix', 'BwTimetable'];

  //
  // ─── CORE LOGIC ──────────────────────────────────────────────────────────────
  //

  private calculateDefaultValue(option: RcConfigOption): any {
    switch (option.Type) {
      case 'bool':
        return option.Default === true || String(option.Default).toLowerCase() === 'true';

      case 'Bits':
      case 'Encoding':
      case 'CommaSepList':
      case 'DumpFlags':
        return this.splitToArray(option.DefaultStr, ',');

      case 'SpaceSepList':
        return this.splitToArray(option.DefaultStr, /\s+/);

      case 'stringArray':
        return Array.isArray(option.Default) ? option.Default.map(v => v ?? '') : [];

      default:
        return option.DefaultStr ?? '';
    }
  }

  private splitToArray(str: string | undefined, delimiter: string | RegExp): string[] {
    if (!str) return [];
    return str
      .split(delimiter)
      .map(v => v.trim())
      .filter(v => v);
  }

  isValueChanged(): boolean {
    if (!this.control) return false;
    return !this.valuesEqual(this.control.value, this.uiDefaultValue);
  }

  private valuesEqual(current: any, defaultVal: any): boolean {
    // Array comparison
    if (Array.isArray(current) || Array.isArray(defaultVal)) {
      const currArr = Array.isArray(current) ? current : [];
      const defArr = Array.isArray(defaultVal) ? defaultVal : [];
      if (currArr.length !== defArr.length) return false;
      const sortedCurr = [...currArr].sort();
      const sortedDef = [...defArr].sort();
      return sortedCurr.every((val, idx) => val === sortedDef[idx]);
    }

    // Empty values
    const currEmpty = current === null || current === undefined || current === '';
    const defEmpty = defaultVal === null || defaultVal === undefined || defaultVal === '';
    if (currEmpty && defEmpty) return true;

    // Booleans
    if (typeof current === 'boolean' || typeof defaultVal === 'boolean') {
      const currBool = current === true || String(current).toLowerCase() === 'true';
      const defBool = defaultVal === true || String(defaultVal).toLowerCase() === 'true';
      return currBool === defBool;
    }

    // Strings (case-insensitive)
    return String(current).toLowerCase() === String(defaultVal).toLowerCase();
  }

  resetToDefault(): void {
    if (!this.control) return;

    // If we have an array control, ensure the FormArray contents match the default array
    if (this.control instanceof FormArray) {
      const defaultArr = Array.isArray(this.uiDefaultValue) ? this.uiDefaultValue : [];
      const formArray = this.control as FormArray;

      // If lengths differ, rebuild the FormArray to match defaults
      if (formArray.length !== defaultArr.length) {
        formArray.clear({ emitEvent: false });
        defaultArr.forEach(val => formArray.push(new FormControl(val), { emitEvent: false }));
      } else {
        // Same length â€” just set values
        defaultArr.forEach((val, i) => formArray.at(i).setValue(val, { emitEvent: false }));
      }

      // emit change after adjusting the array
      this.commitValue();
      return;
    } else {
      // Non-array controls can be set directly
      this.control.setValue(this.uiDefaultValue);
    }
    this.commitValue();
  }

  getDisplayDefault(): string {
    if (
      this.uiDefaultValue === null ||
      this.uiDefaultValue === undefined ||
      this.uiDefaultValue === ''
    ) {
      return 'none';
    }
    if (Array.isArray(this.uiDefaultValue)) {
      return this.uiDefaultValue.join(', ') || '[]';
    }
    return this.uiDefaultValue.toString();
  }

  isAtDefault(): boolean {
    return !this.isValueChanged();
  }

  //
  // ─── CONTROL VALUE ACCESSOR ──────────────────────────────────────────────────
  //

  writeValue(value: any): void {
    if (!this.control) return;

    const internalValue = this.prepareValueForControl(value);

    if (this.control instanceof FormArray) {
      this.setFormArrayValue(this.control, internalValue);
    } else {
      this.control.setValue(internalValue, { emitEvent: false });
    }
  }

  private prepareValueForControl(value: any): any {
    // Handle convertible types (Duration, SizeSuffix, BwTimetable)
    if (this.CONVERTIBLE_TYPES.includes(this.option.Type)) {
      if (typeof value === 'number') {
        return this.valueMapper.machineToHuman(value, this.option.Type, this.option.ValueStr);
      }
      return value || this.option.ValueStr || this.option.DefaultStr || '';
    }

    // Handle comma-separated lists
    if (this.COMMA_ARRAY_TYPES.includes(this.option.Type)) {
      if (typeof value === 'string' && value) {
        return this.splitToArray(value, ',');
      }
      return Array.isArray(value) ? value : [];
    }

    // Handle space-separated lists
    if (this.option.Type === 'SpaceSepList') {
      if (typeof value === 'string' && value) {
        return this.splitToArray(value, /\s+/);
      }
      return Array.isArray(value) ? value : [];
    }

    // Handle booleans
    if (this.option.Type === 'bool') {
      return value === true || String(value).toLowerCase() === 'true';
    }

    // Handle string arrays
    if (this.option.Type === 'stringArray') {
      return Array.isArray(value) ? value : [];
    }

    return value;
  }

  private setFormArrayValue(formArray: FormArray, value: any): void {
    const arrayValue = Array.isArray(value) ? value : [];

    if (formArray.length !== arrayValue.length) {
      formArray.clear({ emitEvent: false });
      arrayValue.forEach(val => formArray.push(new FormControl(val), { emitEvent: false }));
    } else {
      arrayValue.forEach((val, i) => formArray.at(i).setValue(val, { emitEvent: false }));
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

  //
  // ─── CONTROL CREATION ────────────────────────────────────────────────────────
  //

  private createControl(): void {
    this.destroyed$.next();
    if (!this.option) return;

    const validators = this.getValidators();
    const isArrayType = this.isArrayType();

    if (isArrayType) {
      const initialArray = this.getInitialArrayValue();
      const controls = initialArray.map(val => new FormControl(val));
      this.control = new FormArray(controls, validators);
    } else {
      const initialValue = this.getInitialValue();
      this.control = new FormControl(initialValue, validators);
    }

    this.subscribeToChanges();
  }

  private isArrayType(): boolean {
    return ['stringArray', 'CommaSepList', 'SpaceSepList'].includes(this.option.Type);
  }

  private getInitialArrayValue(): string[] {
    if (this.option.Type === 'CommaSepList') {
      return this.splitToArray(this.option.ValueStr || this.option.DefaultStr, ',');
    }
    if (this.option.Type === 'SpaceSepList') {
      return this.splitToArray(this.option.ValueStr || this.option.DefaultStr, /\s+/);
    }
    // stringArray
    return (Array.isArray(this.option.Value) ? this.option.Value : []).filter(v => v);
  }

  private getInitialValue(): any {
    if (this.option.Type === 'bool') {
      return this.option.Value === true || String(this.option.Value).toLowerCase() === 'true';
    }

    if (this.option.Type === 'Encoding' || this.option.Type === 'Bits') {
      const strValue = (this.option.Value || this.option.DefaultStr || '').toString();
      return strValue ? strValue.split(',').filter((v: any) => v) : [];
    }

    if (this.CONVERTIBLE_TYPES.includes(this.option.Type)) {
      if (typeof this.option.Value === 'number') {
        return this.valueMapper.machineToHuman(
          this.option.Value,
          this.option.Type,
          this.option.ValueStr
        );
      }
      return this.option.ValueStr || this.option.DefaultStr || '';
    }

    return this.option.ValueStr || this.option.DefaultStr || '';
  }

  private subscribeToChanges(): void {
    this.control.valueChanges.pipe(takeUntil(this.destroyed$)).subscribe(value => {
      const outputValue = this.prepareValueForBackend(value);
      this.onChange(outputValue);
      this.onTouched();
      this.valueChanged.emit(this.isValueChanged());
    });
  }

  private prepareValueForBackend(value: any): any {
    // Arrays to comma-separated strings
    if (this.COMMA_ARRAY_TYPES.includes(this.option.Type)) {
      return Array.isArray(value) ? value.join(',') : value;
    }

    // Space-separated list to array
    if (this.option.Type === 'SpaceSepList') {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? [] : trimmed.split(/\s+/);
      }
      return value;
    }

    // Numbers from strings
    if (['int', 'int64', 'uint32'].includes(this.option.Type)) {
      if (typeof value === 'string' && value.trim() !== '') {
        const num = parseInt(value, 10);
        return isNaN(num) ? value : num;
      }
      return value;
    }

    if (this.option.Type === 'float64') {
      if (typeof value === 'string' && value.trim() !== '') {
        const num = parseFloat(value);
        return isNaN(num) ? value : num;
      }
      return value;
    }

    return value;
  }

  //
  // ─── VALIDATORS ──────────────────────────────────────────────────────────────
  //

  private getValidators(): ValidatorFn[] {
    const validators: ValidatorFn[] = [];
    if (this.option.Required) validators.push(Validators.required);

    const validatorMap: Record<string, () => ValidatorFn> = {
      stringArray: () => this.validatorRegistry.arrayValidator(),
      CommaSepList: () => this.validatorRegistry.arrayValidator(),
      SpaceSepList: () => this.validatorRegistry.arrayValidator(),
      int: () => this.validatorRegistry.integerValidator(this.option.DefaultStr),
      int64: () => this.validatorRegistry.integerValidator(this.option.DefaultStr),
      uint32: () => this.validatorRegistry.integerValidator(this.option.DefaultStr),
      float64: () => this.validatorRegistry.floatValidator(this.option.DefaultStr),
      Duration: () => this.validatorRegistry.durationValidator(this.option.DefaultStr),
      SizeSuffix: () => this.validatorRegistry.sizeSuffixValidator(this.option.DefaultStr),
      BwTimetable: () => this.validatorRegistry.bwTimetableValidator(this.option.DefaultStr),
      FileMode: () => this.validatorRegistry.fileModeValidator(this.option.DefaultStr),
      Time: () => this.validatorRegistry.timeValidator(this.option.DefaultStr),
      Bits: () => this.validatorRegistry.arrayValidator(),
      Encoding: () => this.validatorRegistry.arrayValidator(),
      Tristate: () => this.validatorRegistry.tristateValidator(),
    };

    const validatorFn = validatorMap[this.option.Type];
    if (validatorFn) validators.push(validatorFn());

    // Enum validator for non-multi-select types with examples
    const multiSelectTypes = [
      'DumpFlags',
      'Encoding',
      'Bits',
      'stringArray',
      'CommaSepList',
      'SpaceSepList',
    ];
    if (this.option.Examples && !multiSelectTypes.includes(this.option.Type)) {
      validators.push(this.validatorRegistry.enumValidator(this.option.Examples.map(e => e.Value)));
    }

    return validators;
  }

  //
  // ─── ARRAY HANDLING ──────────────────────────────────────────────────────────
  //

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

  get shouldShow(): boolean {
    // If no provider specified on this field, always show
    if (!this.option.Provider) return true;

    // If provider specified, only show if it matches selected
    return this.option.Provider === this.selectedProvider;
  }

  ngOnDestroy(): void {
    this.destroyed$.next();
    this.destroyed$.complete();
  }
}
