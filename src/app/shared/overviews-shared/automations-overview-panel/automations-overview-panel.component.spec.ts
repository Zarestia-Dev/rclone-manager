import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { AutomationsOverviewPanelComponent } from './automations-overview-panel.component';
import { Automation } from '@app/types';
import { AutomationService } from 'src/app/services/operations/automation.service';

describe('AutomationsOverviewPanelComponent', () => {
  let component: AutomationsOverviewPanelComponent;
  let fixture: ComponentFixture<AutomationsOverviewPanelComponent>;

  const mockAutomations = [
    {
      id: 'auto-1',
      profileName: 'Flow Sync',
      remoteName: 'drive:',
      automationType: 'sync',
      status: 'enabled',
      args: { source: 'flow' },
    },
    {
      id: 'auto-2',
      profileName: 'Quick Run Backup',
      remoteName: 's3:',
      automationType: 'backup',
      status: 'enabled',
      args: { source: 'quickrun' },
    },
    {
      id: 'auto-3',
      profileName: 'Dashboard Auto',
      remoteName: 'dropbox:',
      automationType: 'copy',
      status: 'disabled',
      args: {},
    },
  ] as unknown as Automation[];

  beforeEach(async () => {
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

  it('filters automations by flow origin correctly', () => {
    expect(component.allAutomations().length).toBe(3);

    component.selectedOriginFilter.set('flow');
    fixture.detectChanges();
    expect(component.allAutomations().length).toBe(1);
    expect(component.allAutomations()[0].id).toBe('auto-1');
  });

  it('filters automations by quickrun origin correctly', () => {
    component.selectedOriginFilter.set('quickrun');
    fixture.detectChanges();
    expect(component.allAutomations().length).toBe(1);
    expect(component.allAutomations()[0].id).toBe('auto-2');
  });

  it('filters automations by dashboard origin correctly', () => {
    component.selectedOriginFilter.set('dashboard');
    fixture.detectChanges();
    expect(component.allAutomations().length).toBe(1);
    expect(component.allAutomations()[0].id).toBe('auto-3');
  });
});
