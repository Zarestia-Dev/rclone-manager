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
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatButtonModule } from '@angular/material/button';
import { NgxMatTimepickerModule } from 'ngx-mat-timepicker';
import { Subject, distinctUntilChanged, takeUntil } from 'rxjs';
import { SchedulerService } from '@app/services';
import { CronValidationResponse } from '@app/types';

type PresetType =
  | 'every-minute'
  | 'every-5-min'
  | 'every-15-min'
  | 'every-30-min'
  | 'hourly'
  | 'every-2-hours'
  | 'every-6-hours'
  | 'daily'
  | 'weekly'
  | 'monthly';

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
    MatCheckboxModule,
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

  visualForm = new FormGroup({
    frequency: new FormControl<string>('daily', { nonNullable: true }),
    time: new FormControl<string>('00:00', { nonNullable: true }),
    dayOfWeek: new FormControl<string>('0', { nonNullable: true }),
    dayOfMonth: new FormControl<number>(1, { nonNullable: true }),
    intervalHours: new FormControl<number>(6, { nonNullable: true }),
  });

  advancedForm = new FormGroup({
    minute: new FormControl<string>('0', { nonNullable: true }),
    hour: new FormControl<string>('0', { nonNullable: true }),
    dayOfMonth: new FormControl<string>('*', { nonNullable: true }),
    month: new FormControl<string>('*', { nonNullable: true }),
    dayOfWeek: new FormControl<string>('*', { nonNullable: true }),
  });

  readonly daysOfMonth = Array.from({ length: 31 }, (_, i) => i + 1);

  private readonly presetMap: Record<PresetType, string> = {
    'every-minute': '* * * * *',
    'every-5-min': '*/5 * * * *',
    'every-15-min': '*/15 * * * *',
    'every-30-min': '*/30 * * * *',
    hourly: '0 * * * *',
    'every-2-hours': '0 */2 * * *',
    'every-6-hours': '0 */6 * * *',
    daily: '0 2 * * *',
    weekly: '0 3 * * 0',
    monthly: '0 0 1 * *',
  };

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
      this.cronControl.setValue(value || '', { emitEvent: false });
      this.validationResponse = value ? null : { isValid: true };
    }
  }

  ngOnInit(): void {
    if (this.initialValue) {
      this.cronControl.setValue(this.initialValue);
    }

    this.setupCronControlSubscription();
    this.setupFormSubscriptions();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private setupCronControlSubscription(): void {
    this.cronControl.valueChanges
      .pipe(distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(async value => {
        const trimmedValue = value?.trim();
        if (trimmedValue) {
          await this.validateCron(trimmedValue);
        } else {
          this.resetValidation();
        }
      });
  }

  private setupFormSubscriptions(): void {
    this.visualForm.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(() => {
      if (!this.isInternalUpdate) {
        this.generateCronFromVisualForm();
      }
    });

    this.advancedForm.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(() => {
      if (!this.isInternalUpdate) {
        this.generateCronFromAdvancedForm();
      }
    });
  }

  private resetValidation(): void {
    this.validationResponse = null;
    this.cronControl.setErrors(null);
    this.cronChange.emit(null);
    this.validationChange.emit({ isValid: true });
  }

  applyVisualPreset(preset: PresetType): void {
    const cronExpression = this.presetMap[preset];
    if (cronExpression) {
      this.isInternalUpdate = true;
      this.cronControl.setValue(cronExpression);
      // Reset flag after Angular change detection cycle
      setTimeout(() => (this.isInternalUpdate = false), 0);
    }
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

  private generateCronFromVisualForm(): void {
    const formValue = this.visualForm.getRawValue();
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
      case 'custom':
        cronExpression = `${minutes} */${formValue.intervalHours} * * *`;
        break;
      default:
        return;
    }

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
