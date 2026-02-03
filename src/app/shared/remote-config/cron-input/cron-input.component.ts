import { Component, Output, EventEmitter, OnDestroy, inject, input, effect } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { NgxMatTimepickerModule } from 'ngx-mat-timepicker';
import { Subject, distinctUntilChanged, takeUntil, debounceTime } from 'rxjs';
import { SchedulerService } from '@app/services';
import { CronValidationResponse } from '@app/types';
import { toString as cronstrue } from 'cronstrue';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

type PresetKey =
  | 'daily-9am'
  | 'daily-6pm'
  | 'weekday-9am'
  | 'weekly-monday'
  | 'every-6-hours'
  | 'monthly-1st';

@Component({
  selector: 'app-cron-input',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatTooltipModule,
    MatTabsModule,
    MatSelectModule,
    MatButtonModule,
    NgxMatTimepickerModule,
    TranslateModule,
  ],
  templateUrl: './cron-input.component.html',
  styleUrls: ['./cron-input.component.scss'],
})
export class CronInputComponent implements OnDestroy {
  initialValue = input<string | null>();
  taskName = input<string | null>(null);
  @Output() cronChange = new EventEmitter<string | null>();
  @Output() validationChange = new EventEmitter<CronValidationResponse>();

  private readonly schedulerService = inject(SchedulerService);
  private readonly translate = inject(TranslateService);
  private readonly destroy$ = new Subject<void>();

  private isUpdatingForms = false;
  cronControl = new FormControl<string>('', [Validators.required]);
  validationResponse: CronValidationResponse | null = null;
  validationError = '';
  selectedPreset: PresetKey | null = null;
  userTimezone = this.getUserTimezoneOffset();
  readonly daysOfMonth = Array.from({ length: 31 }, (_, i) => i + 1);

  simpleForm = new FormGroup({
    frequency: new FormControl('daily', { nonNullable: true }),
    time: new FormControl('09:00', { nonNullable: true }),
    dayOfWeek: new FormControl('1', { nonNullable: true }),
    dayOfMonth: new FormControl<number>(1, { nonNullable: true }),
    intervalHours: new FormControl<number>(6, { nonNullable: true }),
  });

  advancedForm = new FormGroup({
    minute: new FormControl('0', { nonNullable: true }),
    hour: new FormControl('0', { nonNullable: true }),
    dayOfMonth: new FormControl('*', { nonNullable: true }),
    month: new FormControl('*', { nonNullable: true }),
    dayOfWeek: new FormControl('*', { nonNullable: true }),
  });

  readonly presetOptions: { key: PresetKey; title: string; description: string; cron: string }[] = [
    {
      key: 'daily-9am',
      title: 'Daily at 9 AM',
      description: 'Every day at 9:00 AM',
      cron: '0 9 * * *',
    },
    {
      key: 'daily-6pm',
      title: 'Daily at 6 PM',
      description: 'Every day at 6:00 PM',
      cron: '0 18 * * *',
    },
    {
      key: 'weekday-9am',
      title: 'Weekdays at 9 AM',
      description: 'Monday-Friday at 9:00 AM',
      cron: '0 9 * * 1-5',
    },
    {
      key: 'weekly-monday',
      title: 'Weekly on Monday',
      description: 'Every Monday at 9:00 AM',
      cron: '0 9 * * 1',
    },
    {
      key: 'every-6-hours',
      title: 'Every 6 hours',
      description: '4 times per day',
      cron: '0 */6 * * *',
    },
    {
      key: 'monthly-1st',
      title: 'First of month',
      description: '1st day at midnight',
      cron: '0 0 1 * *',
    },
  ];

