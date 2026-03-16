import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  DestroyRef,
  effect,
  input,
  output,
  computed,
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
import { MatTimepickerModule } from '@angular/material/timepicker';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { RcConfigOption, SENSITIVE_KEYS } from '@app/types';
import { Subscription, map } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LineBreaksPipe } from '../../pipes/linebreaks.pipe';
import { RcloneOptionTranslatePipe } from '../../pipes/rclone-option-translate.pipe';
import {
  RcloneValueMapperService,
  AppSettingsService,
  ValidatorRegistryService,
} from '@app/services';

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
    MatTimepickerModule,
    ScrollingModule,
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
      useExisting: SettingControlComponent,
      multi: true,
    },
    provideNativeDateAdapter(),
  ],
})
export class SettingControlComponent implements ControlValueAccessor {
  private readonly valueMapper = inject(RcloneValueMapperService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly translate = inject(TranslateService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly destroyRef = inject(DestroyRef);

  // Inputs using modern signals
  readonly option = input<RcConfigOption | null>(null);
  readonly optionOverrides = input<Record<string, Partial<RcConfigOption>>>({});
  readonly provider = input<string | null>(null);

  // Outputs
  readonly valueCommit = output<void>();
  readonly valueChanged = output<boolean>();

  // Reactive state
  readonly restrictMode = signal<boolean>(true);
  readonly control = signal<AbstractControl | null>(null);
  readonly dateControl = signal<FormControl<Date | null>>(new FormControl<Date | null>(null));
  readonly timeControl = signal<FormControl<Date | null>>(new FormControl<Date | null>(null));

  // Constants
  private readonly DEFAULT_OVERRIDES: Record<string, Partial<RcConfigOption>> = {
    min_age: { DefaultStr: '0s', Default: 0 },
    max_age: { DefaultStr: '0s', Default: 0 },
  };

  private readonly COMMA_ARRAY_TYPES = ['Bits', 'Encoding', 'CommaSepList', 'DumpFlags'];
  private readonly CONVERTIBLE_TYPES = ['Duration', 'SizeSuffix', 'BwTimetable', 'FileMode'];

  readonly encodingFlags = [
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

  readonly bitsFlags = ['date', 'time', 'microseconds', 'longfile', 'shortfile', 'pid'].sort();

  // Computed properties
  readonly mergedOption = computed(() => {
    const opt = this.option();
    if (!opt) return null;
    const builtIn = this.DEFAULT_OVERRIDES[opt.Name] || {};
    const caller = this.optionOverrides()[opt.Name] || {};
    return { ...opt, ...builtIn, ...caller } as RcConfigOption;
  });

  readonly uiDefaultValue = computed(() => {
    const opt = this.mergedOption();
    if (!opt) return '';
    return this.calculateDefaultValue(opt);
  });

  // Hold functionality state
  private holdInterval: ReturnType<typeof setInterval> | null = null;
  private holdTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly HOLD_DELAY = 400;
  private readonly HOLD_INTERVAL = 80;

  // ControlValueAccessor hooks
  private onChange: (value: unknown) => void = () => {
    /* Placeholder */
  };
  private onTouched: () => void = () => {
    /* Placeholder */
  };
  private controlSubscriptions = new Subscription();
  private pendingWriteValue: unknown = undefined;
  private hasPendingWrite = false;

  constructor() {
    this.appSettingsService
      .selectSetting('general.restrict')
      .pipe(
        map(setting => (setting?.value as boolean) ?? true),
        takeUntilDestroyed()
      )
      .subscribe(val => this.restrictMode.set(val));

    // React to option changes by creating/updating the control
    effect(() => {
      if (this.mergedOption()) {
        this.createControl();
      }
    });

    this.destroyRef.onDestroy(() => {
      this.controlSubscriptions.unsubscribe();
      this.stopHold(false);
    });
  }

  //
  // ─── CORE LOGIC ──────────────────────────────────────────────────────────────
  //

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
    return ctrl ? !this.valuesEqual(ctrl.value, this.uiDefaultValue()) : false;
  }

  private valuesEqual(current: unknown, defaultVal: unknown): boolean {
    if (Array.isArray(current) || Array.isArray(defaultVal)) {
      const currArr = Array.isArray(current) ? current : [];
      const defArr = Array.isArray(defaultVal) ? defaultVal : [];
      if (currArr.length !== defArr.length) return false;
      return [...currArr].sort().every((val, idx) => val === [...defArr].sort()[idx]);
    }

    const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === '';
    if (isEmpty(current) && isEmpty(defaultVal)) return true;

    if (typeof current === 'boolean' || typeof defaultVal === 'boolean') {
      const toBool = (v: unknown): boolean => v === true || String(v).toLowerCase() === 'true';
      return toBool(current) === toBool(defaultVal);
    }

    return String(current).toLowerCase() === String(defaultVal).toLowerCase();
  }

  resetToDefault(): void {
    const ctrl = this.control();
    if (!ctrl) return;

    const defaultValue = this.uiDefaultValue();
    if (ctrl instanceof FormArray) {
      const defaultArr = Array.isArray(defaultValue)
        ? (defaultValue as unknown[])
        : ([] as unknown[]);
      ctrl.clear({ emitEvent: false });
      defaultArr.forEach((val: unknown) => ctrl.push(new FormControl(val), { emitEvent: false }));
    }
    ctrl.setValue(defaultValue);
    this.commitValue();
  }

  getDisplayDefault(): string {
    const val = this.uiDefaultValue();
    if (val === null || val === undefined || val === '') {
      return this.translate.instant('shared.settingControl.none');
    }
    return Array.isArray(val) ? val.join(', ') || '[]' : val.toString();
  }

  isSensitiveField(): boolean {
    if (!this.restrictMode()) return false;

    const opt = this.mergedOption();
    if (!opt) return false;

    // Use explicit flags if available
    if (opt.IsPassword || opt.Sensitive) return true;

    // Fallback to name-based detection
    const name = opt.Name.toLowerCase();
    return SENSITIVE_KEYS.some(key => name.includes(key.toLowerCase()));
  }

  //
  // ─── CONTROL VALUE ACCESSOR ──────────────────────────────────────────────────
  //

  writeValue(value: any): void {
    const ctrl = this.control();
    if (!ctrl) {
      this.pendingWriteValue = value;
      this.hasPendingWrite = true;
      return;
    }

    const internalValue = this.prepareValueForControl(value);
    if (ctrl instanceof FormArray) {
      const arrayValue = Array.isArray(internalValue) ? internalValue : [];
      if (ctrl.length !== arrayValue.length) {
        ctrl.clear({ emitEvent: false });
        arrayValue.forEach(v => ctrl.push(new FormControl(v), { emitEvent: false }));
      } else {
        arrayValue.forEach((v, i) => ctrl.at(i).setValue(v, { emitEvent: false }));
      }
    } else {
      ctrl.setValue(internalValue, { emitEvent: false });
      if (this.mergedOption()?.Type === 'Time') {
        this.updateSplitFromControl(internalValue);
      }
    }
  }

  private prepareValueForControl(value: any): any {
    const opt = this.mergedOption();
    if (!opt) return value;

    if (this.CONVERTIBLE_TYPES.includes(opt.Type)) {
      return typeof value === 'number'
        ? this.valueMapper.machineToHuman(value, opt.Type, opt.ValueStr)
        : value || opt.ValueStr || opt.DefaultStr || '';
    }

    if (this.COMMA_ARRAY_TYPES.includes(opt.Type)) {
      return typeof value === 'string'
        ? this.splitToArray(value, ',')
        : Array.isArray(value)
          ? value
          : [];
    }

    if (opt.Type === 'SpaceSepList') {
      return typeof value === 'string'
        ? this.splitToArray(value, /\s+/)
        : Array.isArray(value)
          ? value
          : [];
    }

    if (opt.Type === 'bool') return value === true || String(value).toLowerCase() === 'true';
    if (opt.Type === 'Tristate') return this.parseTristateValue(value);
    if (opt.Type === 'stringArray') return Array.isArray(value) ? value : [];

    return value;
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
    this.controlSubscriptions.unsubscribe();
    this.controlSubscriptions = new Subscription();

    const opt = this.mergedOption();
    if (!opt) return;

    const validators = this.getValidators(opt);
    const isArray = ['stringArray', 'CommaSepList', 'SpaceSepList'].includes(opt.Type);

    if (isArray) {
      const initial = this.getInitialArrayValue(opt);
      this.control.set(
        new FormArray(
          initial.map(v => new FormControl(v)),
          validators
        )
      );
    } else {
      this.control.set(new FormControl(this.getInitialValue(opt), validators));
    }

    this.subscribeToChanges();

    if (this.hasPendingWrite) {
      this.writeValue(this.pendingWriteValue);
      this.hasPendingWrite = false;
      this.pendingWriteValue = undefined;
    }
  }

  private getInitialArrayValue(opt: RcConfigOption): string[] {
    if (opt.Type === 'CommaSepList') return this.splitToArray(opt.ValueStr || opt.DefaultStr, ',');
    if (opt.Type === 'SpaceSepList')
      return this.splitToArray(opt.ValueStr || opt.DefaultStr, /\s+/);
    return (Array.isArray(opt.Value) ? opt.Value : []).filter((v): v is string => !!v);
  }

  private getInitialValue(opt: RcConfigOption): any {
    if (opt.Type === 'bool')
      return opt.Value === true || String(opt.Value).toLowerCase() === 'true';
    if (opt.Type === 'Encoding' || opt.Type === 'Bits') {
      return (opt.Value || opt.DefaultStr || '')
        .toString()
        .split(',')
        .filter((v: string) => v);
    }
    if (this.CONVERTIBLE_TYPES.includes(opt.Type)) {
      return typeof opt.Value === 'number'
        ? this.valueMapper.machineToHuman(opt.Value, opt.Type, opt.ValueStr)
        : opt.ValueStr || opt.DefaultStr || '';
    }
    if (opt.Type === 'Tristate') return this.parseTristateValue(opt.Value ?? opt.ValueStr);
    return opt.ValueStr || opt.DefaultStr || '';
  }

  private subscribeToChanges(): void {
    const ctrl = this.control();
    if (!ctrl) return;

    this.controlSubscriptions.add(
      ctrl.valueChanges.subscribe(value => {
        this.onChange(this.prepareValueForBackend(value));
        this.onTouched();
        this.valueChanged.emit(this.isValueChanged());
        if (this.mergedOption()?.Type === 'Time') this.updateSplitFromControl(value);
      })
    );

    if (this.mergedOption()?.Type === 'Time') {
      this.updateSplitFromControl(ctrl.value);
      this.controlSubscriptions.add(
        this.dateControl().valueChanges.subscribe(() => this.syncTimeFromSplit())
      );
      this.controlSubscriptions.add(
        this.timeControl().valueChanges.subscribe(() => this.syncTimeFromSplit())
      );
    }
  }

  private syncTimeFromSplit(): void {
    const ctrl = this.control();
    const combined = this.combineDateTime();
    if (ctrl && combined !== null && ctrl.value !== combined) {
      ctrl.setValue(combined);
    }
  }

  private updateSplitFromControl(value: any): void {
    if (!value || typeof value !== 'string') {
      this.dateControl().setValue(null, { emitEvent: false });
      this.timeControl().setValue(null, { emitEvent: false });
      return;
    }

    const match = value.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}(?::\d{2})?).*/);
    if (!match) return;

