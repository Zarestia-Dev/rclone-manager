import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnDestroy,
  OnChanges,
  SimpleChanges,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
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
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatTooltipModule,
    MatTabsModule,
    MatSelectModule,
    MatButtonModule,
    NgxMatTimepickerModule,
  ],
  templateUrl: './cron-input.component.html',
  styleUrls: ['./cron-input.component.scss'],
})
export class CronInputComponent implements OnInit, OnDestroy, OnChanges {
  @Input() initialValue?: string | null;
  @Input() taskName: string | null = null;
  @Output() cronChange = new EventEmitter<string | null>();
  @Output() validationChange = new EventEmitter<CronValidationResponse>();

  private readonly schedulerService = inject(SchedulerService);
  private readonly destroy$ = new Subject<void>();
  private isInternalUpdate = false;

  cronControl = new FormControl<string>('', [Validators.required]);
  validationResponse: CronValidationResponse | null = null;
  validationError = '';
  userTimezone = this.getUserTimezoneOffset();
  selectedPreset: PresetKey | null = null;

  // Simple form for user-friendly building
  simpleForm = new FormGroup({
    frequency: new FormControl<string>('daily', { nonNullable: true }),
    time: new FormControl<string>('09:00', { nonNullable: true }),
    dayOfWeek: new FormControl<string>('1', { nonNullable: true }),
    dayOfMonth: new FormControl<number>(1, { nonNullable: true }),
    intervalHours: new FormControl<number>(6, { nonNullable: true }),
  });

  // Advanced form for power users
  advancedForm = new FormGroup({
    minute: new FormControl<string>('0', { nonNullable: true }),
    hour: new FormControl<string>('0', { nonNullable: true }),
    dayOfMonth: new FormControl<string>('*', { nonNullable: true }),
    month: new FormControl<string>('*', { nonNullable: true }),
    dayOfWeek: new FormControl<string>('*', { nonNullable: true }),
  });

  readonly daysOfMonth = Array.from({ length: 31 }, (_, i) => i + 1);

