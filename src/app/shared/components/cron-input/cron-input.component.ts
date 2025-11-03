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
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatTimepickerModule } from '@angular/material/timepicker';
import { provideNativeDateAdapter } from '@angular/material/core';
import { Subject, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs';
import { SchedulerService } from '@app/services';
import { CronValidationResponse } from '@app/types';

@Component({
  selector: 'app-cron-input',
  standalone: true,
  providers: [provideNativeDateAdapter()],
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
    MatDatepickerModule,
    MatTimepickerModule,
  ],
  templateUrl: './cron-input.component.html',
  styleUrls: ['./cron-input.component.scss'],
})
export class CronInputComponent implements OnInit, OnDestroy, OnChanges {
  @Input() initialValue?: string | null;
  @Input() taskName = 'this task';
  @Output() cronChange = new EventEmitter<string | null>();
  @Output() validationChange = new EventEmitter<CronValidationResponse>();

  private readonly schedulerService = inject(SchedulerService);
  private readonly destroy$ = new Subject<void>();

  cronControl = new FormControl<string>('', [Validators.required]);
  validationResponse: CronValidationResponse | null = null;
  validationError = '';
  userTimezone = this.getUserTimezoneOffset();

  // Visual builder form
  visualForm = new FormGroup({
    frequency: new FormControl<string>('daily'),
    time: new FormControl<Date>(this.getMidnight()),
    dayOfWeek: new FormControl<string>('0'),
    dayOfMonth: new FormControl<number>(1),
    intervalHours: new FormControl<number>(6),
  });

  daysOfMonth = Array.from({ length: 31 }, (_, i) => i + 1);

  private getUserTimezoneOffset(): string {
    const offset = -new Date().getTimezoneOffset();
    const hours = Math.floor(Math.abs(offset) / 60);
    const minutes = Math.abs(offset) % 60;
    const sign = offset >= 0 ? '+' : '-';
    return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialValue']) {
      const value = changes['initialValue'].currentValue;
      if (value !== this.cronControl.value) {
        this.cronControl.setValue(value || '', { emitEvent: false });
        if (!value) {
          this.validationResponse = null;
        }
      }
    }
  }

  ngOnInit(): void {
    if (this.initialValue) {
      console.log('Initializing cron input with value:', this.initialValue);
      this.cronControl.setValue(this.initialValue);
    }

    this.cronControl.valueChanges
      .pipe(debounceTime(500), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(async value => {
        if (value && value.trim()) {
          await this.validateCron(value.trim());
        } else {
          this.validationResponse = null;
          this.cronControl.setErrors(null);
          this.cronChange.emit(null);
          this.validationChange.emit({ isValid: true }); // Empty is valid (no error)
        }
      });

    setTimeout(() => {
      this.visualForm.valueChanges
        .pipe(debounceTime(300), takeUntil(this.destroy$))
        .subscribe(() => {
          this.generateCronFromVisualForm();
        });
    }, 0);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private createTime(hour: number, minute: number): Date {
    const date = new Date();
    date.setHours(hour, minute, 0, 0);
    return date;
  }

  applyVisualPreset(preset: 'hourly' | 'daily' | 'weekly'): void {
    switch (preset) {
      case 'hourly':
        this.visualForm.patchValue({
          frequency: 'custom',
          time: this.createTime(0, 0),
          intervalHours: 1,
        });
        break;
      case 'daily':
        this.visualForm.patchValue({
          frequency: 'daily',
          time: this.createTime(2, 0),
        });
        break;
      case 'weekly':
        this.visualForm.patchValue({
          frequency: 'weekly',
          time: this.createTime(3, 0),
          dayOfWeek: '0',
        });
        break;
    }
  }

  private async validateCron(expression: string): Promise<void> {
    try {
      const response = await this.schedulerService.validateCron(expression);
      this.validationResponse = response;

      this.cronChange.emit(expression);

      if (response.isValid) {
        this.cronControl.setErrors(null);
        this.validationChange.emit(response);
      } else {
        this.validationError = response.errorMessage || 'Invalid cron expression';
        this.cronControl.setErrors({ invalidCron: true });

        this.validationChange.emit(response);
      }
    } catch (error) {
      console.error('Failed to validate cron:', error);
      this.validationError = 'Failed to validate cron expression';
      this.cronControl.setErrors({ invalidCron: true });

      this.cronChange.emit(expression);
      this.validationChange.emit({
        isValid: false,
        errorMessage: 'Failed to validate cron expression',
      });
    }
  }

  generateCronFromVisualForm(): void {
    const frequency = this.visualForm.get('frequency')?.value;
    const time = this.visualForm.get('time')?.value;
    const dayOfWeek = this.visualForm.get('dayOfWeek')?.value;
    const dayOfMonth = this.visualForm.get('dayOfMonth')?.value;
    const intervalHours = this.visualForm.get('intervalHours')?.value;

    const safeTime = time || new Date(new Date().setHours(0, 0, 0, 0));
    // Use local time instead of UTC - users expect cron to run in their local timezone
    const hours = safeTime.getHours();
    const minutes = safeTime.getMinutes();

    let cronExpression = '';

    switch (frequency) {
      case 'daily':
        cronExpression = `${minutes} ${hours} * * *`;
        break;
      case 'weekly':
        cronExpression = `${minutes} ${hours} * * ${dayOfWeek}`;
        break;
      case 'monthly':
        cronExpression = `${minutes} ${hours} ${dayOfMonth} * *`;
        break;
      case 'custom':
        cronExpression = `${minutes} */${intervalHours} * * *`;
        break;
      default:
        this.cronControl.setValue(null);
        return;
    }
    this.cronControl.setValue(cronExpression);
  }

  formatNextRun(dateString: string): string {
    try {
      const date = new Date(dateString);
      const now = new Date();
      let delta = (date.getTime() - now.getTime()) / 1000;

      if (delta < 0) {
        return `in the past (${date.toLocaleString()})`;
      }
      if (delta < 60) {
        return `in less than a minute (${date.toLocaleString()})`;
      }

      const days = Math.floor(delta / 86400);
      delta -= days * 86400;
      const hours = Math.floor(delta / 3600) % 24;
      delta -= hours * 3600;
      const minutes = Math.floor(delta / 60) % 60;

      let relativeTime = 'in ';
      if (days > 0) {
        relativeTime += `${days} day(s)`;
        if (hours > 0) relativeTime += `, ${hours} hour(s)`;
      } else if (hours > 0) {
        relativeTime += `${hours} hour(s)`;
        if (minutes > 0) relativeTime += `, ${minutes} minute(s)`;
      } else if (minutes > 0) {
        relativeTime += `${minutes} minute(s)`;
      } else {
        relativeTime = 'soon';
      }

      return `${relativeTime} (${date.toLocaleString()})`;
    } catch {
      return dateString;
    }
  }

  private getMidnight(): Date {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return midnight;
  }
}