    const [y, m, d] = match[1].split('-').map(Number);
    const timeParts = match[2].match(/^(\d{2}):(\d{2})/)?.map(Number) || [0, 0, 0];
    const hh = timeParts[1];
    const mm = timeParts[2];

    this.dateControl().setValue(new Date(y, m - 1, d), { emitEvent: false });
    this.timeControl().setValue(new Date(1970, 0, 1, hh, mm), { emitEvent: false });
  }

  private parseTristateValue(v: unknown): boolean | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    return s === 'true' ? true : s === 'false' ? false : null;
  }

  private combineDateTime(): string | null {
    const d = this.dateControl().value;
    const t = this.timeControl().value;
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;

    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(t?.getHours() || 0)}:${pad(t?.getMinutes() || 0)}:00Z`;
  }

  private prepareValueForBackend(value: any): any {
    const opt = this.mergedOption();
    if (!opt) return value;

    // Delegate to mapper service for standard types
    let machineValue = this.valueMapper.humanToMachine(value, opt.Type);

    // Special handling for FileMode to match rclone's numeric expectation if it's a string
    if (opt.Type === 'FileMode' && typeof machineValue === 'string') {
      const parsed = parseInt(machineValue, 8);
      if (!isNaN(parsed)) machineValue = parsed;
    }

    return machineValue;
  }

  stepChange(direction: 1 | -1, step: number | 'any' = 1, commit = true): void {
    const ctrl = this.control();
    if (!ctrl) return;
    const isFloat = this.mergedOption()?.Type === 'float64';
    const current = isFloat ? parseFloat(ctrl.value) : parseInt(ctrl.value, 10);
    const num = isNaN(current) ? 0 : current;
    const next = num + (step === 'any' ? 1.0 : step) * direction;
    ctrl.setValue(isFloat ? parseFloat(next.toPrecision(15)) : next);
    if (commit) this.commitValue();
  }

  onIntegerInput(event: KeyboardEvent): void {
    const type = this.mergedOption()?.Type;
    if (!type || !['int', 'int64', 'int32', 'uint', 'uint32', 'uint64'].includes(type)) return;

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
      event.metaKey
    )
      return;

    if (event.key === '-' && !type.startsWith('uint')) {
      const input = event.target as HTMLInputElement;
      if (input.selectionStart === 0 && !input.value.includes('-')) return;
    }

    if (!/^\d$/.test(event.key)) event.preventDefault();
  }

  startHold(action: 'increment' | 'decrement', step: number | 'any'): void {
    this.stopHold(false);
    const dir = action === 'increment' ? 1 : -1;
    this.stepChange(dir, step, false);
    this.holdTimeout = setTimeout(() => {
      this.holdInterval = setInterval(() => this.stepChange(dir, step, false), this.HOLD_INTERVAL);
    }, this.HOLD_DELAY);
  }

  stopHold(commit = true): void {
    if (this.holdTimeout) clearTimeout(this.holdTimeout);
    if (this.holdInterval) clearInterval(this.holdInterval);
    this.holdTimeout = this.holdInterval = null;
    if (commit) this.commitValue();
  }

  private getValidators(opt: RcConfigOption): ValidatorFn[] {
    const validators: ValidatorFn[] = [];
    if (opt.Required) validators.push(Validators.required);

    const registry = this.validatorRegistry;
    const vMap: Record<string, () => ValidatorFn> = {
      stringArray: () => registry.arrayValidator(),
      CommaSepList: () => registry.arrayValidator(),
      SpaceSepList: () => registry.arrayValidator(),
      int: () => registry.integerValidator(opt.DefaultStr),
      int64: () => registry.integerValidator(opt.DefaultStr),
      int32: () => registry.integerValidator(opt.DefaultStr),
      uint: () => registry.integerValidator(opt.DefaultStr),
      uint32: () => registry.integerValidator(opt.DefaultStr),
      uint64: () => registry.integerValidator(opt.DefaultStr),
      float: () => registry.floatValidator(opt.DefaultStr),
      float32: () => registry.floatValidator(opt.DefaultStr),
      float64: () => registry.floatValidator(opt.DefaultStr),
      Duration: () => registry.durationValidator(opt.DefaultStr),
      SizeSuffix: () => registry.sizeSuffixValidator(opt.DefaultStr),
      BwTimetable: () => registry.bwTimetableValidator(opt.DefaultStr),
      FileMode: () => registry.fileModeValidator(opt.DefaultStr),
      Time: () => registry.timeValidator(opt.DefaultStr),
      Bits: () => registry.arrayValidator(),
      Encoding: () => registry.arrayValidator(),
      Tristate: () => registry.tristateValidator(),
    };

    if (vMap[opt.Type]) validators.push(vMap[opt.Type]());

    const isMultiSelect = [
      'DumpFlags',
      'Encoding',
      'Bits',
      'stringArray',
      'CommaSepList',
      'SpaceSepList',
    ].includes(opt.Type);
    if (opt.Examples && !isMultiSelect) {
      validators.push(registry.enumValidator(opt.Examples.map(e => e.Value)));
    }

    return validators;
  }

  get formArrayControls(): FormControl[] {
    const ctrl = this.control();
    return ctrl instanceof FormArray ? (ctrl.controls as FormControl[]) : [];
  }

  addArrayItem(): void {
    const ctrl = this.control();
    if (ctrl instanceof FormArray) ctrl.push(new FormControl(''));
  }

  removeArrayItem(i: number): void {
    const ctrl = this.control();
    if (ctrl instanceof FormArray) {
      ctrl.removeAt(i);
      this.commitValue();
    }
  }

  getControlError(): string | null {
    const errors = this.control()?.errors as Record<string, { message?: string }>;
    if (!errors) return null;
    const keys = [
      'required',
      'integer',
      'float',
      'duration',
      'sizeSuffix',
      'bwTimetable',
      'fileMode',
      'time',
      'enum',
    ];
    for (const key of keys) {
      if (errors[key]?.message) return errors[key].message;
    }
    return this.translate.instant('shared.settingControl.errors.invalidValue');
  }

  preventClipboardOnSensitive(e: ClipboardEvent): void {
    if (this.isSensitiveField() && (e.type === 'copy' || e.type === 'cut')) e.preventDefault();
  }
}
