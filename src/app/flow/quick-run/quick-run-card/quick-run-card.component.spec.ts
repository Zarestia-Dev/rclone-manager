import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { QuickRunCardComponent } from './quick-run-card.component';
import { QuickRun } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';

describe('QuickRunCardComponent', () => {
  let fixture: ComponentFixture<QuickRunCardComponent>;
  let component: QuickRunCardComponent;

  const mockQuickRun: QuickRun = {
    id: 'qr-1',
    name: 'Backup Documents',
    operationType: 'sync',
    remoteName: 'missing-drive',
    config: {
      app: { autoStart: false },
      rclone: { srcFs: '/home/user/docs', dstFs: 'missing-drive:backup' },
    },
  };

  const isRemoteMissingMock = vi.fn((name?: string | null) => name === 'missing-drive');
  const runningIds = signal<ReadonlySet<string>>(new Set());
  const quickRunActions = signal<Record<string, 'start' | 'stop'>>({});
  const remoteActions = signal<Record<string, unknown[]>>({});

  const el = (): HTMLElement => fixture.nativeElement;
  const primaryButton = (): HTMLButtonElement =>
    el().querySelector('.quick-actions button') as HTMLButtonElement;
  const setQuickRun = (patch: Partial<QuickRun>): void => {
    fixture.componentRef.setInput('quickRun', { ...mockQuickRun, ...patch });
    fixture.detectChanges();
  };

  beforeEach(async () => {
    isRemoteMissingMock.mockImplementation((name?: string | null) => name === 'missing-drive');
    runningIds.set(new Set());
    quickRunActions.set({});
    remoteActions.set({});

    await TestBed.configureTestingModule({
      imports: [QuickRunCardComponent],
      providers: [
        provideTranslateService(),
        {
          provide: PathService,
          useValue: {
            isLocalPath: vi.fn((p: string) => p.startsWith('/')),
          },
        },
        {
          provide: IconService,
          useValue: {
            getIconName: vi.fn(() => 'cloud'),
          },
        },
        {
          provide: RemoteFacadeService,
          useValue: {
            actionInProgress: remoteActions,
            getRemoteSummary: vi.fn(),
            isRemoteMissing: isRemoteMissingMock,
          },
        },
        {
          provide: QuickRunService,
          useValue: {
            actionInProgress: quickRunActions,
            runningIds,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(QuickRunCardComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('quickRun', mockQuickRun);
    fixture.detectChanges();
  });

  it('should detect when the remote is missing', () => {
    expect(component.isRemoteMissing()).toBe(true);
    expect(el().querySelector('.remote-link-btn')?.classList.contains('is-missing')).toBe(true);
  });

  it('should disable the primary action button when remote is missing', () => {
    expect(primaryButton().disabled).toBe(true);
  });

  it('should not mark card as missing when remote is active', () => {
    setQuickRun({ remoteName: 'existing-drive' });

    expect(component.isRemoteMissing()).toBe(false);
    expect(el().querySelector('.remote-link-btn')?.classList.contains('is-missing')).toBe(false);
    expect(primaryButton().disabled).toBe(false);
  });

  it('renders without schedule badges when the stored config has no app section', () => {
    setQuickRun({
      config: { rclone: { srcFs: '/a', dstFs: 'x:b' } } as unknown as QuickRun['config'],
    });

    expect(el().querySelector('.card-status-indicators')?.children.length).toBe(0);
  });

  it('shows schedule, watcher and autostart badges from the app config', () => {
    setQuickRun({
      config: {
        app: {
          cronEnabled: true,
          cronExpression: '0 2 * * *',
          watchEnabled: true,
          autoStart: true,
        },
        rclone: {},
      },
    });

    expect(el().querySelectorAll('.card-status-indicators .app-pill')).toHaveLength(3);
  });

  it('follows the running state of the quick run service', () => {
    setQuickRun({ remoteName: 'existing-drive' });
    expect(component.isRunning()).toBe(false);
    expect(el().classList.contains('is-active')).toBe(false);

    runningIds.set(new Set(['qr-1']));
    fixture.detectChanges();

    expect(component.isRunning()).toBe(true);
    expect(el().classList.contains('is-active')).toBe(true);
    expect(primaryButton().getAttribute('data-tone')).toBe('warn');
  });

  it('starts an idle quick run and stops a running one from the same button', () => {
    setQuickRun({ remoteName: 'existing-drive' });
    const start = vi.fn();
    const stop = vi.fn();
    component.startRun.subscribe(start);
    component.stopRun.subscribe(stop);

    primaryButton().click();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    runningIds.set(new Set(['qr-1']));
    fixture.detectChanges();
    primaryButton().click();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('ignores the primary button while its own action is in flight', () => {
    setQuickRun({ remoteName: 'existing-drive' });
    const start = vi.fn();
    component.startRun.subscribe(start);
    quickRunActions.set({ 'qr-1': 'start' });
    fixture.detectChanges();

    component.onToggleRun(new MouseEvent('click'));

    expect(primaryButton().disabled).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('emits selectRun when the card is clicked but not when a button is', () => {
    setQuickRun({ remoteName: 'existing-drive' });
    const selected = vi.fn();
    component.selectRun.subscribe(selected);

    primaryButton().click();
    expect(selected).not.toHaveBeenCalled();

    el().click();
    expect(selected).toHaveBeenCalledWith('qr-1');
  });

  describe('browse targets', () => {
    const targets = (): { kind: string; path: string }[] =>
      component
        .browseTargets()
        .map(t => ({ kind: t.labelKey?.split('.').pop() ?? '', path: t.path }));

    it('lists the source and the destination', () => {
      expect(targets()).toEqual([
        { kind: 'source', path: '/home/user/docs' },
        { kind: 'destination', path: 'missing-drive:backup' },
      ]);
    });

    it('lists every source of a multi-source run', () => {
      setQuickRun({
        config: { app: {}, rclone: { source: ['/a', '/b'], dstFs: 'x:c' } },
      });

      expect(targets().map(t => t.path)).toEqual(['/a', '/b', 'x:c']);
    });

    it('skips blank paths', () => {
      setQuickRun({ config: { app: {}, rclone: { srcFs: '   ', dstFs: '' } } });

      expect(component.browseTargets()).toEqual([]);
    });

    it('keeps both entries when source and destination are the same path', () => {
      setQuickRun({ config: { app: {}, rclone: { srcFs: '/same', dstFs: '/same' } } });

      const keys = component.browseTargets().map(t => t.key);
      expect(new Set(keys).size).toBe(2);
    });

    it('marks every target as opening while a folder opens on the remote', () => {
      remoteActions.set({ 'missing-drive': [{ type: 'open' }] });

      expect(component.browseTargets().every(t => t.isOpening)).toBe(true);
    });

    it('emits openInFiles with the remote, path and operation of the chosen target', () => {
      const opened = vi.fn();
      component.openInFiles.subscribe(opened);

      component.onOpenFolder(component.browseTargets()[0]);

      expect(opened).toHaveBeenCalledWith({
        remoteName: 'missing-drive',
        path: '/home/user/docs',
        operationType: 'sync',
      });
    });
  });
});
