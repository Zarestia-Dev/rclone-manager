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
import { NgTemplateOutlet } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  AbstractControl,
  ControlValueAccessor,
  FormArray,
  FormControl,
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
import { RcConfigOption, SENSITIVE_KEYS } from '@app/types';
import { Subscription, map } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LineBreaksPipe, RcloneOptionTranslatePipe } from '@app/pipes';
import { NumberInputComponent } from '../number-input/number-input.component';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { ValidatorRegistryService } from 'src/app/services/ui/validation/validator-registry.service';

@Component({
  selector: 'app-setting-control',
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
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
    LineBreaksPipe,
    RcloneOptionTranslatePipe,
    TranslateModule,
    NumberInputComponent,
  ],
  templateUrl: './setting-control.component.html',
  styleUrl: './setting-control.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: SettingControlComponent, multi: true },
    provideNativeDateAdapter(),
  ],
})
export class SettingControlComponent implements ControlValueAccessor {
  private readonly valueMapper = inject(RcloneValueMapperService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly translate = inject(TranslateService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly destroyRef = inject(DestroyRef);

  // Inputs / Outputs
  readonly option = input<RcConfigOption | null>(null);
  readonly optionOverrides = input<Record<string, Partial<RcConfigOption>>>({});
  readonly provider = input<string | null>(null);

  readonly valueCommit = output<void>();
  readonly valueChanged = output<boolean>();

  // Reactive state
  readonly restrictMode = signal(true);
  readonly control = signal<AbstractControl | null>(null);
  readonly dateControl = signal<FormControl<Date | null>>(new FormControl<Date | null>(null));
  readonly timeControl = signal<FormControl<Date | null>>(new FormControl<Date | null>(null));

  // Signal-backed list of FormArray controls — zoneless CD picks up add/remove.
  readonly formArrayControls = signal<FormControl[]>([]);

  readonly isValueChanged = signal(false);

  readonly isSensitiveField = computed(() => {
    if (!this.restrictMode()) return false;
    const opt = this.mergedOption();
    if (!opt) return false;
    if (opt.IsPassword || opt.Sensitive) return true;
    const name = opt.Name.toLowerCase();
    return SENSITIVE_KEYS.some(key => name.includes(key.toLowerCase()));
  });

  readonly displayDefault = computed(() => {
    const val = this.uiDefaultValue();
    if (val === null || val === undefined || val === '') {
      return this.translate.instant('shared.settingControl.none');
    }
    return Array.isArray(val) ? val.join(', ') || '[]' : String(val);
  });

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

  // Computed
  readonly mergedOption = computed(() => {
    const opt = this.option();
    if (!opt) return null;
    const builtIn = this.DEFAULT_OVERRIDES[opt.Name] ?? {};
    const caller = this.optionOverrides()[opt.Name] ?? {};
    return { ...opt, ...builtIn, ...caller } as RcConfigOption;
  });

  readonly uiDefaultValue = computed(() => {
    const opt = this.mergedOption();
    return opt ? this.calculateDefaultValue(opt) : '';
  });

  // ControlValueAccessor
  private onChange: (value: unknown) => void = () => {
    /* empty */
  };
  private onTouched: () => void = () => {
    /* empty */
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

    effect(() => {
      if (this.mergedOption()) this.createControl();
    });

    this.destroyRef.onDestroy(() => {
      this.controlSubscriptions.unsubscribe();
    });
  }

  // Core logic

  private calculateDefaultValue(option: RcConfigOption): unknown {
    switch (option.Type) {
      case 'bool':
        return option.Default === true || String(option.Default).toLowerCase() === 'true';
      case 'Tristate':
        return this.valueMapper.parseTristate(option.Default);
      case 'Bits':
        if (this.isBitsWithCombos(option)) return option.DefaultStr ?? '';
        if (!option.Examples?.length) return option.DefaultStr ?? '';
        return this.splitToArray(option.DefaultStr, ',');
      case 'Encoding':
      case 'CommaSepList':
      case 'DumpFlags':
        return this.splitToArray(option.DefaultStr, ',');
      case 'SpaceSepList':
        return this.splitToArray(option.DefaultStr, /\s+/);
      case 'stringArray':
        return Array.isArray(option.Default) && option.Default.length > 0
          ? option.Default.map(v => v ?? '')
          : Array.isArray(option.Value) && option.Value.length > 0
            ? option.Value.map(v => v ?? '')
            : [];
      default:
        return option.DefaultStr ?? '';
    }
  }

  private splitToArray(str: string | undefined, delimiter: string | RegExp): string[] {
    if (!str) return [];
    return str
      .split(delimiter)
      .map(v => v.trim())
      .filter(Boolean);
  }

  private valuesEqual(current: unknown, defaultVal: unknown): boolean {
    const optType = this.mergedOption()?.Type;

    if (optType === 'Tristate') {
      return current === defaultVal;
    }

    if (
      optType &&
      (this.COMMA_ARRAY_TYPES.includes(optType) ||
        optType === 'SpaceSepList' ||
        optType === 'stringArray')
    ) {
      const toArray = (v: unknown): string[] => {
        if (Array.isArray(v)) return v.map(String);
        if (typeof v === 'string') {
          const delimiter = optType === 'SpaceSepList' ? /\s+/ : ',';
          return v
            .split(delimiter)
            .map(s => s.trim())
            .filter(Boolean);
        }
        if (v === null || v === undefined) return [];
        return [String(v)];
      };

      const currArr = toArray(current);
      const defArr = toArray(defaultVal);
      if (currArr.length !== defArr.length) return false;
      const sortedCurr = [...currArr].sort();
      const sortedDef = [...defArr].sort();
      return sortedCurr.every((val, idx) => val === sortedDef[idx]);
    }

    if (optType === 'bool') {
      const toBool = (v: unknown): boolean => v === true || String(v).toLowerCase() === 'true';
      return toBool(current) === toBool(defaultVal);
    }

    const isEmpty = (v: unknown): boolean =>
      v === null || v === undefined || String(v).trim() === '';
    if (isEmpty(current) && isEmpty(defaultVal)) return true;

    return String(current).toLowerCase() === String(defaultVal).toLowerCase();
  }

  resetToDefault(): void {
    const ctrl = this.control();
    if (!ctrl) return;

    const defaultValue = this.uiDefaultValue();

    if (ctrl instanceof FormArray) {
      const defaultArr = Array.isArray(defaultValue) ? (defaultValue as unknown[]) : [];
      ctrl.clear({ emitEvent: false });
      defaultArr.forEach(val => ctrl.push(new FormControl(val), { emitEvent: false }));
      this.syncFormArrayControls(ctrl);
      this.onChange(this.prepareValueForBackend(ctrl.value));
      this.isValueChanged.set(false);
      this.valueChanged.emit(false);
      this.commitValue();
      return;
    }

    ctrl.setValue(defaultValue);
    this.commitValue();
  }

  preventClipboardOnSensitive(e: ClipboardEvent): void {
    if (this.isSensitiveField() && (e.type === 'copy' || e.type === 'cut')) {
      e.preventDefault();
    }
  }

  // ControlValueAccessor implementation

  writeValue(value: unknown): void {
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
        this.syncFormArrayControls(ctrl);
      } else {
        arrayValue.forEach((v, i) => ctrl.at(i).setValue(v, { emitEvent: false }));
      }
    } else {
      ctrl.setValue(internalValue, { emitEvent: false });
      if (this.mergedOption()?.Type === 'Time') {
        this.updateSplitFromControl(internalValue);
      }
    }
    this.isValueChanged.set(!this.valuesEqual(ctrl.value, this.uiDefaultValue()));
  }

