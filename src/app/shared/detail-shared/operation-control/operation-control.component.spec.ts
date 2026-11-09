import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { JobReportKey, OperationControlConfig, PrimaryActionType } from '@app/types';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { OperationControlComponent } from './operation-control.component';

const config = (operationType: PrimaryActionType, extra = {}): OperationControlConfig =>
  ({
    operationType,
    isActive: false,
    isLoading: false,
    tone: 'primary',
    pathConfig: { source: 'a:', destination: 'b:' },
    primaryButtonLabel: 'start',
    primaryIcon: 'play',
    secondaryButtonLabel: 'stop',
    secondaryIcon: 'stop',
    ...extra,
  }) as OperationControlConfig;

describe('OperationControlComponent file reports', () => {
  let fixture: ComponentFixture<OperationControlComponent>;

  const show = (
    operationType: PrimaryActionType,
    inputs: { reports?: JobReportKey[]; busy?: boolean } = {}
  ): HTMLElement => {
    fixture = TestBed.createComponent(OperationControlComponent);
    fixture.componentRef.setInput(
      'config',
      config(operationType, { isActive: inputs.busy ?? false })
    );
    fixture.componentRef.setInput('reports', inputs.reports ?? []);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    TestBed.configureTestingModule({
      imports: [OperationControlComponent],
      providers: [
        provideTranslateService(),
        { provide: IconService, useValue: {} },
        { provide: SystemInfoService, useValue: { getLocalDiskUsage: vi.fn() } },
      ],
    });
  });

  it('fills its buttons in the operation tone, and in warn while the operation runs', () => {
    const buttons = (el: HTMLElement): string[] =>
      Array.from(el.querySelectorAll<HTMLElement>('button[matIconButton], button[matButton]'))
        .map(button => button.dataset['tone'] ?? '')
        .filter(Boolean);
    expect(new Set(buttons(show('sync')))).toEqual(new Set(['primary']));
    expect(new Set(buttons(show('sync', { busy: true })))).toEqual(new Set(['warn']));
  });

  it('offers the reports to choose from for sync, copy and move only', () => {
    for (const operation of ['sync', 'copy', 'move'] as const) {
      expect(show(operation).querySelectorAll('.report-options [appPill]')).toHaveLength(6);
    }
    expect(show('bisync').querySelector('.report-options')).toBeNull();
    expect(show('mount').querySelector('.report-options')).toBeNull();
  });

  it('lists every report except the combined one, which is the switch itself', () => {
    show('sync');
    expect(fixture.componentInstance['extraReports']).toEqual([
      'missingOnDst',
      'differ',
      'missingOnSrc',
      'match',
      'error',
      'destAfter',
    ]);
  });

  it('keeps the options out of reach while file reports are off and in reach once on', () => {
    expect(show('sync').querySelector('.report-options')?.hasAttribute('inert')).toBe(true);
    expect(show('sync', { reports: ['combined'] }).querySelector('.report-options')).toSatisfy(
      (element: Element) => !element.hasAttribute('inert') && element.classList.contains('open')
    );
  });

  it('marks the reports that are on and says which one a click turns', () => {
    const element = show('sync', { reports: ['combined', 'differ'] });
    const pressed = Array.from(element.querySelectorAll('.report-options [appPill]')).map(pill =>
      pill.getAttribute('aria-pressed')
    );
    expect(pressed).toEqual(['false', 'true', 'false', 'false', 'false', 'false']);

    const toggled: JobReportKey[] = [];
    fixture.componentInstance.toggleReport.subscribe(key => toggled.push(key));
    (element.querySelectorAll('.report-options [appPill]')[3] as HTMLElement).click();
    expect(toggled).toEqual(['match']);
  });

  it('cannot change what a running job asks for', () => {
    const element = show('sync', { reports: ['combined'], busy: true });
    const pills = element.querySelectorAll<HTMLButtonElement>('.report-options [appPill]');
    expect(Array.from(pills).every(pill => pill.disabled)).toBe(true);
  });
});
