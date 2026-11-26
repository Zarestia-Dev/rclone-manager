import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { MountsOverviewPanelComponent } from './mounts-overview-panel.component';
import { MountedRemote } from '@app/types';
import { MountManagementService } from 'src/app/services/operations/mount-management.service';
import { NavigationDispatcherService } from 'src/app/services/ui/navigation-dispatcher.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { OriginFilterService } from 'src/app/services/ui/state/origin-filter.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

describe('MountsOverviewPanelComponent', () => {
  let component: MountsOverviewPanelComponent;
  let fixture: ComponentFixture<MountsOverviewPanelComponent>;

  // The chips choose the filter, and only while they are shown.
  const chooseFilter = (filter: string): void => {
    fixture.componentRef.setInput('showFilterChips', true);
    TestBed.inject(OriginFilterService).set('mounts', filter);
  };
  const mountedRemotes = signal<MountedRemote[]>([]);
  const unmountRemote = vi.fn().mockResolvedValue(undefined);
  const navigateToOwner = vi.fn();
  const openRemoteInFiles = vi.fn().mockResolvedValue(undefined);

  const mounts: MountedRemote[] = [
    {
      fs: 'drive:',
      mount_point: '/mnt/drive',
      origin: 'dashboard',
      starter: { kind: 'profile', name: 'work' },
    },
    {
      fs: 's3:bucket/dir',
      mount_point: '/mnt/s3',
      origin: 'quickrun',
      starter: { kind: 'quick_run', id: 'qr-1', name: 'qr-1' },
    },
    { fs: 'dropbox:', mount_point: 'M:', origin: 'workflow' },
    // Mounted at startup: it belongs to the remote's own profile.
    {
      fs: 'box:',
      mount_point: '/mnt/box',
      origin: 'startup',
      starter: { kind: 'profile', name: 'auto' },
    },
  ];

  beforeEach(async () => {
    localStorage.removeItem('rcman.overview.originFilters');
    mountedRemotes.set(mounts);
    unmountRemote.mockClear();
    navigateToOwner.mockClear();
    openRemoteInFiles.mockClear();

    await TestBed.configureTestingModule({
      imports: [MountsOverviewPanelComponent],
      providers: [
        provideTranslateService(),
        { provide: MountManagementService, useValue: { mountedRemotes, unmountRemote } },
        { provide: NavigationDispatcherService, useValue: { navigateToOwner } },
        { provide: RemoteFacadeService, useValue: { openRemoteInFiles } },
        {
          provide: PathService,
          useValue: { getRemoteNameFromFs: (fs: string): string => fs.split(':')[0] },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MountsOverviewPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('lists every mount by default', () => {
    expect(component.allMounts()).toEqual(mounts);
  });

  it.each([
    ['dashboard', ['/mnt/drive', '/mnt/box']],
    ['quickrun', ['/mnt/s3']],
    ['workflow', ['M:']],
    ['startup', ['/mnt/box']],
    ['filemanager', []],
  ])('filters by the %s origin', (filter, expected) => {
    chooseFilter(filter);
    expect(component.allMounts().map(m => m.mount_point)).toEqual(expected);
  });

  it('starts on every origin', () => {
    expect(component.selectedOriginFilter()).toBe('all');
  });

  it('only offers filters represented by mounts and hides a redundant filter row', () => {
    fixture.componentRef.setInput('showFilterChips', true);
    fixture.detectChanges();
    expect(
      Array.from<HTMLElement>(
        fixture.nativeElement.querySelectorAll('app-origin-filter-bar button')
      ).map(button => button.textContent?.trim())
    ).toEqual([
      'common.all',
      'alerts.origins.workflow',
      'alerts.origins.quickrun',
      'alerts.origins.dashboard',
    ]);

    mountedRemotes.set([mounts[0]]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-origin-filter-bar')).toBeNull();
    expect(component.selectedOriginFilter()).toBe('all');
    expect(component.allMounts()).toEqual([mounts[0]]);
  });

  it('counts the mounts a chip leaves out', () => {
    expect(component.hiddenCount()).toBe(0);
    chooseFilter('quickrun');
    expect(component.hiddenCount()).toBe(3);
  });

  it('remembers the chip that is picked', () => {
    fixture.componentRef.setInput('showFilterChips', true);
    fixture.detectChanges();
    const chips = fixture.nativeElement.querySelectorAll('app-origin-filter-bar button');
    (chips[2] as HTMLButtonElement).click();
    expect(TestBed.inject(OriginFilterService).get('mounts', component.availableOrigins())).toBe(
      'quickrun'
    );
    expect(component.selectedOriginFilter()).toBe('quickrun');
  });

  it('takes the remembered chip only while the chips are shown', () => {
    TestBed.inject(OriginFilterService).set('mounts', 'quickrun');
    expect(component.selectedOriginFilter()).toBe('all');
    fixture.componentRef.setInput('showFilterChips', true);
    expect(component.selectedOriginFilter()).toBe('quickrun');
  });

  it('counts everything in the header when a chip hides all of it, and says so', () => {
    chooseFilter('update');
    fixture.detectChanges();
    expect(component.totalCount()).toBeGreaterThan(0);
    expect(component.hiddenCount()).toBe(component.totalCount());
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('mat-panel-description')?.textContent).not.toContain('noActive');
    expect(el.querySelector('.empty-state')?.textContent).toContain(
      'generalOverview.originFilter.empty'
    );
  });

  it('follows the mounts as they appear and disappear', () => {
    mountedRemotes.set([]);
    expect(component.allMounts()).toEqual([]);
    mountedRemotes.set([mounts[0]]);
    expect(component.allMounts()).toEqual([mounts[0]]);
  });

  it('shows the empty state without mounts and a card per mount otherwise', () => {
    expect(fixture.nativeElement.querySelectorAll('app-mount-card').length).toBe(4);
    mountedRemotes.set([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.empty-state')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('app-mount-card').length).toBe(0);
  });

  it('unmounts by mount point with the remote name taken from the filesystem', () => {
    component.onUnmount(mounts[1]);
    expect(unmountRemote).toHaveBeenCalledWith('/mnt/s3', 's3');
  });

  it('opens the mount point; where it opens is decided by the file system service', () => {
    component.onOpenMount(mounts[1]);
    expect(openRemoteInFiles).toHaveBeenCalledWith('s3', '/mnt/s3');
  });

  it('navigates to the mount on click', () => {
    component.onMountClick(mounts[0]);
    expect(navigateToOwner).toHaveBeenCalledWith(mounts[0], 'drive', 'mount');
  });
});
