import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { CronSummaryCardComponent } from './cron-summary-card.component';

describe('CronSummaryCardComponent', () => {
  let fixture: ComponentFixture<CronSummaryCardComponent>;
  let component: CronSummaryCardComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CronSummaryCardComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(CronSummaryCardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders default cron expression and props', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.operation-summary-card')).toBeTruthy();
    expect(el.textContent).toContain('0 2 * * *');
  });

  it('renders custom cron expression and human readable text', () => {
    fixture.componentRef.setInput('cronExpression', '*/5 * * * *');
    fixture.componentRef.setInput('cronHumanReadable', 'Every 5 minutes');
    fixture.componentRef.setInput('isCronInvalid', false);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('*/5 * * * *');
    expect(el.textContent).toContain('Every 5 minutes');
  });

  it('emits openDetailed on button click', () => {
    let clicked = false;
    component.openDetailed.subscribe(() => {
      clicked = true;
    });

    const btn = fixture.nativeElement.querySelector('.btn-edit-config') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(clicked).toBe(true);
  });
});