  private prepareValueForControl(value: unknown): unknown {
    const opt = this.mergedOption();
    if (!opt) return value;

    if ((value === null || value === undefined) && opt.Type !== 'Tristate') {
      value = this.uiDefaultValue();
    }

    if (this.CONVERTIBLE_TYPES.includes(opt.Type)) {
      return typeof value === 'number'
        ? this.valueMapper.machineToHuman(value, opt.Type, opt.ValueStr)
        : value || opt.ValueStr || opt.DefaultStr || '';
    }

    if (this.COMMA_ARRAY_TYPES.includes(opt.Type)) {
      if (this.isBitsWithCombos(opt)) {
        return typeof value === 'string' ? value : opt.ValueStr || opt.DefaultStr || '';
      }
      if (opt.Type === 'Bits' && !opt.Examples?.length) {
        if (typeof value === 'number') return opt.ValueStr || opt.DefaultStr || '';
        return typeof value === 'string' ? value : opt.ValueStr || opt.DefaultStr || '';
      }
      // rclone may return an integer bitmask — use ValueStr (always human-readable).
      if (typeof value === 'number') {
        return this.splitToArray(opt.ValueStr || opt.DefaultStr || '', ',');
      }
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
    if (opt.Type === 'Tristate') return this.valueMapper.parseTristate(value);
    if (opt.Type === 'stringArray') return Array.isArray(value) ? value : [];
    if (typeof value === 'number' && opt.Examples?.length) {
      return opt.ValueStr || opt.DefaultStr || '';
    }

    return value;
  }

  commitValue(): void {
    this.valueCommit.emit();
  }

  registerOnChange(fn: (value: unknown) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  // Control creation

  private createControl(): void {
    this.controlSubscriptions.unsubscribe();
    this.controlSubscriptions = new Subscription();

    const opt = this.mergedOption();
    if (!opt) return;

    const validators = this.getValidators(opt);
    const isArray = ['stringArray', 'CommaSepList', 'SpaceSepList'].includes(opt.Type);

    if (isArray) {
      const initial = this.getInitialArrayValue(opt);
      const formArray = new FormArray(
        initial.map(v => new FormControl(v)),
        validators
      );
      this.control.set(formArray);
      this.syncFormArrayControls(formArray);
    } else {
      this.control.set(new FormControl(this.getInitialValue(opt), validators));
    }

    this.subscribeToChanges();

    if (this.hasPendingWrite) {
      this.writeValue(this.pendingWriteValue);
      this.hasPendingWrite = false;
      this.pendingWriteValue = undefined;
    }

    const ctrl = this.control();
    if (ctrl) {
      this.isValueChanged.set(!this.valuesEqual(ctrl.value, this.uiDefaultValue()));
    }
  }

  private syncFormArrayControls(ctrl: FormArray): void {
    this.formArrayControls.set([...ctrl.controls] as FormControl[]);
  }

  private getInitialArrayValue(opt: RcConfigOption): string[] {
    if (opt.Type === 'CommaSepList') return this.splitToArray(opt.ValueStr || opt.DefaultStr, ',');
    if (opt.Type === 'SpaceSepList')
      return this.splitToArray(opt.ValueStr || opt.DefaultStr, /\s+/);
    if (Array.isArray(opt.Value) && opt.Value.length > 0)
      return opt.Value.filter((v): v is string => !!v);
    if (Array.isArray(opt.Default) && opt.Default.length > 0)
      return (opt.Default as unknown[]).filter((v): v is string => !!v);
    return [];
  }

  private getInitialValue(opt: RcConfigOption): unknown {
    if (opt.Type === 'bool')
      return opt.Value === true || String(opt.Value).toLowerCase() === 'true';

    if (opt.Type === 'Encoding' || opt.Type === 'Bits' || opt.Type === 'DumpFlags') {
      if (this.isBitsWithCombos(opt)) {
        return opt.ValueStr || opt.DefaultStr || '';
      }
      if (opt.Type === 'Bits' && !opt.Examples?.length) {
        return typeof opt.Value === 'number'
          ? opt.ValueStr || opt.DefaultStr || ''
          : (opt.Value || opt.ValueStr || opt.DefaultStr || '').toString();
      }
      const str =
        typeof opt.Value === 'number'
          ? opt.ValueStr || opt.DefaultStr || ''
          : (opt.Value || opt.ValueStr || opt.DefaultStr || '').toString();
      return this.splitToArray(str, ',');
    }

    if (this.CONVERTIBLE_TYPES.includes(opt.Type)) {
      return typeof opt.Value === 'number'
        ? this.valueMapper.machineToHuman(opt.Value, opt.Type, opt.ValueStr)
        : opt.ValueStr || opt.DefaultStr || '';
    }
    if (opt.Type === 'Tristate') return this.valueMapper.parseTristate(opt.Value ?? opt.ValueStr);
    return opt.ValueStr || opt.DefaultStr || '';
  }

  private isBitsWithCombos(opt: RcConfigOption | null): boolean {
    return opt?.Type === 'Bits' && !!opt.Examples?.some(ex => ex.Value.includes(','));
  }

  readonly hasBitsComboExamples = computed(() => this.isBitsWithCombos(this.mergedOption()));

  private subscribeToChanges(): void {
    const ctrl = this.control();
    if (!ctrl) return;

    this.controlSubscriptions.add(
      ctrl.valueChanges.subscribe(value => {
        this.onChange(this.prepareValueForBackend(value));
        this.onTouched();
        const changed = !this.valuesEqual(ctrl.value, this.uiDefaultValue());
        this.isValueChanged.set(changed);
        this.valueChanged.emit(changed);
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

  private updateSplitFromControl(value: unknown): void {
    if (!value || typeof value !== 'string') {
      this.dateControl().setValue(null, { emitEvent: false });
      this.timeControl().setValue(null, { emitEvent: false });
      return;
    }

    const match = value.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}(?::\d{2})?).*/);
    if (!match) return;

    const [y, m, d] = match[1].split('-').map(Number);
    const timeMatch = match[2].match(/^(\d{2}):(\d{2})/);
    const hh = timeMatch ? Number(timeMatch[1]) : 0;
    const mm = timeMatch ? Number(timeMatch[2]) : 0;

    this.dateControl().setValue(new Date(y, m - 1, d), { emitEvent: false });
    this.timeControl().setValue(new Date(1970, 0, 1, hh, mm), { emitEvent: false });
  }

  private combineDateTime(): string | null {
    const d = this.dateControl().value;
    const t = this.timeControl().value;
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(t?.getHours() ?? 0)}:${pad(t?.getMinutes() ?? 0)}:00Z`;
  }

  private prepareValueForBackend(value: unknown): unknown {
    const opt = this.mergedOption();
    if (!opt) return value;

    return this.valueMapper.humanToMachine(value, opt.Type);
  }
  // Array controls

  addArrayItem(): void {
    const ctrl = this.control();
    if (!(ctrl instanceof FormArray)) return;
    ctrl.push(new FormControl(''));
    this.syncFormArrayControls(ctrl);
  }

  removeArrayItem(i: number): void {
    const ctrl = this.control();
    if (!(ctrl instanceof FormArray)) return;
    ctrl.removeAt(i);
    this.syncFormArrayControls(ctrl);
    this.commitValue();
  }

  // Validators

  private getValidators(opt: RcConfigOption): ValidatorFn[] {
    const validators: ValidatorFn[] = [];
    if (opt.Required) validators.push(Validators.required);

    const r = this.validatorRegistry;
    const vMap: Record<string, () => ValidatorFn> = {
      stringArray: () => r.arrayValidator(),
      CommaSepList: () => r.arrayValidator(),
      SpaceSepList: () => r.arrayValidator(),
      int: () => r.integerValidator(opt.DefaultStr),
      int64: () => r.integerValidator(opt.DefaultStr),
      int32: () => r.integerValidator(opt.DefaultStr),
      uint: () => r.integerValidator(opt.DefaultStr),
      uint32: () => r.integerValidator(opt.DefaultStr),
      uint64: () => r.integerValidator(opt.DefaultStr),
      float: () => r.floatValidator(opt.DefaultStr),
      float32: () => r.floatValidator(opt.DefaultStr),
      float64: () => r.floatValidator(opt.DefaultStr),
      Duration: () => r.durationValidator(opt.DefaultStr),
      SizeSuffix: () => r.sizeSuffixValidator(opt.DefaultStr),
      BwTimetable: () => r.bwTimetableValidator(opt.DefaultStr),
      FileMode: () => r.fileModeValidator(opt.DefaultStr),
      Time: () => r.timeValidator(opt.DefaultStr),
      Bits: () =>
        opt.Examples?.length && !this.isBitsWithCombos(opt)
          ? r.arrayValidator()
          : Validators.nullValidator,
      Encoding: () => r.arrayValidator(),
      Tristate: () => r.tristateValidator(),
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
      validators.push(r.enumValidator(opt.Examples.map(e => e.Value)));
    }

    return validators;
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
      if (errors[key]?.message) return errors[key].message!;
    }
    return this.translate.instant('shared.settingControl.errors.invalidValue');
  }

  getSelectedLabel(value: unknown, examples?: any[]): string {
    if (value === null || value === undefined || value === '') return '';
    const example = examples?.find(e => (e.Value ?? e) === value);
    return example?.Help || example?.Value || String(value);
  }
}