  constructor() {
    // 1. Initialize from Input Signal
    effect(() => {
      const val = this.initialValue() || '';
      if (val !== this.cronControl.value) {
        this.updateCronSourceOfTruth(val, false);
      }
    });

    // 2. Listen to Cron Control Changes (Source of Truth)
    this.cronControl.valueChanges
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(value => this.handleCronChange(value));

    // 3. Listen to Sub-Forms
    this.simpleForm.valueChanges.pipe(debounceTime(100), takeUntil(this.destroy$)).subscribe(() => {
      if (!this.isUpdatingForms) this.updateFromSimpleForm();
    });

    this.advancedForm.valueChanges
      .pipe(debounceTime(100), takeUntil(this.destroy$))
      .subscribe(() => {
        if (!this.isUpdatingForms) this.updateFromAdvancedForm();
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ===================================
  // Core Logic
  // ===================================

  private updateCronSourceOfTruth(newValue: string | null, emitEvent: boolean): void {
    const validValue = newValue || '';

    // Update control
    if (this.cronControl.value !== validValue) {
      this.cronControl.setValue(validValue, { emitEvent });
    }

    // Sync downstream views
    if (!this.isUpdatingForms) {
      this.syncViewsFromCron(validValue);
    }
  }

  private async handleCronChange(value: string | null): Promise<void> {
    const trimmed = value?.trim() || '';

    if (trimmed) {
      if (!this.isUpdatingForms) {
        this.syncViewsFromCron(trimmed);
      }
      await this.validateCron(trimmed);
    } else {
      this.resetValidation();
    }
  }

  private syncViewsFromCron(cron: string): void {
    this.isUpdatingForms = true;
    try {
      // 1. Match Preset
      const preset = this.presetOptions.find(p => p.cron === cron);
      this.selectedPreset = preset ? preset.key : null;

      // 2. Parse into Advanced Form (Standard 5-part cron)
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

        // 3. Try to map to Simple Form
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
    this.selectedPreset = null;
    const { frequency, time, dayOfWeek, dayOfMonth, intervalHours } = this.simpleForm.getRawValue();
    const { hours, minutes } = this.parseTime(time);

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

    if (cron) this.cronControl.setValue(cron);
  }

  private updateFromAdvancedForm(): void {
    this.selectedPreset = null;
    const v = this.advancedForm.getRawValue();
    const cron = `${v.minute} ${v.hour} ${v.dayOfMonth} ${v.month} ${v.dayOfWeek}`;
    this.cronControl.setValue(cron);
  }

  applyPreset(key: PresetKey, cron: string): void {
    this.selectedPreset = key;
    this.cronControl.setValue(cron);
  }

  // ===================================
  // Component Logic: Parsing & Mapping
  // ===================================

  onSimpleFormChange(): void {
    // Triggered by timepicker
    this.updateFromSimpleForm();
  }

  private mapCronToSimpleForm(parts: string[]): void {
    if (parts.length < 5) return;
    const [min, hour, dom, mon, dow] = parts;
    const isNum = (s: string) => /^\d+$/.test(s);

    // Helper to set simple form without triggering events
    const setSimple = (vals: Partial<typeof this.simpleForm.value>) =>
      this.simpleForm.patchValue(vals, { emitEvent: false });

    // 1. Interval (0 */n * * *)
    if (min === '0' && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
      setSimple({ frequency: 'interval', intervalHours: parseInt(hour.split('/')[1], 10) });
      return;
    }

    // 2. Monthly (m h d * *)
    if (isNum(min) && isNum(hour) && isNum(dom) && mon === '*' && dow === '*') {
      setSimple({
        frequency: 'monthly',
        time: this.formatTime(hour, min),
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
      setSimple({ frequency: 'weekly', time: this.formatTime(hour, min), dayOfWeek: dow });
      return;
    }

    // 4. Daily (m h * * *)
    if (isNum(min) && isNum(hour) && dom === '*' && mon === '*' && dow === '*') {
      setSimple({ frequency: 'daily', time: this.formatTime(hour, min) });
      return;
    }
  }

  private parseTime(timeStr: string): { hours: number; minutes: number } {
    const [hStr, mStr] = timeStr.split(':');
    let h = parseInt(hStr, 10) || 0;
    const m = parseInt(mStr?.split(' ')[0], 10) || 0;

    if (timeStr.toLowerCase().includes('pm') && h < 12) h += 12;
    if (timeStr.toLowerCase().includes('am') && h === 12) h = 0;

    return { hours: Math.max(0, Math.min(23, h)), minutes: Math.max(0, Math.min(59, m)) };
  }

  private formatTime(hour: string, minute: string): string {
    return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  private getUserTimezoneOffset(): string {
    const offset = -new Date().getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  }

  // ===================================
  // Validation & Helpers
  // ===================================

  private async validateCron(expression: string): Promise<void> {
    try {
      const result = await this.schedulerService.validateCron(expression);
      this.validationResponse = result;
      this.validationError = result.isValid ? '' : result.errorMessage || 'Invalid cron expression';
      this.cronControl.setErrors(result.isValid ? null : { invalidCron: true });

      this.cronChange.emit(expression);
      this.validationChange.emit(result);
    } catch (e) {
      console.error('Validation failed', e);
      this.cronControl.setErrors({ invalidCron: true });
    }
  }

  private resetValidation(): void {
    this.validationResponse = null;
    this.cronControl.setErrors(null);
    this.cronChange.emit(null);
    this.validationChange.emit({ isValid: true });
  }

  getHumanReadableSchedule(): string {
    const cron = this.cronControl.value?.trim();
    if (!cron) return '';
    try {
      return cronstrue(cron);
    } catch {
      return cron;
    }
  }

  formatNextRun(dateString: string | null): string {
    if (!dateString) return '';
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return dateString;

      const delta = (date.getTime() - new Date().getTime()) / 1000;
      if (delta < 0)
        return this.translate.instant('wizards.appOperation.relativeTime.inPast', {
          date: date.toLocaleString(),
        });

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
    const t = (key: string, count: number) => this.translate.instant(key, { count });

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
      if (h > 0)
        parts.push(
          t(
            h === 1
              ? 'wizards.appOperation.relativeTime.hours.one'
              : 'wizards.appOperation.relativeTime.hours.other',
            h
          )
        );
    } else if (h > 0) {
      parts.push(
        t(
          h === 1
            ? 'wizards.appOperation.relativeTime.hours.one'
            : 'wizards.appOperation.relativeTime.hours.other',
          h
        )
      );
      if (m > 0)
        parts.push(
          t(
            m === 1
              ? 'wizards.appOperation.relativeTime.minutes.one'
              : 'wizards.appOperation.relativeTime.minutes.other',
            m
          )
        );
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
