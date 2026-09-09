import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { QuickRunWorkspaceComponent } from './quick-run-workspace.component';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { QuickRun, Remote } from '@app/types';

describe('QuickRunWorkspaceComponent', () => {
  let fixture: ComponentFixture<QuickRunWorkspaceComponent>;
  let component: QuickRunWorkspaceComponent;

  const quickRunsSignal = signal<QuickRun[]>([]);
  const selectedQuickRunSignal = signal<QuickRun | null>(null);
  const selectedRemoteSignal = signal<Remote | null>(null);
  const orderedRemotesSignal = signal<Remote[]>([]);

  const mockQuickRunService = {
    quickRuns: quickRunsSignal,
    selected: selectedQuickRunSignal,
    edit: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };

  const mockRemoteFacade = {
    selectedRemote: selectedRemoteSignal,
    orderedRemotes: orderedRemotesSignal,
    openRemoteAbout: vi.fn(),
    canEmptyTrash: vi.fn(),
    emptyTrash: vi.fn().mockResolvedValue(true),
    cloneRemote: vi.fn().mockResolvedValue(undefined),
    deleteRemote: vi.fn().mockResolvedValue(undefined),
  };

  const mockUiStateService = {
    selectedRemote: selectedRemoteSignal,
    resetSelectedRemote: vi.fn(),
    setSelectedRemote: vi.fn(),
    setMainView: vi.fn(),
  };

  const mockModalService = {
    openExport: vi.fn(),
    openLogs: vi.fn(),
    openRemoteAbout: vi.fn(),
    openDeleteRemote: vi.fn().mockReturnValue({
      afterClosed: () => of(true),
    }),
  };

  const mockNotificationService = {
    confirmModal: vi.fn().mockResolvedValue(true),
    showInfo: vi.fn(),
    showError: vi.fn(),
  };

  const mockAppSettingsService = {
    resetRemoteSettings: vi.fn().mockResolvedValue(undefined),
  };

  const mockRemote: Remote = {
    name: 'gdrive',
    type: 'drive',
  } as unknown as Remote;

  beforeEach(async () => {
    vi.clearAllMocks();
    quickRunsSignal.set([]);
    selectedQuickRunSignal.set(null);
    selectedRemoteSignal.set(null);
    orderedRemotesSignal.set([mockRemote]);

    await TestBed.configureTestingModule({
      imports: [QuickRunWorkspaceComponent],
      providers: [
        provideTranslateService(),
        { provide: QuickRunService, useValue: mockQuickRunService },
        { provide: RemoteFacadeService, useValue: mockRemoteFacade },
        { provide: UiStateService, useValue: mockUiStateService },
        { provide: ModalService, useValue: mockModalService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: AppSettingsService, useValue: mockAppSettingsService },
      ],
    })
      .overrideComponent(QuickRunWorkspaceComponent, {
        set: {
          template: '<div></div>',
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(QuickRunWorkspaceComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
  });

  describe('getTargetRemote', () => {
    it('should find remote by exact name or trailing colon stripped', () => {
      expect(component.getTargetRemote('gdrive:')).toEqual(mockRemote);
      expect(component.getTargetRemote('gdrive')).toEqual(mockRemote);
      expect(component.getTargetRemote('nonexistent:')).toBeUndefined();
    });
  });

  describe('Remote About & Trash Cleanup actions', () => {
    it('should delegate openRemoteAbout to RemoteFacadeService', () => {
      component.openRemoteAbout(mockRemote);
      expect(mockRemoteFacade.openRemoteAbout).toHaveBeenCalledWith(mockRemote);
    });

    it('should delegate canEmptyTrash to RemoteFacadeService', () => {
      mockRemoteFacade.canEmptyTrash.mockReturnValue(true);
      expect(component.canEmptyTrash(mockRemote)).toBe(true);
      expect(mockRemoteFacade.canEmptyTrash).toHaveBeenCalledWith(mockRemote);
    });

    it('should delegate emptyTrash to RemoteFacadeService with "flow" origin', async () => {
      await component.emptyTrash(mockRemote);
      expect(mockRemoteFacade.emptyTrash).toHaveBeenCalledWith(mockRemote, 'flow');
    });
  });

  describe('Other remote actions', () => {
    it('should clone remote via RemoteFacadeService', async () => {
      await component.cloneRemote('gdrive');
      expect(mockRemoteFacade.cloneRemote).toHaveBeenCalledWith('gdrive');
    });

    it('should open export modal via ModalService', () => {
      component.openExportModal('gdrive');
      expect(mockModalService.openExport).toHaveBeenCalledWith({ remoteName: 'gdrive' });
    });

    it('should reset remote settings after user confirmation', async () => {
      mockNotificationService.confirmModal.mockResolvedValue(true);
      await component.resetRemoteSettings('gdrive');
      expect(mockNotificationService.confirmModal).toHaveBeenCalled();
      expect(mockAppSettingsService.resetRemoteSettings).toHaveBeenCalledWith('gdrive');
    });

    it('should not reset remote settings if user cancels confirmation', async () => {
      mockNotificationService.confirmModal.mockResolvedValue(false);
      await component.resetRemoteSettings('gdrive');
      expect(mockAppSettingsService.resetRemoteSettings).not.toHaveBeenCalled();
    });

    it('should delete remote and reset selected remote if it matches', async () => {
      selectedRemoteSignal.set(mockRemote);
      await component.deleteRemote('gdrive');
      expect(mockModalService.openDeleteRemote).toHaveBeenCalledWith('gdrive');
      expect(mockRemoteFacade.deleteRemote).toHaveBeenCalledWith('gdrive');
      expect(mockUiStateService.resetSelectedRemote).toHaveBeenCalled();
    });
  });
});
