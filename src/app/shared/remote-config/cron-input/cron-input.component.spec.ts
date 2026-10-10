import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
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
          relativeTime: {
            inPast: 'in the past ({{date}})',
            in: 'in {{time}}',
            days: '{{count}}d',
            hours: '{{count}}h',
            minutes: '{{count}}m',
            seconds: '{{count}}s',
          },
          nextRun: 'Next Run:',
        },
      },
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
    expect(result).toContain('in ');
    expect(result).toContain('h');
  });

  it('should handle past dates correctly in formatNextRun', () => {
    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
    const result = component.formatNextRun(pastDate);
    expect(result).toContain('in the past');
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
});
