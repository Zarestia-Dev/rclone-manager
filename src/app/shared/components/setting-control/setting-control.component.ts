import {
  Component,
  Input,
  forwardRef,
  OnDestroy,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  inject,
  signal,
  WritableSignal,
  DestroyRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
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
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatNativeDateModule, provideNativeDateAdapter } from '@angular/material/core';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { NgxMatTimepickerModule } from 'ngx-mat-timepicker';
import { RcConfigOption } from '@app/types';
import { SENSITIVE_KEYS } from '@app/types';
import { Subject, map } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LineBreaksPipe } from '../../pipes/linebreaks.pipe';
import { RcloneOptionTranslatePipe } from '../../pipes/rclone-option-translate.pipe';
import { RcloneValueMapperService, AppSettingsService } from '@app/services';
import { ValidatorRegistryService } from '@app/services';

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
    MatTooltipModule,
    MatButtonModule,
    MatDatepickerModule,
    MatNativeDateModule,
    ScrollingModule,
    NgxMatTimepickerModule,
    LineBreaksPipe,
    RcloneOptionTranslatePipe,
    TranslateModule,
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
    provideNativeDateAdapter(),
  ],
})
export class SettingControlComponent implements ControlValueAccessor, OnDestroy {
  private valueMapper = inject(RcloneValueMapperService);
  private validatorRegistry = inject(ValidatorRegistryService);
  private translate = inject(TranslateService);
  private appSettingsService = inject(AppSettingsService);
  private destroyRef = inject(DestroyRef);

  // Reactive restriction mode from settings
  restrictMode = signal<boolean>(true);

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

  /** The provider context for translations (e.g. 's3', 'drive') */
  @Input() provider?: string | null;

  // option stored as a signal for better reactivity
  private optionSignal: WritableSignal<RcConfigOption | null> = signal<RcConfigOption | null>(null);
  // Derived default shown in the UI as a signal
  public uiDefaultValue = signal<unknown>('');

  @Input()
  get option(): RcConfigOption {
    return this.optionSignal() as RcConfigOption;
  }
  set option(val: RcConfigOption | null) {
    if (!val) return;
    // Merge built-in and caller-provided overrides for this option
    const builtIn = this.defaultOptionOverrides[val.Name] || {};
    const caller = this.optionOverrides[val.Name] || {};
    const merged = { ...val, ...builtIn, ...caller } as RcConfigOption;
    this.optionSignal.set(merged);
    // Update derived UI default value
    this.uiDefaultValue.set(this.calculateDefaultValue(merged));
    this.createControl();
  }

  @Output() valueCommit = new EventEmitter<void>();
  @Output() valueChanged = new EventEmitter<boolean>();

  // control as a signal so the template and computed values can react to changes
  public control = signal<AbstractControl | null>(null);
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
  // For Time type UI (split date + time inputs) — converted to signals
  public dateControl = signal<FormControl>(new FormControl(''));
  public timeControl = signal<FormControl>(new FormControl(''));

  private onChange: (value: unknown) => void = () => {
    /* empty */
  };
  private onTouched: () => void = () => {
    /* empty */
  };
  private destroyed$ = new Subject<void>();

  // Array-like types that split on comma
  private readonly COMMA_ARRAY_TYPES = ['Bits', 'Encoding', 'CommaSepList', 'DumpFlags'];
  // Types that need machine-to-human conversion
  private readonly CONVERTIBLE_TYPES = ['Duration', 'SizeSuffix', 'BwTimetable', 'FileMode'];
  private holdInterval: ReturnType<typeof setInterval> | null = null;
  private holdTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly HOLD_DELAY = 400;
  private readonly HOLD_INTERVAL = 80;

  //
  // ─── CORE LOGIC ──────────────────────────────────────────────────────────────
  //

  constructor() {
    this.appSettingsService
      .selectSetting('general.restrict')
      .pipe(map(setting => (setting?.value as boolean) ?? true))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(val => this.restrictMode.set(val));
  }

