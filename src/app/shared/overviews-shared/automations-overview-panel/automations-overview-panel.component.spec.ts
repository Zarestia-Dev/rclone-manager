import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal, WritableSignal } from '@angular/core';
import { AutomationsOverviewPanelComponent } from './automations-overview-panel.component';
import { Automation } from '@app/types';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { OriginFilterService } from 'src/app/services/ui/state/origin-filter.service';

describe('AutomationsOverviewPanelComponent', () => {
  let component: AutomationsOverviewPanelComponent;
  let fixture: ComponentFixture<AutomationsOverviewPanelComponent>;

  // The chips choose the filter, and only while they are shown.
  const chooseFilter = (filter: string): void => {
    fixture.componentRef.setInput('showFilterChips', true);
    TestBed.inject(OriginFilterService).set('automations', filter);
  };

  const mockAutomations = [
    {
      id: 'auto-1',
      profileName: 'Flow Sync',
      remoteName: 'drive:',
      automationType: 'sync',
      status: 'enabled',
      args: { source: 'workflow', srcPaths: [], dstPaths: [] },
    },
    {
      id: 'auto-2',
      profileName: 'Quick Run Backup',
      remoteName: 's3:',
      automationType: 'backup',
      status: 'enabled',
      args: { source: 'quickrun', srcPaths: [], dstPaths: [] },
    },
    {
      id: 'auto-3',
      profileName: 'Dashboard Auto',
      remoteName: 'dropbox:',
      automationType: 'copy',
      status: 'disabled',
      args: { srcPaths: [], dstPaths: [] },
    },
  ] as unknown as Automation[];

  beforeEach(async () => {
    localStorage.removeItem('rcman.overview.originFilters');
    const mockAutomationService = {
      automations: signal(mockAutomations),
    };

    await TestBed.configureTestingModule({
      imports: [AutomationsOverviewPanelComponent],
      providers: [
        provideTranslateService(),
        { provide: AutomationService, useValue: mockAutomationService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AutomationsOverviewPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('counts everything in the header when a chip hides all of it, and says so', () => {
    chooseFilter('update');
    fixture.detectChanges();
    expect(component.totalCount()).toBeGreaterThan(0);
    expect(component.hiddenCount()).toBe(component.totalCount());
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('mat-panel-description')?.textContent).not.toContain('noScheduled');
    expect(el.querySelector('.empty-state')?.textContent).toContain(
      'generalOverview.originFilter.empty'
    );
  });

  it('filters automations by workflow origin correctly', () => {
    expect(component.allAutomations().length).toBe(3);

    chooseFilter('workflow');
    fixture.detectChanges();
    expect(component.allAutomations().length).toBe(1);
    expect(component.allAutomations()[0].id).toBe('auto-1');
  });

  it('filters automations by quickrun origin correctly', () => {
    chooseFilter('quickrun');
    fixture.detectChanges();
    expect(component.allAutomations().length).toBe(1);
    expect(component.allAutomations()[0].id).toBe('auto-2');
  });

  it('filters automations by dashboard origin correctly', () => {
    chooseFilter('dashboard');
    fixture.detectChanges();
    expect(component.allAutomations().length).toBe(1);
    expect(component.allAutomations()[0].id).toBe('auto-3');
  });
  it('counts as active only what runs or will run by itself', () => {
    const automations = TestBed.inject(AutomationService).automations as WritableSignal<
      Automation[]
    >;
    const make = (overrides: Partial<Automation>): Automation =>
      ({
        ...mockAutomations[0],
        cronExpression: null,
        watchEnabled: false,
        autoStartAt: null,
        ...overrides,
      }) as Automation;
    automations.set([
      make({ id: 'schedule', cronExpression: '0 2 * * *' }),
      make({ id: 'watch', watchEnabled: true }),
      make({ id: 'waiting', autoStart: true, autoStartAt: '2099-01-01T00:00:00Z' }),
      make({ id: 'running', status: 'running' }),
      // Started with the app and done: nothing more happens until the next start.
      make({ id: 'started', autoStart: true }),
      make({ id: 'paused', status: 'disabled', cronExpression: '0 2 * * *' }),
    ]);
    expect(component.activeCount()).toBe(4);
    expect(component.totalCount()).toBe(6);
  });
});
