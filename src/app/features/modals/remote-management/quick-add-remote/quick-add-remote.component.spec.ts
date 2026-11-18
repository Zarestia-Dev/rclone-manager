import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickAddRemoteComponent } from './quick-add-remote.component';
import { RemoteCreationOrchestrator } from '../../../../services/remote/remote-creation-orchestrator.service';
import { RemoteManagementService } from '../../../../services/remote/remote-management.service';
import { AuthStateService } from '../../../../services/security/auth-state.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { ValidatorRegistryService } from '../../../../services/ui/validation/validator-registry.service';
import { IconService } from '../../../../services/ui/icon.service';
import { ModalService } from '../../../../services/ui/modal.service';
import { PathService } from '../../../../services/infrastructure/platform/path.service';
import { BackendService } from '../../../../services/infrastructure/system/backend.service';
import { PresetValues, RemotePresetsService } from '../../../../services/remote/remote-presets';
import { createInitialInteractiveFlowState } from '../../../../services/remote/utils/interactive-flow.utils';
import { OPERATION_TONE } from '@app/types';

describe('QuickAddRemoteComponent submission', () => {
  let component: QuickAddRemoteComponent;
  const close = vi.fn();
  const notifyError = vi.fn();
  const createRemote = vi.fn();
  const submitAnswer = vi.fn();
  const openQuickRunEditor = vi.fn();
  const flow = signal(createInitialInteractiveFlowState());

  beforeEach(async () => {
    close.mockReset();
    notifyError.mockReset();
    createRemote.mockReset().mockResolvedValue(true);
    submitAnswer.mockReset().mockResolvedValue(false);
    openQuickRunEditor.mockReset();
    flow.set(createInitialInteractiveFlowState());
    TestBed.configureTestingModule({
      providers: [
        { provide: MatDialogRef, useValue: { close } },
        {
          provide: RemoteCreationOrchestrator,
          useValue: {
            createRemote,
            interactiveFlowState: flow,
            isInteractiveContinueDisabled: signal(false),
            oauthHelperUrl: signal(null),
            submitInteractiveAnswer: submitAnswer,
            cancelAuth: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RemoteManagementService,
          useValue: {
            getOAuthSupportedRemotes: vi.fn().mockResolvedValue([]),
            getRemotes: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: AuthStateService,
          useValue: { isAuthInProgress: signal(false), isAuthCancelled: signal(false) },
        },
        { provide: NotificationService, useValue: { showError: notifyError } },
        {
          provide: ValidatorRegistryService,
          useValue: { createRemoteNameValidator: vi.fn().mockReturnValue(() => null) },
        },
        { provide: IconService, useValue: {} },
        { provide: ModalService, useValue: { openQuickRunEditor } },
        PathService,
        { provide: BackendService, useValue: { isWindows: (): boolean => false } },
        { provide: RemotePresetsService, useValue: { resolvePresets: (): PresetValues => ({}) } },
      ],
    });
    component = TestBed.runInInjectionContext(() => new QuickAddRemoteComponent());
    await Promise.resolve();
    await Promise.resolve();
    component.setupFormGroup.patchValue({ name: 'new-remote', type: 'drive' });
  });

  it('delegates complete remote creation and shows the next step only on explicit success', async () => {
    await component.onSubmit();
    expect(createRemote).toHaveBeenCalledWith(
      { name: 'new-remote', type: 'drive' },
      expect.objectContaining({ showOnTray: true, mountConfigs: expect.any(Object) }),
      component.commandOptions()
    );
    expect(component.currentStep()).toBe('next');
    expect(component.createdRemoteName()).toBe('new-remote');
    expect(close).not.toHaveBeenCalled();
  });

  it('passes OAuth provider overviews to the shared remote configuration step', async () => {
    const overview = { Tier: 'Tier 1', Hashes: ['md5'], Features: ['Copy'] };
    vi.mocked(TestBed.inject(RemoteManagementService).getOAuthSupportedRemotes).mockResolvedValue([
      { name: 'drive', description: 'Google Drive', overview },
    ]);
    await component.initializeComponent();
    expect(component.remoteTypes()).toEqual([{ value: 'drive', label: 'Google Drive', overview }]);
  });

  it('shows errors and retains the form when creation fails', async () => {
    const error = new Error('offline');
    createRemote.mockRejectedValue(error);
    await component.onSubmit();
    expect(notifyError).toHaveBeenCalledWith(error);
    expect(close).not.toHaveBeenCalled();
  });

  it('shows pending interactive questions without claiming completion', async () => {
    createRemote.mockImplementation(async () => {
      flow.update(state => ({ ...state, isActive: true }));
      return false;
    });
    await component.onSubmit();
    expect(component.currentStep()).toBe('interactive');
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps a failed settings finalization available for interactive retry', async () => {
    createRemote.mockImplementation(async () => {
      flow.update(state => ({
        ...state,
        isActive: true,
        question: { State: '', Option: null, Error: '' },
      }));
      throw new Error('disk full');
    });
    await component.onSubmit();
    expect(component.currentStep()).toBe('interactive');
    expect(close).not.toHaveBeenCalled();
  });

  it('blocks navigation and submission while metadata is loading or unavailable', async () => {
    component.isInitializing.set(true);
    component.nextStep();
    await component.onSubmit();
    expect(component.currentStep()).toBe('setup');
    expect(createRemote).not.toHaveBeenCalled();
    component.isInitializing.set(false);
    component.loadFailed.set(true);
    await component.onSubmit();
    expect(createRemote).not.toHaveBeenCalled();
  });

  it('requires a schedule when its automation is enabled', async () => {
    component.quickAddForm.get('operations.sync.cronEnabled')?.setValue(true);
    await component.onSubmit();
    expect(createRemote).not.toHaveBeenCalled();
  });

  it('does not infer success from an inactive interactive flow', async () => {
    await component.onInteractiveContinue(null);
    expect(close).not.toHaveBeenCalled();
  });

  it('shows the next step only when continuation explicitly succeeds', async () => {
    submitAnswer.mockResolvedValue(true);
    await component.onInteractiveContinue('yes');
    expect(component.currentStep()).toBe('next');
    expect(component.createdRemoteName()).toBe('new-remote');
    expect(close).not.toHaveBeenCalled();
  });

  it('ignores repeated continuation clicks while processing', async () => {
    flow.update(state => ({ ...state, isProcessing: true }));
    await component.onInteractiveContinue('yes');
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  describe('next step', () => {
    it('offers mount, copy, sync and bisync with their registry tones', () => {
      expect(component.nextGoals.map(goal => goal.op)).toEqual(['mount', 'copy', 'sync', 'bisync']);
      for (const goal of component.nextGoals) {
        expect(goal.tone).toBe(OPERATION_TONE[goal.op]);
        expect(goal.icon).toBeTruthy();
        expect(goal.title).toBe(`modals.quickAdd.next.goals.${goal.op}.title`);
      }
    });

    it('closes the wizard and opens a Quick Run for the chosen goal and the new remote', async () => {
      await component.onSubmit();
      component.startGoal('bisync');
      expect(close).toHaveBeenCalledExactlyOnceWith(true);
      expect(openQuickRunEditor).toHaveBeenCalledExactlyOnceWith({
        initialOpType: 'bisync',
        initialRemoteName: 'new-remote',
      });
    });

    it('keeps the created name even if the setup form changes afterwards', async () => {
      component.setupFormGroup.patchValue({ name: 'my drive_2 (work)' });
      await component.onSubmit();
      component.setupFormGroup.patchValue({ name: '' });
      component.startGoal('mount');
      expect(openQuickRunEditor).toHaveBeenCalledWith(
        expect.objectContaining({ initialRemoteName: 'my drive_2 (work)' })
      );
    });

    it('closes successfully without opening anything when done', async () => {
      await component.onSubmit();
      component.finish();
      expect(close).toHaveBeenCalledExactlyOnceWith(true);
      expect(openQuickRunEditor).not.toHaveBeenCalled();
    });
  });
});