  private calculateDefaultValue(option: RcConfigOption): unknown {
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
    const ctrl = this.control();
    if (!ctrl) return false;
    return !this.valuesEqual(ctrl.value, this.uiDefaultValue());
  }

  private valuesEqual(current: unknown, defaultVal: unknown): boolean {
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
    const ctrl = this.control();
    if (!ctrl) return;

    // If we have an array control, ensure the FormArray contents match the default array
    if (ctrl instanceof FormArray) {
      const defaultArr = Array.isArray(this.uiDefaultValue())
        ? (this.uiDefaultValue() as unknown[])
        : [];
      const formArray = ctrl as FormArray;

      // If lengths differ, rebuild the FormArray to match defaults
      if (formArray.length !== defaultArr.length) {
        formArray.clear({ emitEvent: false });
        defaultArr.forEach((val: unknown) =>
          formArray.push(new FormControl(val), { emitEvent: false })
        );
      } else {
        // Same length just set values
        defaultArr.forEach((val: unknown, i: number) =>
          formArray.at(i).setValue(val, { emitEvent: false })
        );
      }
    }
    ctrl.setValue(this.uiDefaultValue());
    this.commitValue();
  }

  getDisplayDefault(): string {
    const _val = this.uiDefaultValue();
    if (_val === null || _val === undefined || _val === '') {
      return this.translate.instant('shared.settingControl.none');
    }
    if (Array.isArray(_val)) {
      return _val.join(', ') || '[]';
    }
    return _val.toString();
  }

  /**
   * Determines if the current field is sensitive and should be restricted
   * based on the restrictMode setting
   */
  isSensitiveField(): boolean {
    if (!this.restrictMode()) return false;
    const fieldName = this.option?.Name?.toLowerCase() || '';
    return SENSITIVE_KEYS.some(key => fieldName.includes(key.toLowerCase()));
  }

  isAtDefault(): boolean {
    return !this.isValueChanged();
  }

  //
  // ─── CONTROL VALUE ACCESSOR ──────────────────────────────────────────────────
  //

