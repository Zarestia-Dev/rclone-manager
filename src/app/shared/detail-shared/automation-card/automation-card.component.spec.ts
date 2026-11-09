import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Automation } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { AutomationCardComponent } from './automation-card.component';

type Card = Record<string, () => unknown>;

describe('AutomationCardComponent', () => {
  let fixture: ComponentFixture<AutomationCardComponent>;
  let service: {
    toggleAutomation: ReturnType<typeof vi.fn>;
    runAutomation: ReturnType<typeof vi.fn>;
    stopAutomation: ReturnType<typeof vi.fn>;
  };

  const base = {
    id: 'auto-1',
    automationType: 'sync',
    remoteName: 'drive',
    profileName: 'Nightly',
    status: 'enabled',
    backendName: 'Local',
    createdAt: '2026-01-01T00:00:00Z',
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    stoppedCount: 0,
    args: { srcPaths: ['/home/a'], dstPaths: ['drive:b'], remoteName: 'drive', profileName: 'x' },
  } as unknown as Automation;

  const render = (
    overrides: Partial<Automation> = {},
    variant: 'compact' | 'detailed' = 'detailed'
  ): HTMLElement => {
    fixture.componentRef.setInput('automation', { ...base, ...overrides });
    fixture.componentRef.setInput('variant', variant);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };
  const card = (): Card => fixture.componentInstance as unknown as Card;

  beforeEach(async (): Promise<void> => {
    service = {
      toggleAutomation: vi.fn().mockResolvedValue(undefined),
      runAutomation: vi.fn().mockResolvedValue(undefined),
      stopAutomation: vi.fn().mockRejectedValue(new Error('already notified')),
    };
    await TestBed.configureTestingModule({
      imports: [AutomationCardComponent],
      providers: [
        provideTranslateService(),
        { provide: AutomationService, useValue: service },
        {
          provide: PathService,
          useValue: { isLocalPath: (p: string): boolean => p.startsWith('/') },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AutomationCardComponent);
  });

  it('colours every automatable operation from the operation registry', () => {
    for (const [type, icon] of [
      ['sync', 'refresh'],
      ['check', 'search'],
      ['delete', 'trash'],
    ] as const) {
      render({ automationType: type });
      expect(card()['typeMeta']()).toMatchObject({ icon });
    }
  });

  it('shows a workflow as a workflow, with no remote, operation or destination', () => {
    const el = render({
      automationType: null,
      remoteName: '',
      args: { source: 'workflow', srcPaths: ['Nightly'], dstPaths: [] },
    });
    expect(card()['typeMeta']()).toEqual({ icon: 'workflow', color: 'accent' });
    expect(card()['typeLabelKey']()).toBeNull();
    expect(el.textContent).not.toContain('dashboard.generalDetail.destinationLabel');
    expect(el.textContent).not.toContain('dashboard.appDetail');
  });

  it('lists only the folders a workflow watches, and no Paths section for a schedule-only one', () => {
    const workflow = { automationType: null, remoteName: '' } as const;
    let el = render({
      ...workflow,
      args: { source: 'workflow', srcPaths: ['/data/inbox'], dstPaths: [] },
    });
    expect(el.textContent).toContain('/data/inbox');
    expect(el.textContent).toContain('automation.monitoring.watchedFolder');
    expect(el.textContent).not.toContain('dashboard.generalDetail.sourceLabel');

    el = render({ ...workflow, args: { source: 'workflow', srcPaths: [], dstPaths: [] } });
    expect(el.textContent).not.toContain('dashboard.generalDetail.paths');
  });

  it('shows the running row only for a real job, never for a workflow', () => {
    const profile = render({ status: 'running', currentJobId: '42' });
    expect(profile.querySelector('.running-section')?.textContent).toContain('42');

    const workflow = render({
      status: 'running',
      currentJobId: 'wf-1',
      automationType: null,
      remoteName: '',
      args: { source: 'workflow', srcPaths: [], dstPaths: [] },
    });
    expect(workflow.querySelector('.running-section')).toBeNull();
  });

  it('offers Run only when it can start and Stop only while running', () => {
    for (const [status, run, stop] of [
      ['enabled', true, false],
      ['failed', true, false],
      ['running', false, true],
      ['disabled', false, false],
      ['stopping', false, false],
    ] as const) {
      render({ status });
      expect([card()['canRun'](), card()['canStop']()], status).toEqual([run, stop]);
    }
  });

  it('explains a missing next run instead of formatting a date', () => {
    render({ status: 'disabled' });
    expect(card()['nextRunKey']()).toBe('automation.nextRun.disabled');
    render({ status: 'enabled', nextRun: undefined });
    expect(card()['nextRunKey']()).toBe('automation.nextRun.notScheduled');
    render({ status: 'enabled', watchEnabled: true, cronExpression: undefined });
    expect(card()['nextRunKey']()).toBe('automation.monitoring.watcherActive');
    render({ status: 'enabled', cronExpression: '0 0 * * *', nextRun: '2026-01-02T00:00:00Z' });
    expect(card()['nextRunKey']()).toBeNull();
    expect(card()['nextRunTime']()).toEqual(expect.any(String));
  });

  it('toggles through the service without opening the card', () => {
    const el = render({ status: 'enabled' }, 'compact');
    const click = vi.fn();
    el.addEventListener('click', click);
    (el.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(service.toggleAutomation).toHaveBeenCalledWith('auto-1');
    expect(click).not.toHaveBeenCalled();
  });

  it('runs and stops through the service without opening the card', async () => {
    render({ status: 'enabled' }, 'compact');
    const click = vi.fn();
    fixture.nativeElement.addEventListener('click', click);
    fixture.nativeElement.querySelector('button').click();
    expect(service.runAutomation).toHaveBeenCalledWith('auto-1');
    expect(click).not.toHaveBeenCalled();

    render({ status: 'running' }, 'compact');
    fixture.nativeElement.querySelector('button').click();
    // A rejected stop is already reported by the service; it must not escape.
    await Promise.resolve();
    expect(service.stopAutomation).toHaveBeenCalledWith('auto-1');
  });

  it('activates the compact card with the keyboard only when the card has focus', () => {
    const el = render({}, 'compact');
    const matCard = el.querySelector('mat-card') as HTMLElement;
    const clicked = vi.fn();
    matCard.addEventListener('click', clicked);
    matCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
    (matCard.querySelector('button') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('lists the paths of a profile with local and remote icons', () => {
    render();
    expect(card()['automationPaths']()).toMatchObject({
      sourcePaths: [{ path: '/home/a', icon: 'folder' }],
      destPaths: [{ path: 'drive:b', icon: 'folder-open' }],
      isMultiSource: false,
    });
  });
});
