import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { RemoteCardComponent } from './remote-card.component';
import {
  Remote,
  RemoteStatus,
  createDefaultRemoteStatus,
  createDefaultRemoteFeatures,
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

  it('initializes with inactive card variant when no operations are running', () => {
    expect(component.cardVariant()).toBe('inactive');
    expect(component.remoteCardClasses()['active-remote']).toBeFalsy();
    expect(component.remoteCardClasses()['inactive-remote']).toBe(true);
  });

  it('computes cardVariant as active when mount is active in general mode', () => {
    const activeRemote = createMockRemote({
      mount: {
        active: true,
        configuredProfiles: ['default'],
        activeProfiles: { default: 1 },
      },
    });
    fixture.componentRef.setInput('remote', activeRemote);
    fixture.detectChanges();

    expect(component.cardVariant()).toBe('active');
    expect(component.remoteCardClasses()['mounted']).toBe(true);
  });

  it('computes cardVariant as active when sync is active in operations mode', () => {
    fixture.componentRef.setInput('mode', 'operations');
    const syncRemote = createMockRemote({
      sync: {
        active: true,
        configuredProfiles: ['daily'],
        activeProfiles: { daily: 1 },
      },
    });
    fixture.componentRef.setInput('remote', syncRemote);
    fixture.detectChanges();

    expect(component.cardVariant()).toBe('active');
    expect(component.remoteCardClasses()['syncing']).toBe(true);
  });

  it('computes cardVariant as inactive in operations mode if only mount is active', () => {
    fixture.componentRef.setInput('mode', 'operations');
    const mountRemote = createMockRemote({
      mount: {
        active: true,
        configuredProfiles: ['default'],
        activeProfiles: { default: 1 },
      },
    });
    fixture.componentRef.setInput('remote', mountRemote);
    fixture.detectChanges();

    expect(component.cardVariant()).toBe('inactive');
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

    const event = new MouseEvent('click');
    component.onActionButtonClick({ id: 'mount', event });

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

    const event = new MouseEvent('click');
    component.onActionButtonClick({ id: 'mount', event });

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
});