  writeValue(value: any): void {
    const ctrl = this.control();
    if (!ctrl) return;

    const internalValue = this.prepareValueForControl(value);

    if (ctrl instanceof FormArray) {
      this.setFormArrayValue(ctrl as FormArray, internalValue);
    } else {
      ctrl.setValue(internalValue, { emitEvent: false });
      // If this is a Time type, update the split date/time controls
      if (this.option && this.option.Type === 'Time') {
        this.updateSplitFromControl(internalValue);
      }
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
    if (!this.optionSignal()) return;

    const validators = this.getValidators();
    const isArrayType = this.isArrayType();

    if (isArrayType) {
      const initialArray = this.getInitialArrayValue();
      const controls = initialArray.map(val => new FormControl(val));
      this.control.set(new FormArray(controls, validators));
    } else {
      const initialValue = this.getInitialValue();
      this.control.set(new FormControl(initialValue, validators));
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
    console.log('Getting initial array value:', this.option);

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
    const ctrl = this.control();
    if (!ctrl) return;

    (ctrl as AbstractControl).valueChanges.pipe(takeUntil(this.destroyed$)).subscribe(value => {
      const outputValue = this.prepareValueForBackend(value);
      this.onChange(outputValue);
      this.onTouched();
      this.valueChanged.emit(this.isValueChanged());
      // If option is Time, reflect any changes (including resets) into the split controls
      if (this.option && this.option.Type === 'Time') {
        this.updateSplitFromControl(value);
      }
    });

    // If option is Time, keep the date/time split controls in sync with the main control
    if (this.option && this.option.Type === 'Time') {
      // initialize split controls
      this.updateSplitFromControl((this.control() as AbstractControl).value);

      const dateCtrl = this.dateControl();
      dateCtrl.valueChanges.pipe(takeUntil(this.destroyed$)).subscribe(() => {
        const combined = this.combineDateTime();
        // update main control which will trigger prepareValueForBackend and onChange
        (this.control() as AbstractControl).setValue(combined);
      });

      const timeCtrl = this.timeControl();
      timeCtrl.valueChanges.pipe(takeUntil(this.destroyed$)).subscribe(() => {
        const combined = this.combineDateTime();
        (this.control() as AbstractControl).setValue(combined);
      });
    }
  }

  private updateSplitFromControl(value: any): void {
    // value expected to be ISO-like string (YYYY-MM-DDTHH:mm:ssZ) or empty
    if (!value || typeof value !== 'string') {
      this.dateControl().setValue('', { emitEvent: false });
      this.timeControl().setValue('', { emitEvent: false });
      return;
    }

    // Try to parse ISO-like value safely
    // Accept forms like: YYYY-MM-DDTHH:mm[:ss][Z]
    const m = value.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}(?::\d{2})?).*/);
    if (m) {
      const datePart = m[1];
      let timePart = m[2];
      // Trim seconds for time input (HH:mm)
      const tmatch = timePart.match(/^(\d{2}:\d{2})/);
      if (tmatch) timePart = tmatch[1];
      this.dateControl().setValue(datePart, { emitEvent: false });
      this.timeControl().setValue(timePart, { emitEvent: false });
    } else {
      // Fallback: clear
      this.dateControl().setValue('', { emitEvent: false });
      this.timeControl().setValue('', { emitEvent: false });
    }
  }

  private combineDateTime(): string {
    const date = this.dateControl().value;
    let time = this.timeControl().value || '00:00';
    if (!date) return '';

    // Handle time string - extract HH:mm and handle potential AM/PM format
    if (typeof time === 'string') {
      // Extract just HH:mm part (remove seconds and AM/PM if present)
      const timeMatch = time.match(/^(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1], 10);
        const minutes = timeMatch[2];

        // Handle 12-hour format if AM/PM is present
        if (time.toLowerCase().includes('pm') && hours < 12) {
          hours += 12;
        } else if (time.toLowerCase().includes('am') && hours === 12) {
          hours = 0;
        }

        time = `${hours.toString().padStart(2, '0')}:${minutes}`;
      }
    }

    // Ensure time includes minutes; we append seconds and Z to match ISO expected format
    const seconds = ':00';
    return `${date}T${time}${seconds}Z`;
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

  /**
   * Increments the number value in the control.
   * @param step The amount to increment by. Defaults to 1. For floats, uses 'any'.
   * @param commit Whether to commit the value immediately. Defaults to true.
   */
  increment(step: number | 'any' = 1, commit = true): void {
    // Add commit parameter
    const ctrl = this.control();
    if (!ctrl) return;
    const isFloat = this.option.Type === 'float64';
    const currentValue = isFloat ? parseFloat(ctrl.value) : parseInt(ctrl.value, 10);
    const numValue = isNaN(currentValue) ? 0 : currentValue;

    const effectiveStep = step === 'any' ? 1.0 : step;
    const newValue = numValue + effectiveStep;

    const finalValue = isFloat ? parseFloat(newValue.toPrecision(15)) : newValue;

    ctrl.setValue(finalValue);
    if (commit) {
      // Only commit if requested
      this.commitValue();
    }
  }

  /**
   * Decrements the number value in the control.
   * @param step The amount to decrement by. Defaults to 1. For floats, uses 'any'.
   * @param commit Whether to commit the value immediately. Defaults to true.
   */
  decrement(step: number | 'any' = 1, commit = true): void {
    // Add commit parameter
    const ctrl = this.control();
    if (!ctrl) return;
    const isFloat = this.option.Type === 'float64';
    const currentValue = isFloat ? parseFloat(ctrl.value) : parseInt(ctrl.value, 10);
    const numValue = isNaN(currentValue) ? 0 : currentValue;

    const effectiveStep = step === 'any' ? 1.0 : step;
    const newValue = numValue - effectiveStep;

    const finalValue = isFloat ? parseFloat(newValue.toPrecision(15)) : newValue;

    ctrl.setValue(finalValue);
    if (commit) {
      // Only commit if requested
      this.commitValue();
    }
  }

  /**
   * Prevents non-numeric key presses for integer type inputs for a better UX.
   * The form validator remains the ultimate source of truth.
   * @param event The keyboard event.
   */
  onIntegerInput(event: KeyboardEvent): void {
    if (['int', 'int64', 'uint32'].includes(this.option.Type)) {
      // Allow control keys, navigation, and clipboard actions
      if (
        [
          'Backspace',
          'Delete',
          'Tab',
          'Escape',
          'Enter',
          'Home',
          'End',
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
        ].includes(event.key) ||
        event.ctrlKey ||
        event.metaKey // Allow Ctrl+A, C, V, X etc.
      ) {
        return;
      }

      // Allow the negative sign only at the beginning for signed integers
      if (event.key === '-' && this.option.Type !== 'uint32') {
        const input = event.target as HTMLInputElement;
        if (input.selectionStart === 0 && !input.value.includes('-')) {
          return;
        }
      }

      // Prevent any key press that is not a digit
      if (!/^\d$/.test(event.key)) {
        event.preventDefault();
      }
    }
  }

  /**
   * Starts the process of continuously changing the value when a button is held.
   * @param action The action to perform ('increment' or 'decrement').
   * @param step The step value for the action.
   */
  startHold(action: 'increment' | 'decrement', step: number | 'any'): void {
    // Clear any existing timers to be safe
    this.stopHold(false); // Don't commit on start

    // Perform the action once immediately on click/press
    if (action === 'increment') {
      this.increment(step, false);
    } else {
      this.decrement(step, false);
    }

    // Set a timeout to begin the repeating interval
    this.holdTimeout = setTimeout(() => {
      this.holdInterval = setInterval(() => {
        if (action === 'increment') {
          this.increment(step, false); // Pass false to prevent commit on each tick
        } else {
          this.decrement(step, false); // Pass false to prevent commit on each tick
        }
      }, this.HOLD_INTERVAL);
    }, this.HOLD_DELAY);
  }

  /**
   * Stops the continuous value change and commits the final value.
   * @param commit Final value after stopping. Defaults to true.
   */
  stopHold(commit = true): void {
    if (this.holdTimeout) clearTimeout(this.holdTimeout);
    if (this.holdInterval) clearInterval(this.holdInterval);
    this.holdTimeout = null;
    this.holdInterval = null;

    if (commit) {
      this.commitValue(); // Commit the final value once the user releases the button
    }
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
    const ctrl = this.control();
    return ctrl instanceof FormArray ? ctrl.controls : [];
  }

  addArrayItem(): void {
    const ctrl = this.control();
    if (ctrl instanceof FormArray) {
      (ctrl as FormArray).push(new FormControl(''));
    }
  }

  removeArrayItem(index: number): void {
    const ctrl = this.control();
    if (ctrl instanceof FormArray) {
      (ctrl as FormArray).removeAt(index);
      this.commitValue();
    }
  }

  getControlError(): string | null {
    const ctrl = this.control();
    if (!ctrl || !ctrl.errors) return null;
    const errors = ctrl.errors as Record<string, { message?: string }>;
    return (
      errors['required']?.message ||
      errors['integer']?.message ||
      errors['float']?.message ||
      errors['duration']?.message ||
      errors['sizeSuffix']?.message ||
      errors['bwTimetable']?.message ||
      errors['fileMode']?.message ||
      errors['enum']?.message ||
      this.translate.instant('shared.settingControl.errors.invalidValue')
    );
  }

  ngOnDestroy(): void {
    this.destroyed$.next();
    this.destroyed$.complete();
  }

  /**
   * Prevents clipboard events (paste, copy, cut) on sensitive fields when restrict mode is enabled
   */
  preventClipboardOnSensitive(event: ClipboardEvent): void {
    if (this.isSensitiveField()) {
      event.preventDefault();
    }
  }
}
