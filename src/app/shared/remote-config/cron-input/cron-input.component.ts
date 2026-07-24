import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  effect,
  output,
  DestroyRef,
  signal,
  computed,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatNativeDateModule, provideNativeDateAdapter } from '@angular/material/core';
import { MatTimepickerModule } from '@angular/material/timepicker';
import {
  catchError,
  distinctUntilChanged,
  filter,
  from,
  map,
  of,
  startWith,
  switchMap,
  tap,
} from 'rxjs';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { CronValidationResponse } from '@app/types';
import { toString as cronstrue } from 'cronstrue';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { getCronstrueLocale } from 'src/app/services/i18n/cron-locale.mapper';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';

export type PresetKey =
  'daily-9am' | 'daily-6pm' | 'weekday-9am' | 'weekly-monday' | 'every-6-hours' | 'monthly-1st';

export interface PresetOption {
  key: PresetKey;
  cron: string;
}

export interface MonthOption {
  value: string;
  labelKey: string;
}

export const PRESET_OPTIONS: PresetOption[] = [
  { key: 'daily-9am', cron: '0 9 * * *' },
  { key: 'daily-6pm', cron: '0 18 * * *' },
  { key: 'weekday-9am', cron: '0 9 * * 1-5' },
  { key: 'weekly-monday', cron: '0 9 * * 1' },
  { key: 'every-6-hours', cron: '0 */6 * * *' },
  { key: 'monthly-1st', cron: '0 0 1 * *' },
];

export const MONTH_OPTIONS: MonthOption[] = [
  { value: '1', labelKey: 'january' },
  { value: '2', labelKey: 'february' },
  { value: '3', labelKey: 'march' },
  { value: '4', labelKey: 'april' },
  { value: '5', labelKey: 'may' },
  { value: '6', labelKey: 'june' },
  { value: '7', labelKey: 'july' },
  { value: '8', labelKey: 'august' },
  { value: '9', labelKey: 'september' },
  { value: '10', labelKey: 'october' },
  { value: '11', labelKey: 'november' },
  { value: '12', labelKey: 'december' },
];

@Component({
  selector: 'app-cron-input',
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatTooltipModule,
    MatTabsModule,
    MatSelectModule,
    MatButtonModule,
    MatNativeDateModule,
    MatTimepickerModule,
    TranslatePipe,
    AlertBannerComponent,
  ],
  templateUrl: './cron-input.component.html',
  styleUrls: ['./cron-input.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideNativeDateAdapter()],
})
export class CronInputComponent {
  initialValue = input<string | null>(null);
  automationName = input<string | null>(null);
  cronChange = output<string | null>();
  validationChange = output<CronValidationResponse>();

