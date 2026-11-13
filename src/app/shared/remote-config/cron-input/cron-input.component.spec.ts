import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { CronInputComponent } from './cron-input.component';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { CronValidationResponse } from '@app/types';

describe('CronInputComponent', () => {
  let component: CronInputComponent;
  let fixture: ComponentFixture<CronInputComponent>;
  let automationServiceMock: {
    validateCron: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    automationServiceMock = {
      validateCron: vi.fn().mockReturnValue(of({ isValid: true, nextRun: '2026-10-15T12:00:00Z' })),
    };

    await TestBed.configureTestingModule({
      imports: [CronInputComponent],
      providers: [
        provideTranslateService(),
        { provide: AutomationService, useValue: automationServiceMock },
      ],
    }).compileComponents();

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      wizards: {
        appOperation: {
          nextRun: 'Next Run:',
          cronValidationFailed: 'Could not validate the schedule',
          cronInvalid: 'Invalid cron expression',
        },
      },
      backendErrors: { automation: { invalidCron: 'Invalid cron expression: {{error}}' } },
    });
    translate.use('en');

    fixture = TestBed.createComponent(CronInputComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create component with default state', () => {
    expect(component).toBeTruthy();
    expect(component.formattedNextRun()).toBe('');
  });

  it('should reactively derive formattedNextRun when validationResponse changes', () => {
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    const response: CronValidationResponse = {
      isValid: true,
      nextRun: futureDate,
    };

    component.validationResponse.set(response);
    fixture.detectChanges();

    const result = component.formattedNextRun();
    expect(result).toContain('in 1 hour');
  });

  it('should handle past dates correctly in formatNextRun', () => {
    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
    const result = component.formatNextRun(pastDate);
    expect(result).toContain('1 hour ago');
  });

  it('should return empty string for null nextRun', () => {
    expect(component.formatNextRun(null)).toBe('');
  });

  it('should return original string for invalid date', () => {
    expect(component.formatNextRun('invalid-date')).toBe('invalid-date');
  });

  it('should automatically validate and calculate nextRun when initialValue is provided', async () => {
    fixture.componentRef.setInput('initialValue', '0 9 * * *');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(automationServiceMock.validateCron).toHaveBeenCalledWith('0 9 * * *');
    expect(component.validationResponse()).toEqual({
      isValid: true,
      nextRun: '2026-10-15T12:00:00Z',
    });
    expect(component.formattedNextRun()).not.toBe('');
  });

  it('shows the backend validation error in the language of the app, not as raw JSON', async () => {
    automationServiceMock.validateCron.mockReturnValue(
      of({
        isValid: false,
        errorMessage: JSON.stringify({
          key: 'backendErrors.automation.invalidCron',
          params: { error: 'boom' },
        }),
      })
    );
    component.cronControl.setValue('bad');
    await fixture.whenStable();
    expect(component.validationError()).toBe('Invalid cron expression: boom');

    automationServiceMock.validateCron.mockReturnValue(throwError(() => new Error('offline')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    component.cronControl.setValue('worse');
    await fixture.whenStable();
    expect(component.validationError()).toBe('Could not validate the schedule');
  });

  it('names the zone schedules fire in: the device on desktop, the server offset on the web', () => {
    const win = window as Window & { __TAURI_INTERNALS__?: unknown };
    component.validationResponse.set({ isValid: true, utcOffset: '+05:30' });
    expect(component.scheduleTimezone()).toBe('UTC+05:30');
    component.validationResponse.set({ isValid: true });
    expect(component.scheduleTimezone()).toBe('');

    win.__TAURI_INTERNALS__ = {};
    try {
      const desktop = TestBed.createComponent(CronInputComponent).componentInstance;
      expect(desktop.scheduleTimezone()).toContain('UTC');
      expect(desktop.scheduleTimezone()).not.toBe('UTC+05:30');
    } finally {
      delete win.__TAURI_INTERNALS__;
    }
  });
});
