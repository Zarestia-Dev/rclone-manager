import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { RemoteCardComponent } from './remote-card.component';
import { STATUS_INDICATOR_META } from './remote-card.types';
import {
  Remote,
  RemoteStatus,
  createDefaultRemoteStatus,
  createDefaultRemoteFeatures,
  OPERATION_ICONS,
  OPERATION_META,
  OPERATION_TONE,
  ALL_PRIMARY_ACTIONS,
} from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';

describe('RemoteCardComponent', () => {
  let fixture: ComponentFixture<RemoteCardComponent>;
  let component: RemoteCardComponent;

  const createMockRemote = (statusOverrides?: Partial<RemoteStatus>): Remote => ({
    name: 'test-remote',
    type: 'drive',
    config: { name: 'test-remote', type: 'drive' },
    status: {
      ...createDefaultRemoteStatus(),
      mount: {
        active: false,
        configuredProfiles: ['default'],
        activeProfiles: {},
      },
      sync: {
        active: false,
        configuredProfiles: ['daily'],
        activeProfiles: {},
      },
      ...statusOverrides,
    },
    features: createDefaultRemoteFeatures(),
    primaryActions: ['mount', 'sync'],
    syncActions: ['sync'],
  });

  const actionInProgressSignal = signal<Record<string, unknown[]>>({});

  beforeEach(async () => {
    actionInProgressSignal.set({});

    await TestBed.configureTestingModule({
      imports: [RemoteCardComponent],
      providers: [
        provideTranslateService(),
        {
          provide: PathService,
          useValue: {
            isLocalPath: vi.fn(() => false),
            getFilename: vi.fn((p: string) => p),
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
            actionInProgress: actionInProgressSignal,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteCardComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('remote', createMockRemote());
    fixture.detectChanges();
  });

  const running = (op: 'mount' | 'sync' | 'check', profile = 'default'): Partial<RemoteStatus> => ({
    [op]: { active: true, configuredProfiles: [profile], activeProfiles: { [profile]: 1 } },
  });

  const host = (): HTMLElement => fixture.nativeElement;

  it('is idle, primary-toned and not marked active when nothing is running', () => {
    expect(component.isActive()).toBe(false);
    expect(component.cardTone()).toBe('primary');
    expect(host().classList.contains('is-active')).toBe(false);
  });

  it('is active and takes the operation tone when a mount runs in general mode', () => {
    fixture.componentRef.setInput('remote', createMockRemote(running('mount')));
    fixture.detectChanges();

    expect(component.isActive()).toBe(true);
    expect(component.cardTone()).toBe(OPERATION_TONE['mount']);
    expect(host().classList.contains('is-active')).toBe(true);
    expect(host().getAttribute('data-tone')).toBe(OPERATION_TONE['mount']);
  });

  it('is active when sync runs in operations mode', () => {
    fixture.componentRef.setInput('mode', 'operations');
    fixture.componentRef.setInput('remote', createMockRemote(running('sync', 'daily')));
    fixture.detectChanges();

    expect(component.isActive()).toBe(true);
  });

  it('ignores operations of other tabs: a mount does not light the operations tab', () => {
    fixture.componentRef.setInput('mode', 'operations');
    fixture.componentRef.setInput('remote', createMockRemote(running('mount')));
    fixture.detectChanges();

    expect(component.isActive()).toBe(false);
    expect(component.cardTone()).toBe('primary');
  });

  it('counts a running check, which has no button of its own, as activity', () => {
    fixture.componentRef.setInput(
      'remote',
      createMockRemote({
        check: { active: true, configuredProfiles: ['c'], activeProfiles: { c: 1 } },
      })
    );
    fixture.detectChanges();

    expect(component.isActive()).toBe(true);
    expect(component.cardTone()).toBe(OPERATION_TONE['check']);
    expect(component.statusIndicatorViewModels().map(vm => vm.op)).toEqual(['check']);
  });

  it('shows a status indicator only for running operations that have no action button', () => {
    fixture.componentRef.setInput(
      'remote',
      createMockRemote({
        ...running('mount'),
        check: { active: true, configuredProfiles: ['c'], activeProfiles: { c: 1 } },
      })
    );
    fixture.detectChanges();

    const indicators = component.statusIndicatorViewModels();
    expect(indicators.map(vm => vm.op)).toEqual(['check']);
    expect(indicators[0].profiles).toBe('c');
  });

  it('does not rebuild its buttons when an action starts on another remote', () => {
    const before = component.actionButtons();

    actionInProgressSignal.set({ 'other-remote': [{ type: 'sync' }] });

    expect(component.actionButtons()).toBe(before);
  });

  it('marks its own button busy while one of its actions is in flight', () => {
    actionInProgressSignal.set({ 'test-remote': [{ type: 'mount' }] });

    const mount = component.actionButtons().find(b => b.id === 'mount');
    expect(mount?.isLoading).toBe(true);
    expect(mount?.isDisabled).toBe(true);
  });

  it('describes a running operation with the stop key and its profile', () => {
    fixture.componentRef.setInput('remote', createMockRemote(running('mount')));
    fixture.detectChanges();

    const mount = component.actionButtons().find(b => b.id === 'mount');
    expect(mount?.tooltipKey).toBe(OPERATION_META['mount'].stopTooltip);
    expect(mount?.tooltipProfile).toBe('default');
    expect(mount?.tone).toBe('warn');
  });

  it('offers a profile menu only for operations with several profiles', () => {
    fixture.componentRef.setInput(
      'remote',
      createMockRemote({
        sync: { active: false, configuredProfiles: ['daily', 'weekly'], activeProfiles: {} },
      })
    );
    fixture.detectChanges();

    const pickers = component.profilePickers();
    expect(Object.keys(pickers)).toEqual(['sync']);
    expect(pickers['sync'].entries.map(e => e.profile)).toEqual(['daily', 'weekly']);
  });

  it('builds no profile menus for the detailed layout', () => {
    fixture.componentRef.setInput('displayMode', 'detailed');
    fixture.componentRef.setInput(
      'remote',
      createMockRemote({
        sync: { active: false, configuredProfiles: ['daily', 'weekly'], activeProfiles: {} },
      })
    );
    fixture.detectChanges();

    expect(component.profilePickers()).toEqual({});
  });

  it('lists the folders of running profiles for the browse button', () => {
    fixture.componentRef.setInput(
      'remote',
      createMockRemote({
        mount: {
          active: true,
          configuredProfiles: ['default'],
          activeProfiles: { default: '/mnt/drive' },
        },
      })
    );
    fixture.detectChanges();

    expect(component.openableFolders()).toEqual([
      expect.objectContaining({
        operation: 'mount',
        profile: 'default',
        path: '/mnt/drive',
        label: 'default',
        detail: 'drive',
        isOpening: false,
      }),
    ]);
  });

  it('emits openInFiles for a folder chosen on the browse button', () => {
    const spy = vi.fn();
    component.openInFiles.subscribe(spy);

    component.onOpenFolder({
      key: 'k',
      operation: 'mount',
      profile: 'default',
      path: '/mnt/drive',
      icon: 'folder',
      tone: 'primary',
      detail: 'drive',
      isOpening: false,
    });

    expect(spy).toHaveBeenCalledWith({
      remoteName: 'test-remote',
      path: '/mnt/drive',
      profileName: 'default',
      operationType: 'mount',
    });
  });

  it('starts an idle profile and stops a running one through the same toggle', () => {
    const start = vi.fn();
    const stop = vi.fn();
    component.startJob.subscribe(start);
    component.stopJob.subscribe(stop);

    component.onProfileToggle({ operation: 'sync', profile: 'daily' });
    expect(start).toHaveBeenCalledWith({
      type: 'sync',
      remoteName: 'test-remote',
      profileName: 'daily',
    });

    fixture.componentRef.setInput('remote', createMockRemote(running('sync', 'daily')));
    fixture.detectChanges();
    component.onProfileToggle({ operation: 'sync', profile: 'daily' });
    expect(stop).toHaveBeenCalledWith({
      type: 'sync',
      remoteName: 'test-remote',
      profileName: 'daily',
    });
  });

  it('does nothing when the button of an idle operation with several profiles is clicked', () => {
    const start = vi.fn();
    component.startJob.subscribe(start);
    fixture.componentRef.setInput(
      'remote',
      createMockRemote({
        sync: { active: false, configuredProfiles: ['a', 'b'], activeProfiles: {} },
      })
    );
    fixture.detectChanges();

    component.onActionButtonClick('sync');

    expect(start).not.toHaveBeenCalled();
  });

  it('emits remoteClick when card is clicked and not editing layout', () => {
    const emitSpy = vi.fn();
    component.remoteClick.subscribe(emitSpy);

    component.onRemoteClick();

    expect(emitSpy).toHaveBeenCalledWith(component.remote());
  });

  it('emits toggleHidden with remote name when toggle button is triggered', () => {
    const toggleSpy = vi.fn();
    component.toggleHidden.subscribe(toggleSpy);

    const mockEvent = new MouseEvent('click');
    component.onToggleHidden(mockEvent);

    expect(toggleSpy).toHaveBeenCalledWith('test-remote');
  });

  it('emits startJob when an inactive action with exactly 1 profile is clicked', () => {
    const startJobSpy = vi.fn();
    component.startJob.subscribe(startJobSpy);

    component.onActionButtonClick('mount');

    expect(startJobSpy).toHaveBeenCalledWith({
      type: 'mount',
      remoteName: 'test-remote',
      profileName: 'default',
    });
  });

  it('emits stopJob when an active operation is clicked', () => {
    const activeRemote = createMockRemote({
      mount: {
        active: true,
        configuredProfiles: ['default'],
        activeProfiles: { default: 1 },
      },
    });
    fixture.componentRef.setInput('remote', activeRemote);
    fixture.detectChanges();

    const stopJobSpy = vi.fn();
    component.stopJob.subscribe(stopJobSpy);

    component.onActionButtonClick('mount');

    expect(stopJobSpy).toHaveBeenCalledWith({
      type: 'mount',
      remoteName: 'test-remote',
      profileName: 'default',
    });
  });

  it('handles Enter keydown on the card container', () => {
    const emitSpy = vi.fn();
    component.remoteClick.subscribe(emitSpy);

    const target = fixture.nativeElement;
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    Object.defineProperty(event, 'target', { value: target });
    Object.defineProperty(event, 'currentTarget', { value: target });

    component.onRemoteKeyDown(event);

    expect(emitSpy).toHaveBeenCalledWith(component.remote());
  });

  describe('status indicator meta', () => {
    const ops = Object.keys(STATUS_INDICATOR_META) as (keyof typeof STATUS_INDICATOR_META)[];

    it('has a pill for every primary operation, in its own tone', () => {
      expect(ops.sort()).toEqual(ALL_PRIMARY_ACTIONS.slice().sort());
      for (const op of ops) expect(STATUS_INDICATOR_META[op].tone).toBe(OPERATION_TONE[op]);
    });

    it('takes the icon of the operation, except serving which shows a spinning dish', () => {
      for (const op of ops.filter(o => o !== 'serve')) {
        expect(STATUS_INDICATOR_META[op].icon).toBe(OPERATION_ICONS[op]);
        expect(STATUS_INDICATOR_META[op].animateContainer).toBeUndefined();
      }
      expect(STATUS_INDICATOR_META.serve).toMatchObject({
        icon: 'satellite-dish',
        animateContainer: true,
      });
    });

    it('gives every pill an accessible name', () => {
      for (const op of ops) expect(STATUS_INDICATOR_META[op].ariaKey).toBeTruthy();
    });
  });
});