  private readonly automationService = inject(AutomationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  private isUpdatingForms = false;
  readonly cronControl = new FormControl<string>('', { nonNullable: true });

  readonly validationResponse = signal<CronValidationResponse | null>(null);
  readonly validationError = signal<string>('');
  readonly selectedPreset = signal<PresetKey | null>(null);

  readonly simpleForm = new FormGroup({
    frequency: new FormControl<string>('daily', { nonNullable: true }),
    time: new FormControl<Date | null>(new Date(1970, 0, 1, 9, 0, 0)),
    dayOfWeek: new FormControl<string>('1', { nonNullable: true }),
    dayOfMonth: new FormControl<number>(1, { nonNullable: true }),
    intervalHours: new FormControl<number>(6, { nonNullable: true }),
  });

  readonly advancedForm = new FormGroup({
    minute: new FormControl<string>('0', { nonNullable: true }),
    hour: new FormControl<string>('0', { nonNullable: true }),
    dayOfMonth: new FormControl<string>('*', { nonNullable: true }),
    month: new FormControl<string>('*', { nonNullable: true }),
    dayOfWeek: new FormControl<string>('*', { nonNullable: true }),
  });

  readonly cronValue = toSignal(
    this.cronControl.valueChanges.pipe(startWith(this.cronControl.value)),
    { initialValue: '' }
  );

  readonly simpleFrequency = toSignal(
    this.simpleForm.controls.frequency.valueChanges.pipe(
      startWith(this.simpleForm.controls.frequency.value)
    ),
    { initialValue: 'daily' }
  );

  readonly humanReadableSchedule = computed(() => {
    const cron = this.cronValue()?.trim();
    if (!cron) return '';
    try {
      const locale = getCronstrueLocale(this.translate.getCurrentLang() ?? 'en-US');
      return cronstrue(cron, { locale });
    } catch {
      return cron;
    }
  });

  readonly userTimezone = this.getUserTimezoneFormatted();
  readonly daysOfMonth = Array.from({ length: 31 }, (_, i) => i + 1);
  readonly presetOptions = PRESET_OPTIONS;
  readonly monthOptions = MONTH_OPTIONS;

  constructor() {
    // 1. Sync input signal updates to cron control
    effect(() => {
      const val = this.initialValue() || '';
      if (val !== this.cronControl.value) {
        this.updateCronSourceOfTruth(val, false);
      }
    });

    // 2. React to cron control changes (Source of Truth)
    this.cronControl.valueChanges
      .pipe(
        startWith(this.cronControl.value),
        map(value => value?.trim() || ''),
        distinctUntilChanged(),
        tap(trimmed => {
          if (trimmed) {
            if (!this.isUpdatingForms) {
              this.syncViewsFromCron(trimmed);
            }
          } else {
            this.resetValidation();
          }
        }),
        filter(trimmed => trimmed.length > 0),
        switchMap(expression =>
          from(this.automationService.validateCron(expression)).pipe(
            map(result => ({ expression, result })),
            catchError(error => {
              console.error('Cron validation failed', error);
              return of({
                expression,
                result: {
                  isValid: false,
                  errorMessage: 'Validation request failed',
                } as CronValidationResponse,
              });
            })
          )
        ),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(({ expression, result }) => {
        this.applyValidationResult(expression, result);
      });

    // 3. Sub-form change subscriptions
    this.simpleForm.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (!this.isUpdatingForms) this.updateFromSimpleForm();
    });

    this.advancedForm.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (!this.isUpdatingForms) this.updateFromAdvancedForm();
    });
  }

  // ===================================
  // Core Synchronization Logic
  // ===================================

  private updateCronSourceOfTruth(newValue: string | null, emitEvent: boolean): void {
    const validValue = newValue || '';
    this.setCronControlValue(validValue, emitEvent);

    if (!this.isUpdatingForms) {
      this.syncViewsFromCron(validValue);
    }
  }

  private setCronControlValue(value: string, emitEvent = true): void {
    if (this.cronControl.value !== value) {
      this.cronControl.setValue(value, { emitEvent });
    }
  }

  private syncViewsFromCron(cron: string): void {
    this.isUpdatingForms = true;
    try {
      // Match preset option
      const preset = this.presetOptions.find(p => p.cron === cron);
      this.selectedPreset.set(preset ? preset.key : null);

      // Parse standard 5-part cron syntax
      const parts = cron.split(' ');
      if (parts.length === 5) {
        this.advancedForm.setValue(
          {
            minute: parts[0],
            hour: parts[1],
            dayOfMonth: parts[2],
            month: parts[3],
            dayOfWeek: parts[4],
          },
          { emitEvent: false }
        );

        this.mapCronToSimpleForm(parts);
      }
    } catch (e) {
      console.warn('Error syncing views from cron:', e);
    } finally {
      this.isUpdatingForms = false;
    }
  }

  // ===================================
  // Form Generation Logic
  // ===================================

  private updateFromSimpleForm(): void {
    this.selectedPreset.set(null);
    const { frequency, time, dayOfWeek, dayOfMonth, intervalHours } = this.simpleForm.getRawValue();
    const hours = time instanceof Date ? time.getHours() : 9;
    const minutes = time instanceof Date ? time.getMinutes() : 0;

    let cron = '';
    switch (frequency) {
      case 'daily':
        cron = `${minutes} ${hours} * * *`;
        break;
      case 'weekly':
        cron = `${minutes} ${hours} * * ${dayOfWeek}`;
        break;
      case 'monthly':
        cron = `${minutes} ${hours} ${dayOfMonth} * *`;
        break;
      case 'interval':
        cron = `0 */${intervalHours} * * *`;
        break;
    }

    if (cron) this.setCronControlValue(cron);
  }

  private updateFromAdvancedForm(): void {
    this.selectedPreset.set(null);
    const v = this.advancedForm.getRawValue();
    const cron = `${v.minute} ${v.hour} ${v.dayOfMonth} ${v.month} ${v.dayOfWeek}`;
    this.setCronControlValue(cron);
  }

  applyPreset(key: PresetKey, cron: string): void {
    this.selectedPreset.set(key);
    this.setCronControlValue(cron);
  }

  // ===================================
  // Component Logic: Parsing & Mapping
  // ===================================

  private mapCronToSimpleForm(parts: string[]): void {
    if (parts.length < 5) return;
    const [min, hour, dom, mon, dow] = parts;
    const isNum = (s: string): boolean => /^\d+$/.test(s);

    const setSimple = (vals: Partial<typeof this.simpleForm.value>): void => {
      this.simpleForm.patchValue(vals, { emitEvent: false });
    };

    // 1. Interval (0 */n * * *)
    if (min === '0' && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
      const parsedHours = parseInt(hour.split('/')[1], 10);
      setSimple({ frequency: 'interval', intervalHours: isNaN(parsedHours) ? 6 : parsedHours });
      return;
    }

    // 2. Monthly (m h d * *)
    if (isNum(min) && isNum(hour) && isNum(dom) && mon === '*' && dow === '*') {
      setSimple({
        frequency: 'monthly',
        time: this.buildTimeDate(parseInt(hour, 10), parseInt(min, 10)),
        dayOfMonth: parseInt(dom, 10),
      });
      return;
    }

    // 3. Weekly (m h * * dow)
    if (
      isNum(min) &&
      isNum(hour) &&
      dom === '*' &&
      mon === '*' &&
      (isNum(dow) || dow.includes('-'))
    ) {
      setSimple({
        frequency: 'weekly',
        time: this.buildTimeDate(parseInt(hour, 10), parseInt(min, 10)),
        dayOfWeek: dow,
      });
      return;
    }

    // 4. Daily (m h * * *)
    if (isNum(min) && isNum(hour) && dom === '*' && mon === '*' && dow === '*') {
      setSimple({
        frequency: 'daily',
        time: this.buildTimeDate(parseInt(hour, 10), parseInt(min, 10)),
      });
      return;
    }
  }

  private buildTimeDate(hours: number, minutes: number): Date {
    return new Date(1970, 0, 1, hours, minutes, 0);
  }

  private getUserTimezoneFormatted(): string {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = -new Date().getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const hours = pad(Math.floor(Math.abs(offset) / 60));
    const mins = pad(Math.abs(offset) % 60);
    return `${timeZone} (UTC${sign}${hours}:${mins})`;
  }

  // ===================================
  // Validation & Formatting Helpers
  // ===================================

  private applyValidationResult(expression: string, result: CronValidationResponse): void {
    this.validationResponse.set(result);
    this.validationError.set(
      result.isValid ? '' : result.errorMessage || 'Invalid cron expression'
    );
    this.cronControl.setErrors(result.isValid ? null : { invalidCron: true });
    this.cronChange.emit(expression);
    this.validationChange.emit(result);
  }

  private resetValidation(): void {
    this.validationResponse.set(null);
    this.validationChange.emit({ isValid: false });
    this.cronChange.emit(null);
  }

  formatNextRun(dateString: string | null): string {
    if (!dateString) return '';
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return dateString;

      const delta = (date.getTime() - Date.now()) / 1000;
      if (delta < 0) {
        return this.translate.instant('wizards.appOperation.relativeTime.inPast', {
          date: date.toLocaleString(),
        });
      }

      return (
        this.translate.instant('wizards.appOperation.relativeTime.in', {
          time: this.formatRelativeTime(delta),
        }) + ` (${date.toLocaleString()})`
      );
    } catch {
      return dateString;
    }
  }

  private formatRelativeTime(seconds: number): string {
    if (seconds < 60)
      return this.translate.instant('wizards.appOperation.relativeTime.lessThanMinute');

    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);

    const t = (key: string, count: number): string => this.translate.instant(key, { count });

    const parts: string[] = [];
    if (d > 0) {
      parts.push(
        t(
          d === 1
            ? 'wizards.appOperation.relativeTime.days.one'
            : 'wizards.appOperation.relativeTime.days.other',
          d
        )
      );
      if (h > 0) {
        parts.push(
          t(
            h === 1
              ? 'wizards.appOperation.relativeTime.hours.one'
              : 'wizards.appOperation.relativeTime.hours.other',
            h
          )
        );
      }
    } else if (h > 0) {
      parts.push(
        t(
          h === 1
            ? 'wizards.appOperation.relativeTime.hours.one'
            : 'wizards.appOperation.relativeTime.hours.other',
          h
        )
      );
      if (m > 0) {
        parts.push(
          t(
            m === 1
              ? 'wizards.appOperation.relativeTime.minutes.one'
              : 'wizards.appOperation.relativeTime.minutes.other',
            m
          )
        );
      }
    } else {
      parts.push(
        t(
          m === 1
            ? 'wizards.appOperation.relativeTime.minutes.one'
            : 'wizards.appOperation.relativeTime.minutes.other',
          m
        )
      );
    }
    return parts.join(', ');
  }
}
