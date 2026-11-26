import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Automation, MountedRemote, ServeListItem } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { MountManagementService } from 'src/app/services/operations/mount-management.service';
import { ServeManagementService } from 'src/app/services/operations/serve-management.service';
import { AutomationCardComponent } from './automation-card.component';

type Card = Record<string, () => unknown>;

describe('AutomationCardComponent', () => {
  let fixture: ComponentFixture<AutomationCardComponent>;
  let service: {
    toggleAutomation: ReturnType<typeof vi.fn>;
    runAutomation: ReturnType<typeof vi.fn>;
    stopAutomation: ReturnType<typeof vi.fn>;
  };
  const mounts = signal<MountedRemote[]>([]);
  const serves = signal<ServeListItem[]>([]);

  const base = {
    id: 'auto-1',
    automationType: 'sync',
    remoteName: 'drive',
    profileName: 'Nightly',
    status: 'enabled',
    backendName: 'Local',
    cronExpression: null,
    nextRun: null,
    lastRun: null,
    lastError: null,
    currentJobId: null,
    watchEnabled: false,
    watchDelay: 5,
    watchChangedOnly: false,
    autoStart: false,
    autoStartDelay: 0,
    autoStartAt: null,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    stoppedCount: 0,
    args: { source: 'automation', srcPaths: ['/home/a'], dstPaths: ['drive:b'] },
  } as Automation;

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
  const text = (selector: string): string =>
    (fixture.nativeElement as HTMLElement).querySelector(selector)?.textContent ?? '';
  const dueIn = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();

  beforeEach(async (): Promise<void> => {
    mounts.set([]);
    serves.set([]);
    service = {
      toggleAutomation: vi.fn().mockResolvedValue(undefined),
      runAutomation: vi.fn().mockResolvedValue(undefined),
      stopAutomation: vi.fn().mockRejectedValue(new Error('already notified')),
    };
    await TestBed.configureTestingModule({
      imports: [AutomationCardComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        { provide: AutomationService, useValue: service },
        { provide: MountManagementService, useValue: { mountedRemotes: mounts } },
        { provide: ServeManagementService, useValue: { runningServes: serves } },
        {
          provide: PathService,
          useValue: {
            isLocalPath: (p: string): boolean => p.startsWith('/'),
            getRemoteNameFromFs: (fs = ''): string => fs.split(':')[0],
          },
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
    expect(card()['typeMeta']()).toEqual({ icon: 'workflow', tone: 'accent' });
    expect(card()['typeLabelKey']()).toBeNull();
    expect(el.textContent).not.toContain('automation.card.destination');
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
    expect(el.textContent).not.toContain('automation.card.source');

    el = render({ ...workflow, args: { source: 'workflow', srcPaths: [], dstPaths: [] } });
    expect(el.textContent).not.toContain('dashboard.generalDetail.paths');
  });

  describe('the status pill', () => {
    it('speaks only when there is something to say', () => {
      for (const [status, key] of [
        ['enabled', null],
        ['running', 'automation.status.running'],
        ['failed', 'automation.status.failed'],
        ['disabled', 'automation.status.disabled'],
        ['stopping', 'automation.status.stopping'],
      ] as const) {
        render({ status }, 'compact');
        expect((card()['statusPill']() as { key: string } | null)?.key ?? null, status).toBe(key);
      }
    });

    it('says that a delayed start waits', () => {
      render({ autoStart: true, autoStartAt: dueIn(30) }, 'compact');
      expect(card()['statusPill']()).toEqual({ key: 'automation.card.waiting', tone: 'yellow' });
    });
  });

  describe('the trigger pills', () => {
    const kinds = (): string[] => (card()['triggers']() as { kind: string }[]).map(t => t.kind);

    it('show every trigger the automation has, in the same order everywhere', () => {
      render({ cronExpression: '0 2 * * *', watchEnabled: true, autoStart: true }, 'compact');
      expect(kinds()).toEqual(['schedule', 'watch', 'startup']);
      expect(fixture.nativeElement.querySelectorAll('.trigger-pills [appPill]').length).toBe(3);

      render({ cronExpression: null, watchEnabled: false, autoStart: true }, 'compact');
      expect(kinds()).toEqual(['startup']);
    });

    it('count a delayed start down, then name its delay once it has passed', () => {
      render({ autoStart: true, autoStartDelay: 30, autoStartAt: dueIn(30) }, 'compact');
      expect(card()['startsIn']()).toBe(30);
      expect(text('.trigger-pills')).toContain('automation.startup.startsIn');

      render({ autoStart: true, autoStartDelay: 30, autoStartAt: dueIn(-5) }, 'compact');
      expect(card()['startsIn']()).toBeNull();
      expect(text('.trigger-pills')).toContain('automation.card.startupAfter');

      render({ autoStart: true, autoStartDelay: 0, autoStartAt: null }, 'compact');
      expect(text('.trigger-pills')).toContain('automation.startup.badge');
    });

    it('add the changed-folders scope only to a watcher that uses it', () => {
      render({ watchEnabled: true, watchChangedOnly: true }, 'compact');
      expect(text('.trigger-pills')).toContain('automation.monitoring.changedOnlyShort');
      render({ watchEnabled: false, watchChangedOnly: true }, 'compact');
      expect(text('.trigger-pills')).not.toContain('automation.monitoring.changedOnlyShort');
    });
  });

  describe('the compact footer', () => {
    it('states the one fact that matters for the status', () => {
      for (const [overrides, key] of [
        [{ status: 'running', lastRun: dueIn(-60) }, 'automation.card.started'],
        [{ status: 'failed', lastRun: dueIn(-60) }, 'automation.card.lastTry'],
        [{ autoStart: true, autoStartAt: dueIn(30) }, 'automation.card.notStarted'],
        [{ cronExpression: '0 2 * * *', nextRun: dueIn(3600) }, 'automation.card.nextRun'],
        [{ lastRun: dueIn(-60) }, 'automation.card.lastRun'],
        [{ autoStart: true, lastRun: dueIn(-60) }, 'automation.card.started'],
        [{}, 'automation.card.neverRun'],
      ] as [Partial<Automation>, string][]) {
        render(overrides, 'compact');
        expect(text('.card-foot .fact'), key).toBe(key);
      }
    });

    it('never puts a run that has just ended in the future', () => {
      // The card's clock last moved on half a minute ago; the run ended a second ago.
      (fixture.componentInstance as unknown as { now: { set(time: number): void } }).now.set(
        Date.now() - 30_000
      );
      render({ status: 'failed', lastRun: dueIn(-1) }, 'compact');
      const ago = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-1, 'second');
      expect(card()['lastRunRelative']()).toBe(ago);
    });

    it('offers only the actions that make sense for the automation', () => {
      const actions = (overrides: Partial<Automation>): string[] => {
        render(overrides, 'compact');
        return Array.from<HTMLButtonElement>(
          fixture.nativeElement.querySelectorAll('.card-foot button')
        ).map(b => b.getAttribute('title') ?? b.textContent?.trim() ?? '');
      };
      const schedule = { cronExpression: '0 2 * * *' };
      expect(actions(schedule)).toEqual(['automation.actions.run', 'automation.toggle.disable']);
      expect(actions({ ...schedule, status: 'running' })).toEqual([
        'automation.actions.stop',
        'automation.toggle.disable',
      ]);
      expect(actions({ ...schedule, status: 'disabled' })).toEqual(['automation.toggle.enable']);
      expect(actions({ ...schedule, status: 'failed' })).toEqual([
        'common.retry',
        'automation.toggle.disable',
      ]);
      // Starting with the app is nothing to pause, and a mount runs on by itself.
      expect(actions({ automationType: 'mount', autoStart: true })).toEqual([]);
      expect(actions({ automationType: 'mount', autoStart: true, status: 'failed' })).toEqual([
        'common.retry',
      ]);
    });

    it('runs, stops and toggles through the service without opening the card', async () => {
      const click = vi.fn();
      fixture.nativeElement.addEventListener('click', click);
      render({ cronExpression: '0 2 * * *' }, 'compact');
      const [run, toggle] = fixture.nativeElement.querySelectorAll('.card-foot button');
      run.click();
      toggle.click();
      expect(service.runAutomation).toHaveBeenCalledWith('auto-1');
      expect(service.toggleAutomation).toHaveBeenCalledWith('auto-1');

      render({ status: 'running' }, 'compact');
      fixture.nativeElement.querySelector('.card-foot button').click();
      // A rejected stop is already reported by the service; it must not escape.
      await Promise.resolve();
      expect(service.stopAutomation).toHaveBeenCalledWith('auto-1');
      expect(click).not.toHaveBeenCalled();
    });
  });

  it('shows why a failed run failed, translated, on both cards', () => {
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', { backendErrors: { mount: { busy: 'Mount point is busy' } } });
    translate.use('en');
    const key = JSON.stringify({ key: 'backendErrors.mount.busy', params: {} });

    render({ status: 'failed', lastError: key }, 'compact');
    expect(text('.error-box').trim()).toBe('Mount point is busy');
    render({ status: 'failed', lastError: key }, 'detailed');
    expect(text('.failure')).toContain('Mount point is busy');

    render({ status: 'enabled', lastError: key }, 'compact');
    expect(fixture.nativeElement.querySelector('.error-box')).toBeNull();
    render({ status: 'enabled', lastError: key }, 'detailed');
    expect(fixture.nativeElement.querySelector('.failure')).toBeNull();
  });

  it('activates the compact card with the keyboard on itself only', () => {
    const el = render({}, 'compact');
    const matCard = el.querySelector('mat-card') as HTMLElement;
    const clicked = vi.fn();
    matCard.addEventListener('click', clicked);
    matCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
    render({ cronExpression: '0 2 * * *' }, 'compact');
    (matCard.querySelector('button') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  describe('the detailed card', () => {
    it('gives each trigger its own row', () => {
      render({
        cronExpression: '0 2 * * *',
        nextRun: dueIn(3600),
        watchEnabled: true,
        autoStart: true,
        autoStartDelay: 12,
      });
      const rows = fixture.nativeElement.querySelectorAll('.trigger-row');
      expect(rows.length).toBe(3);
      expect(rows[0].textContent).toContain('0 2 * * *');
      expect(rows[1].textContent).toContain('automation.card.waitsAfterChange');
      expect(rows[1].textContent).toContain('automation.card.folders');
      expect(rows[2].textContent).toContain('automation.startup.delay');
      // A schedule runs it too: the last run is not the last start.
      expect(rows[2].textContent).not.toContain('automation.card.lastStart');
    });

    it('names the last start only when starting with the app is the only trigger', () => {
      render({ autoStart: true, lastRun: dueIn(-60) });
      expect(text('.trigger-row')).toContain('automation.card.lastStart');
      expect(text('.trigger-row')).toContain('automation.startup.immediately');
    });

    it('shows what the mount or serve of the automation is doing now as a pill', () => {
      const profile = { kind: 'profile', name: 'Nightly' } as const;
      render({ automationType: 'mount', autoStart: true });
      expect(card()['live']()).toEqual({ kind: 'mount', mountPoint: null });
      expect(text('.head-end')).toContain('mount.notMounted');

      mounts.set([{ fs: 'drive:folder', mount_point: '/mnt/drive', starter: profile }]);
      fixture.detectChanges();
      expect(text('.head-end')).toContain('mount.mounted');

      // Another profile's mount of the same remote is not this one.
      mounts.set([
        { fs: 'drive:', mount_point: '/mnt/other', starter: { kind: 'profile', name: 'x' } },
      ]);
      fixture.detectChanges();
      expect(card()['live']()).toEqual({ kind: 'mount', mountPoint: null });

      render({ automationType: 'serve' });
      serves.set([
        {
          id: 's1',
          addr: '127.0.0.1:8080',
          starter: profile,
          params: { fs: 'drive:', type: 'webdav' },
        },
      ]);
      fixture.detectChanges();
      expect(card()['live']()).toEqual({ kind: 'serve', address: '127.0.0.1:8080' });
      expect(text('.head-end')).toContain('automation.card.servingAt');

      render({ automationType: 'sync' });
      expect(card()['live']()).toBeNull();
    });

    it('opens a local path with the folder icon and a remote one with the open folder', () => {
      render();
      const icons = Array.from<Element>(
        fixture.nativeElement.querySelectorAll('.path-value button mat-icon')
      ).map(icon => icon.getAttribute('svgIcon') ?? icon.getAttribute('data-mat-icon-name'));
      expect(card()['paths']()).toMatchObject({
        sources: [{ path: '/home/a', icon: 'folder' }],
        destinations: [{ path: 'drive:b', icon: 'folder-open' }],
      });
      expect(icons.length).toBe(2);
    });

    it('opens and closes as a panel, and its buttons do not toggle it', () => {
      const el = render({ cronExpression: '0 2 * * *' });
      const panel = (): Element | null => el.querySelector('mat-expansion-panel');
      expect(panel()?.classList).not.toContain('mat-expanded');
      fixture.componentRef.setInput('expanded', true);
      fixture.detectChanges();
      expect(panel()?.classList).toContain('mat-expanded');

      (el.querySelector('.actions button') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(service.runAutomation).toHaveBeenCalledWith('auto-1');
      expect(panel()?.classList).toContain('mat-expanded');
    });

    it('lists several sources under one label with one arrow to the destination', () => {
      render({
        args: { source: 'automation', srcPaths: ['dropbox:', '/home/a'], dstPaths: ['/t'] },
      });
      const labels = Array.from<Element>(fixture.nativeElement.querySelectorAll('.path-label')).map(
        l => l.textContent?.trim()
      );
      expect(labels).toEqual(['automation.card.sources 2', 'automation.card.destination']);
      expect(fixture.nativeElement.querySelectorAll('.path-arrow').length).toBe(1);

      render({ args: { source: 'automation', srcPaths: ['/home/a'], dstPaths: ['/t'] } });
      expect(text('.path-label').trim()).toBe('automation.card.source');
    });

    it('counts no runs of something that only starts with the app', () => {
      render({ automationType: 'mount', autoStart: true, runCount: 1, successCount: 1 });
      expect(fixture.nativeElement.querySelector('.run-bar')).toBeNull();
      render({ cronExpression: '0 2 * * *', autoStart: true, runCount: 1, successCount: 1 });
      expect(fixture.nativeElement.querySelector('.run-bar')).not.toBeNull();
    });

    it('labels the paths of a mount by what they are and gives a serve no destination', () => {
      render({
        automationType: 'mount',
        args: { source: 'automation', srcPaths: ['drive:'], dstPaths: ['/mnt/d'] },
      });
      expect(text('.path-flow')).toContain('flow.workflow.inspector.remote');
      expect(text('.path-flow')).toContain('modals.jobDetail.fields.mountPoint');

      render({
        automationType: 'serve',
        args: { source: 'automation', srcPaths: ['drive:'], dstPaths: [] },
      });
      expect(fixture.nativeElement.querySelector('.path-arrow')).toBeNull();
    });

    it('names the running job on the status pill, never for a workflow', () => {
      const pillTitle = (): string | null =>
        fixture.nativeElement.querySelector('.head-end [appPill]')?.getAttribute('title') ?? null;
      render({ status: 'running', currentJobId: '42' });
      expect(pillTitle()).toContain('42');

      render({
        status: 'running',
        currentJobId: 'wf-1',
        automationType: null,
        remoteName: '',
        args: { source: 'workflow', srcPaths: [], dstPaths: [] },
      });
      expect(pillTitle()).toBeNull();
    });

    it('splits the run bar by outcome', () => {
      render({ runCount: 4, successCount: 2, failureCount: 1, stoppedCount: 1 });
      const widths = Array.from<HTMLElement>(
        fixture.nativeElement.querySelectorAll('.run-bar span')
      ).map(s => s.style.width);
      expect(widths).toEqual(['50%', '25%', '25%']);

      render({ runCount: 0, successCount: 0, failureCount: 0, stoppedCount: 0 });
      expect(fixture.nativeElement.querySelectorAll('.run-bar span').length).toBe(0);
    });
  });
});