  readonly presetOptions: {
    key: PresetKey;
    title: string;
    description: string;
    cron: string;
  }[] = [
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

  private getUserTimezoneOffset(): string {
    const offset = -new Date().getTimezoneOffset();
    const hours = Math.floor(Math.abs(offset) / 60);
    const minutes = Math.abs(offset) % 60;
    const sign = offset >= 0 ? '+' : '-';
    return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (
      changes['initialValue'] &&
      changes['initialValue'].currentValue !== this.cronControl.value
    ) {
      const value = changes['initialValue'].currentValue;

      if (value) {
        try {
          this.cronControl.setValue(value, { emitEvent: false });
          this.syncFormsFromCron(value);
          this.validateCron(value);
        } catch (error) {
          console.error('Failed to initialize cron value:', error);
          this.cronControl.setValue(value, { emitEvent: false });
        }
      } else {
        this.cronControl.setValue('', { emitEvent: false });
        this.validationResponse = { isValid: true };
      }
    }
  }

  ngOnInit(): void {
    if (this.initialValue) {
      this.cronControl.setValue(this.initialValue);
    }

    this.setupCronControlSubscription();
    this.setupAdvancedFormSubscription();
    this.setupSimpleFormSubscription();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private setupCronControlSubscription(): void {
    this.cronControl.valueChanges
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(async value => {
        const trimmedValue = value?.trim();
        if (trimmedValue) {
          if (!this.isInternalUpdate) {
            this.syncFormsFromCron(trimmedValue);
          }
          await this.validateCron(trimmedValue);
        } else {
          this.resetValidation();
        }
      });
  }

  private syncFormsFromCron(cron: string): void {
    // 1. Check for a matching preset
    const matchingPreset = this.presetOptions.find(p => p.cron === cron);
    this.selectedPreset = matchingPreset ? matchingPreset.key : null;

    // 2. Sync the advanced form
    const parts = cron.split(' ');
    if (parts.length === 5) {
      this.isInternalUpdate = true; // Prevent feedback loop
      try {
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

        // 3. Sync the simple form
        this.syncSimpleForm(parts);
      } catch (e) {
        console.error('Error syncing forms from cron:', e);
      } finally {
        setTimeout(() => (this.isInternalUpdate = false), 0);
      }
    }
  }

  /**
   * Tries to parse a 5-part cron array into the simple form.
   */
  private syncSimpleForm(parts: string[]): void {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const isNumeric = (val: string): boolean => /^\d+$/.test(val);

    try {
      // Pattern 1: Interval (e.g., 0 */6 * * *)
      if (
        minute === '0' &&
        hour.startsWith('*/') &&
        dayOfMonth === '*' &&
        month === '*' &&
        dayOfWeek === '*'
      ) {
        const interval = parseInt(hour.split('/')[1], 10);
        this.simpleForm.patchValue(
          {
            frequency: 'interval',
            intervalHours: interval,
          },
          { emitEvent: false }
        );
      }
      // Pattern 2: Monthly (e.g., 0 9 1 * *)
      else if (
        isNumeric(minute) &&
        isNumeric(hour) &&
        isNumeric(dayOfMonth) &&
        month === '*' &&
        dayOfWeek === '*'
      ) {
        const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
        this.simpleForm.patchValue(
          {
            frequency: 'monthly',
            time: time,
            dayOfMonth: parseInt(dayOfMonth, 10),
          },
          { emitEvent: false }
        );
      }
      // Pattern 3: Weekly (e.g., 0 9 * * 1)
      else if (
        isNumeric(minute) &&
        isNumeric(hour) &&
        dayOfMonth === '*' &&
        month === '*' &&
        (isNumeric(dayOfWeek) || dayOfWeek === '1-5')
      ) {
        const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
        this.simpleForm.patchValue(
          {
            frequency: 'weekly',
            time: time,
            dayOfWeek: dayOfWeek, // '1' or '1-5' etc.
          },
          { emitEvent: false }
        );
      }
      // Pattern 4: Daily (e.g., 0 9 * * *)
      else if (
        isNumeric(minute) &&
        isNumeric(hour) &&
        dayOfMonth === '*' &&
        month === '*' &&
        dayOfWeek === '*'
      ) {
        const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
        this.simpleForm.patchValue(
          {
            frequency: 'daily',
            time: time,
          },
          { emitEvent: false }
        );
      }
    } catch (e) {
      console.error('Failed to sync simple form:', e);
    }
  }

  private setupAdvancedFormSubscription(): void {
    this.advancedForm.valueChanges
      .pipe(debounceTime(100), takeUntil(this.destroy$))
      .subscribe(() => {
        if (!this.isInternalUpdate) {
          this.selectedPreset = null;
          this.generateCronFromAdvancedForm();
        }
      });
  }

  private setupSimpleFormSubscription(): void {
    this.simpleForm.valueChanges.pipe(debounceTime(100), takeUntil(this.destroy$)).subscribe(() => {
      if (!this.isInternalUpdate) {
        this.selectedPreset = null;
        this.generateCronFromSimpleForm();
      }
    });
  }

  private resetValidation(): void {
    this.validationResponse = null;
    this.cronControl.setErrors(null);
    this.cronChange.emit(null);
    this.validationChange.emit({ isValid: true });
  }

  applyPreset(key: PresetKey, cron: string): void {
    this.selectedPreset = key;
    this.isInternalUpdate = true;
    this.cronControl.setValue(cron);
    this.syncFormsFromCron(cron);
  }

  onSimpleFormChange(): void {
    if (!this.isInternalUpdate) {
      this.selectedPreset = null;
      this.generateCronFromSimpleForm();
    }
  }

  private generateCronFromSimpleForm(): void {
    const formValue = this.simpleForm.getRawValue();
    const { hours, minutes } = this.parseTime(formValue.time);

    let cronExpression = '';
    switch (formValue.frequency) {
      case 'daily':
        cronExpression = `${minutes} ${hours} * * *`;
        break;
      case 'weekly':
        cronExpression = `${minutes} ${hours} * * ${formValue.dayOfWeek}`;
        break;
      case 'monthly':
        cronExpression = `${minutes} ${hours} ${formValue.dayOfMonth} * *`;
        break;
      case 'interval':
        cronExpression = `0 */${formValue.intervalHours} * * *`;
        break;
      default:
        return;
    }

    this.cronControl.setValue(cronExpression, { emitEvent: true });
  }

  private generateCronFromAdvancedForm(): void {
    const formValue = this.advancedForm.getRawValue();
    const cronExpression = [
      formValue.minute,
      formValue.hour,
      formValue.dayOfMonth,
      formValue.month,
      formValue.dayOfWeek,
    ].join(' ');

    this.cronControl.setValue(cronExpression, { emitEvent: true });
  }

  private parseTime(timeString: string): { hours: number; minutes: number } {
    const timeParts = timeString.split(':');
    let hours = parseInt(timeParts[0], 10) || 0;
    let minutes = 0;

    if (timeParts.length >= 2) {
      const minutePart = timeParts[1].split(' ')[0];
      minutes = parseInt(minutePart, 10) || 0;

      // Handle 12-hour format
      const isPM = timeString.toLowerCase().includes('pm');
      const isAM = timeString.toLowerCase().includes('am');

      if (isPM && hours < 12) {
        hours += 12;
      } else if (isAM && hours === 12) {
        hours = 0;
      }
    }

    // Ensure valid ranges
    hours = Math.max(0, Math.min(23, hours));
    minutes = Math.max(0, Math.min(59, minutes));

    return { hours, minutes };
  }

  private async validateCron(expression: string): Promise<void> {
    try {
      const response = await this.schedulerService.validateCron(expression);
      this.validationResponse = response;

      if (response.isValid) {
        this.cronControl.setErrors(null);
      } else {
        this.validationError = response.errorMessage || 'Invalid cron expression';
        this.cronControl.setErrors({ invalidCron: true });
      }

      this.cronChange.emit(expression);
      this.validationChange.emit(response);
    } catch (error) {
      console.error('Failed to validate cron:', error);
      this.handleValidationError(expression);
    }
  }

  private handleValidationError(expression: string): void {
    this.validationError = 'Failed to validate cron expression';
    this.cronControl.setErrors({ invalidCron: true });
    this.cronChange.emit(expression);
    this.validationChange.emit({
      isValid: false,
      errorMessage: 'Failed to validate cron expression',
    });
  }

  getHumanReadableSchedule(): string {
    const cron = this.cronControl.value?.trim();
    if (!cron) {
      return '';
    }

    try {
      return cronstrue(cron);
    } catch (e) {
      console.error('Error parsing cron string with cronstrue:', e);
      return cron;
    }
  }

  formatNextRun(dateString: string | null): string {
    if (!dateString) return 'Unknown';

    try {
      const date = new Date(dateString);

      // Validate date
      if (isNaN(date.getTime())) {
        return dateString;
      }

      const now = new Date();
      const deltaSeconds = (date.getTime() - now.getTime()) / 1000;

      if (deltaSeconds < 0) {
        return `in the past (${date.toLocaleString()})`;
      }

      const relativeTime = this.formatRelativeTime(deltaSeconds);
      return `${relativeTime} (${date.toLocaleString()})`;
    } catch {
      return dateString;
    }
  }

  private formatRelativeTime(seconds: number): string {
    if (seconds < 60) {
      return 'in less than a minute';
    }

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) {
      parts.push(`${days} day${days > 1 ? 's' : ''}`);
      if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    } else if (hours > 0) {
      parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
      if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    } else {
      parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    }

    return `in ${parts.join(', ')}`;
  }
}
