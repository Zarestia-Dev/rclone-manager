import { TitleCasePipe } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService, TranslatePipe } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionState, Remote } from '@app/types';
import { GeneralDetailComponent } from './general-detail.component';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

describe('GeneralDetailComponent controls', () => {
  let fixture: ComponentFixture<GeneralDetailComponent>;
  const selectedRemote = signal<Remote>({} as Remote);
  const actionInProgress = signal<Record<string, ActionState[]>>({});
  const automations = signal([
    { id: 'first', remoteName: 'remote', profileName: 'First' },
    { id: 'second', remoteName: 'remote', profileName: 'Second' },
  ]);

  beforeEach(() => {
    selectedRemote.set({
      name: 'remote',
      type: 'local',
      primaryActions: ['mount'],
      config: {},
      status: { diskUsage: {}, mount: { active: false, configuredProfiles: ['default'] } },
    } as Remote);
    actionInProgress.set({});
    TestBed.configureTestingModule({
      imports: [GeneralDetailComponent],
      providers: [
        provideTranslateService(),
        {
          provide: RemoteFacadeService,
          useValue: { selectedRemote, actionInProgress, jobs: signal([]) },
        },
        { provide: AutomationService, useValue: { automations } },
        {
          provide: QuickRunService,
          useValue: { quickRuns: signal([]), runningIds: signal(new Set()) },
        },
        { provide: IconService, useValue: { getIconName: (): string => 'server' } },
        { provide: PathService, useValue: {} },
        { provide: MatDialog, useValue: {} },
      ],
    }).overrideComponent(GeneralDetailComponent, {
      // Render this component's real template without descending into its panels.
      set: { imports: [TranslatePipe, TitleCasePipe], schemas: [CUSTOM_ELEMENTS_SCHEMA] },
    });
    fixture = TestBed.createComponent(GeneralDetailComponent);
    fixture.detectChanges();
  });

  it('renders an inactive action as a native toggle button and starts its configured profile', () => {
    const button: HTMLButtonElement = fixture.nativeElement.querySelector(
      '.remote-status-indicators button'
    );
    const start = vi.spyOn(fixture.componentInstance.startJob, 'emit');
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(start).toHaveBeenCalledWith({
      type: 'mount',
      remoteName: 'remote',
      profileName: 'default',
    });
  });

  it('reflects a running action and stops the active profile', () => {
    selectedRemote.update(
      remote =>
        ({
          ...remote,
          status: { ...remote.status, mount: { active: true, activeProfiles: { default: 1 } } },
        }) as Remote
    );
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector(
      '.remote-status-indicators button'
    );
    const stop = vi.spyOn(fixture.componentInstance.stopJob, 'emit');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.classList.contains('p-accent')).toBe(true);
    button.click();
    expect(stop).toHaveBeenCalledWith({
      type: 'mount',
      remoteName: 'remote',
      profileName: 'default',
    });
  });

  it('disables an action while a request is in progress', () => {
    actionInProgress.set({ remote: [{ type: 'mount' }] });
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector(
      '.remote-status-indicators button'
    );
    const start = vi.spyOn(fixture.componentInstance.startJob, 'emit');
    expect(button.disabled).toBe(true);
    button.click();
    expect(start).not.toHaveBeenCalled();
  });

  it('renders carousel selectors as buttons with an accurate current state', () => {
    const buttons: NodeListOf<HTMLButtonElement> = fixture.nativeElement.querySelectorAll(
      '.carousel-indicators button'
    );
    expect(buttons.length).toBe(2);
    expect(buttons[0].getAttribute('aria-current')).toBe('true');
    buttons[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.currentAutomationCardIndex()).toBe(1);
    expect(buttons[0].hasAttribute('aria-current')).toBe(false);
    expect(buttons[1].getAttribute('aria-current')).toBe('true');
  });
});
