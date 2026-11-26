import { TitleCasePipe } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { provideTranslateService, TranslatePipe, TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionState, DEFAULT_JOB_STATS, JobInfo, Remote } from '@app/types';
import * as pathUtils from 'src/app/shared/utils/path.utils';
import { GeneralDetailComponent } from './general-detail.component';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { WorkflowStorageService } from 'src/app/services/flow/workflow-storage.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { PillDirective } from 'src/app/shared/directives/pill.directive';
import { OriginFilterBarComponent } from 'src/app/shared/overviews-shared/origin-filter-bar/origin-filter-bar.component';

describe('GeneralDetailComponent controls', () => {
  let fixture: ComponentFixture<GeneralDetailComponent>;
  const selectedRemote = signal<Remote>({} as Remote);
  const actionInProgress = signal<Record<string, ActionState[]>>({});
  const automations = signal([
    { id: 'first', remoteName: 'remote', profileName: 'First' },
    { id: 'second', remoteName: 'remote', profileName: 'Second' },
  ]);
  const workflows = signal<unknown[]>([]);
  const listWorkflowsUsingRemote = vi.fn();
  const jobs = signal<JobInfo[]>([]);
  const remoteNames = new Set(['remote', 'other']);
  const pathService = {
    isLocalPath: (path: string): boolean => pathUtils.isLocalPath(path, remoteNames),
    getRemoteNameFromFs: (fs: string): string =>
      pathUtils.isLocalPath(fs, remoteNames)
        ? 'local'
        : pathUtils.normalizeRemoteName(fs.split(':')[0]),
  };

  beforeEach(() => {
    selectedRemote.set({
      name: 'remote',
      type: 'local',
      primaryActions: ['mount'],
      config: {},
      status: { diskUsage: {}, mount: { active: false, configuredProfiles: ['default'] } },
    } as Remote);
    actionInProgress.set({});
    workflows.set([]);
    jobs.set([]);
    listWorkflowsUsingRemote.mockReset().mockResolvedValue([]);
    TestBed.configureTestingModule({
      imports: [GeneralDetailComponent],
      providers: [
        provideTranslateService(),
        {
          provide: RemoteFacadeService,
          useValue: { selectedRemote, actionInProgress, jobs },
        },
        { provide: AutomationService, useValue: { automations } },
        { provide: WorkflowStorageService, useValue: { workflows, listWorkflowsUsingRemote } },
        {
          provide: QuickRunService,
          useValue: { quickRuns: signal([]), runningIds: signal(new Set()) },
        },
        { provide: IconService, useValue: { getIconName: (): string => 'server' } },
        { provide: PathService, useValue: pathService },
        { provide: MatDialog, useValue: {} },
      ],
    }).overrideComponent(GeneralDetailComponent, {
      // Render this component's real template without descending into its panels.
      set: {
        imports: [
          TranslatePipe,
          TitleCasePipe,
          PillDirective,
          OriginFilterBarComponent,
          MatIconTestingModule,
        ],
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      },
    });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en-US', {
      actions: { mount: 'Mount' },
      overviews: { remoteCard: { actions: { mount: 'Mount', unmount: 'Unmount' } } },
    });
    translate.use('en-US');
    fixture = TestBed.createComponent(GeneralDetailComponent);
    fixture.detectChanges();
  });

  it('renders an inactive action as a native toggle button and starts its configured profile', () => {
    const button: HTMLButtonElement = fixture.nativeElement.querySelector(
      '.remote-status-indicators button'
    );
    const start = vi.spyOn(fixture.componentInstance.startJob, 'emit');
    expect(button.textContent?.trim()).toBe('Mount');
    expect(button.title).toBe('Mount');
    // Named by its visible text, so speech input can say what it shows; the tooltip describes it.
    expect(button.hasAttribute('aria-label')).toBe(false);
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
    expect(button.textContent?.trim()).toBe('Unmount');
    expect(button.title).toBe('Unmount');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.dataset['tone']).toBe('accent');
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

  it('lists the automations as one accordion with the first one open', () => {
    // The cards are not rendered here: their inputs land on the elements as properties.
    type Card = HTMLElement & { expanded: boolean; automation: { id: string } };
    const cards = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<Card>(
        'mat-accordion app-automation-card'
      )
    );
    expect(cards.length).toBe(2);
    expect(cards.every(card => card.getAttribute('variant') === 'detailed')).toBe(true);
    expect(cards.map(card => card.expanded)).toEqual([true, false]);
  });

  it('hides the origin filter when this remote has only one automation origin', () => {
    expect(fixture.componentInstance.automationOrigins()).toEqual(['dashboard']);
    expect(
      fixture.nativeElement.querySelector('.automations-card app-origin-filter-bar')
    ).toBeNull();

    fixture.componentInstance.automationOriginFilter.set('workflow');
    expect(fixture.componentInstance.remoteAutomations()).toEqual(automations());
  });

  it('lists every job that reads or writes this remote, however the job names it', () => {
    const job = (
      jobid: number,
      remote_name: string,
      source: string | string[],
      destination: string
    ): JobInfo => ({
      jobid,
      execute_id: `exec-${jobid}`,
      job_type: 'copy',
      remote_name,
      source,
      destination,
      start_time: '2026-09-02T10:00:00Z',
      status: 'Completed',
      stats: { ...DEFAULT_JOB_STATS },
    });
    jobs.set([
      job(1, 'remote', 'remote:', '/home/me'), // a profile names the bare remote
      job(2, 'remote:', ['remote:a.txt'], 'other:'), // the file browser writes it for rclone
      job(3, 'other:', 'other:a.txt', 'remote{ab12}:backup'), // copied onto this remote
      job(4, '/', ['/home/me/a.txt', 'remote:b.txt'], '/tmp'), // one of several sources
      job(5, 'multiple', ['/home/me/a.txt', 'other:b.txt'], 'other:'),
      job(6, '/', '/home/me/remote:x', '/tmp/remote'), // a local path that only mentions it
      job(7, 'remotes', 'remotes:', 'other:'),
    ]);
    expect(fixture.componentInstance.jobs().map(j => j.jobid)).toEqual([1, 2, 3, 4]);
  });

  describe('workflows', () => {
    const original = automations();
    const workflowAutomation = (id: string): unknown => ({
      id,
      remoteName: '',
      profileName: id,
      args: { source: 'workflow' },
    });

    /** Gives the page time to ask the backend again after the workflows changed. */
    async function refreshWorkflows(): Promise<void> {
      workflows.update(list => [...list, {}]);
      await fixture.whenStable();
      fixture.detectChanges();
    }

    beforeEach(() => {
      automations.set([
        ...original,
        workflowAutomation('wf-drive'),
        workflowAutomation('wf-elsewhere'),
        { id: 'other', remoteName: 'elsewhere', profileName: 'Other' },
      ] as unknown as typeof original);
    });

    afterEach(() => automations.set(original));

    it('lists only the workflows the backend says mention this remote', async (): Promise<void> => {
      listWorkflowsUsingRemote.mockResolvedValue([{ id: 'wf-drive', name: 'Nightly' }]);
      await refreshWorkflows();

      expect(listWorkflowsUsingRemote).toHaveBeenLastCalledWith('remote');
      expect(fixture.componentInstance.remoteAutomations().map(a => a.id)).toEqual([
        'first',
        'second',
        'wf-drive',
      ]);
    });

    it('lists no workflow when none of them mentions the remote', async (): Promise<void> => {
      await refreshWorkflows();

      expect(fixture.componentInstance.remoteAutomations().map(a => a.id)).toEqual([
        'first',
        'second',
      ]);
    });

    it('asks again for the new remote when another one is selected', async (): Promise<void> => {
      selectedRemote.update(remote => ({ ...remote, name: 'second-remote' }) as Remote);
      await fixture.whenStable();

      expect(listWorkflowsUsingRemote).toHaveBeenLastCalledWith('second-remote');
    });

    it('keeps the remote automations when the lookup fails', async (): Promise<void> => {
      listWorkflowsUsingRemote.mockRejectedValue(new Error('locked'));
      await refreshWorkflows();

      expect(fixture.componentInstance.remoteAutomations().map(a => a.id)).toEqual([
        'first',
        'second',
      ]);
    });

    it('shows only available origins and narrows the card with the origin chips', async (): Promise<void> => {
      listWorkflowsUsingRemote.mockResolvedValue([{ id: 'wf-drive', name: 'Nightly' }]);
      await refreshWorkflows();
      const component = fixture.componentInstance;
      const ids = (): string[] => component.remoteAutomations().map(a => a.id);

      expect(component.automationOrigins()).toEqual(['workflow', 'dashboard']);
      const filterButtons = Array.from<HTMLButtonElement>(
        fixture.nativeElement.querySelectorAll('.automations-card app-origin-filter-bar button')
      );
      expect(filterButtons.map(button => button.textContent?.trim())).toEqual([
        'common.all',
        'alerts.origins.workflow',
        'alerts.origins.dashboard',
      ]);

      component.automationOriginFilter.set('workflow');
      fixture.detectChanges();
      expect(ids()).toEqual(['wf-drive']);

      component.automationOriginFilter.set('dashboard');
      expect(ids()).toEqual(['first', 'second']);

      component.automationOriginFilter.set('quickrun');
      fixture.detectChanges();
      expect(component.selectedAutomationOrigin()).toBe('all');
      expect(ids()).toEqual(['first', 'second', 'wf-drive']);
    });
  });
});
