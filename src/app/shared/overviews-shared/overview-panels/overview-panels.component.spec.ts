import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CdkDragDrop } from '@angular/cdk/drag-drop';
import { By } from '@angular/platform-browser';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideTranslateService } from '@ngx-translate/core';
import { DashboardPanel, OverviewLayout, PanelId } from '@app/types';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { OverviewPanelDirective, OverviewPanelsComponent } from './overview-panels.component';

const layout: OverviewLayout = {
  id: 'general',
  panels: [
    { id: 'remotes', title: 'remotes', defaultVisible: true, resettable: true },
    { id: 'bandwidth', title: 'bandwidth', defaultVisible: true },
    { id: 'jobs', title: 'jobs', defaultVisible: true },
  ],
  setting: 'dashboard_layout',
  openStatesKey: 'test.open',
  openByDefault: { remotes: true },
  hasViewToggle: true,
};

@Component({
  imports: [OverviewPanelsComponent, OverviewPanelDirective],
  template: `
    <app-overview-panels
      [layout]="layout"
      (layoutReset)="resets = resets + 1"
      (panelReset)="panelResets.push($event)"
    >
      <ng-template appOverviewPanel="remotes" let-open let-setOpen="setOpen">
        <button class="remotes" (click)="setOpen(!open)">remotes {{ open }}</button>
      </ng-template>
      <ng-template appOverviewPanel="jobs" let-open let-setOpen="setOpen">
        <button class="jobs" (click)="setOpen(!open)">jobs {{ open }}</button>
      </ng-template>
    </app-overview-panels>
  `,
})
class HostComponent {
  layout = layout;
  resets = 0;
  panelResets: PanelId[] = [];
}

interface Internals {
  drop(event: Pick<CdkDragDrop<DashboardPanel[]>, 'previousIndex' | 'currentIndex'>): void;
  togglePanelVisibility(id: PanelId): void;
}

describe('OverviewPanelsComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  const editing = signal<string | null>(null);
  const getSettingValue = vi.fn();
  const saveSetting = vi.fn();
  const storedOpen = vi.fn();
  const storeOpen = vi.fn();
  const toggleLayoutEdit = vi.fn();
  const openSnackBar = vi.fn();

  const create = async (saved?: unknown, open?: Record<string, boolean>): Promise<void> => {
    getSettingValue.mockResolvedValue(saved);
    storedOpen.mockImplementation((_key: string, fallback: unknown) => open ?? fallback);
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  const panels = (): OverviewPanelsComponent =>
    fixture.debugElement.query(By.directive(OverviewPanelsComponent)).componentInstance;
  const internals = (): Internals => panels() as unknown as Internals;
  const wrappers = (): HTMLElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.draggable-panel-wrapper'));
  const labels = (): string[] =>
    wrappers().map(el => el.querySelector('.panel-content-wrapper button')?.className ?? '(empty)');

  beforeEach(() => {
    editing.set(null);
    vi.clearAllMocks();
    saveSetting.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideTranslateService(),
        { provide: AppSettingsService, useValue: { getSettingValue, saveSetting } },
        { provide: LocalStorageService, useValue: { get: storedOpen, set: storeOpen } },
        { provide: MatSnackBar, useValue: { open: openSnackBar } },
        {
          provide: UiStateService,
          useValue: {
            isEditingOverview: (id: string): boolean => editing() === id,
            toggleLayoutEdit,
          },
        },
      ],
    });
  });

  it('shows the panels in their default order, with what the overview gives each', async () => {
    await create();
    expect(labels()).toEqual(['remotes', '(empty)', 'jobs']);
  });

  it('applies the saved order and visibility, and shows hidden panels while editing', async () => {
    await create({ order: ['jobs', 'remotes', 'bandwidth'], hidden: ['remotes'] });
    expect(getSettingValue).toHaveBeenCalledWith('runtime.dashboard_layout');
    expect(labels()).toEqual(['jobs', '(empty)']);

    editing.set('general');
    fixture.detectChanges();
    expect(labels()).toEqual(['jobs', 'remotes', '(empty)']);
    expect(wrappers()[1].querySelector('.panel-hidden-visual')).not.toBeNull();
  });

  it('keeps the default layout when the saved one cannot be read', async () => {
    getSettingValue.mockRejectedValue(new Error('no settings'));
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(labels()).toEqual(['remotes', '(empty)', 'jobs']);
  });

  describe('expanded panels', () => {
    it('start from the defaults and from what was stored', async () => {
      await create();
      expect(fixture.nativeElement.querySelector('.remotes').textContent).toContain('true');
      expect(fixture.nativeElement.querySelector('.jobs').textContent).toContain('false');
      expect(storedOpen).toHaveBeenCalledWith('test.open', { remotes: true });
    });

    it('use the stored state over the defaults', async () => {
      await create(undefined, { jobs: true });
      expect(fixture.nativeElement.querySelector('.remotes').textContent).toContain('false');
      expect(fixture.nativeElement.querySelector('.jobs').textContent).toContain('true');
    });

    it('are remembered when a panel opens or closes', async () => {
      await create();
      fixture.nativeElement.querySelector('.jobs').click();
      fixture.detectChanges();
      expect(storeOpen).toHaveBeenCalledWith('test.open', { remotes: true, jobs: true });
      expect(fixture.nativeElement.querySelector('.jobs').textContent).toContain('true');
    });
  });

  describe('layout editing', () => {
    it('saves the order after a panel is dragged', async () => {
      await create();
      internals().drop({ previousIndex: 0, currentIndex: 2 });
      expect(saveSetting).toHaveBeenCalledWith('runtime', 'dashboard_layout', {
        order: ['bandwidth', 'jobs', 'remotes'],
        hidden: [],
      });
    });

    it('saves which panels are hidden', async () => {
      await create();
      internals().togglePanelVisibility('jobs');
      fixture.detectChanges();
      expect(saveSetting).toHaveBeenCalledWith('runtime', 'dashboard_layout', {
        order: ['remotes', 'bandwidth', 'jobs'],
        hidden: ['jobs'],
      });
      expect(labels()).toEqual(['remotes', '(empty)']);
    });

    it('starts the editing of its overview with a reset that restores the defaults', async () => {
      await create({ order: ['jobs'], hidden: ['remotes'] });
      panels().toggleEditLayout();
      expect(toggleLayoutEdit).toHaveBeenCalledWith({
        overviewId: 'general',
        hasViewToggle: true,
        onReset: expect.any(Function),
      });

      toggleLayoutEdit.mock.calls[0][0].onReset();
      fixture.detectChanges();

      expect(saveSetting).toHaveBeenCalledWith('runtime', 'dashboard_layout', {
        order: [],
        hidden: [],
      });
      expect(labels()).toEqual(['remotes', '(empty)', 'jobs']);
      expect(openSnackBar).toHaveBeenCalledTimes(1);
      expect(fixture.componentInstance.resets).toBe(1);
    });

    it('offers a reset only on the panels that can be reset', async () => {
      await create();
      expect(fixture.nativeElement.querySelector('.card-layout-toggle')).toBeNull();

      editing.set('general');
      fixture.detectChanges();
      const buttons = fixture.nativeElement.querySelectorAll('.card-layout-toggle');
      expect(buttons).toHaveLength(1);

      buttons[0].click();
      expect(fixture.componentInstance.panelResets).toEqual(['remotes']);
    });
  });
});
