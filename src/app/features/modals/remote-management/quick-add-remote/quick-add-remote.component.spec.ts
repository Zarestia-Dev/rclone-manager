import { TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickAddRemoteComponent } from './quick-add-remote.component';
import { RemoteCreationOrchestrator } from '../../../../services/remote/remote-creation-orchestrator.service';
import { RemoteManagementService } from '../../../../services/remote/remote-management.service';
import { AuthStateService } from '../../../../services/security/auth-state.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { ValidatorRegistryService } from '../../../../services/ui/validation/validator-registry.service';
import { IconService } from '../../../../services/ui/icon.service';
import { PathService } from '../../../../services/infrastructure/platform/path.service';
import { BackendService } from '../../../../services/infrastructure/system/backend.service';
import { PresetValues, RemotePresetsService } from '../../../../services/remote/remote-presets';
import { createInitialInteractiveFlowState } from '../../../../services/remote/utils/remote-config.utils';
import { InteractiveFlowState } from '@app/types';

describe('QuickAddRemoteComponent submission', () => {
  let component: QuickAddRemoteComponent;
  let close: ReturnType<typeof vi.fn>;
  let notifyError: ReturnType<typeof vi.fn>;
  let orchestrator: {
    interactiveFlowState: WritableSignal<InteractiveFlowState>;
    isInteractiveContinueDisabled: WritableSignal<boolean>;
    oauthHelperUrl: WritableSignal<string | null>;
    startInteractiveCreation: ReturnType<typeof vi.fn>;
    finalizeCreation: ReturnType<typeof vi.fn>;
    setPendingConfig: ReturnType<typeof vi.fn>;
    submitInteractiveAnswer: ReturnType<typeof vi.fn>;
  };
  let createRemote: ReturnType<typeof vi.fn>;
  let resetAuthState: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    close = vi.fn();
    notifyError = vi.fn();
    const inProgress = signal(false);
    resetAuthState = vi.fn(() => inProgress.set(false));
    createRemote = vi.fn().mockResolvedValue(undefined);
    orchestrator = {
      interactiveFlowState: signal(createInitialInteractiveFlowState()),
      isInteractiveContinueDisabled: signal(false),
      oauthHelperUrl: signal(null),
      startInteractiveCreation: vi.fn().mockResolvedValue(true),
      finalizeCreation: vi.fn().mockResolvedValue(undefined),
      setPendingConfig: vi.fn(),
      submitInteractiveAnswer: vi.fn().mockResolvedValue(false),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: MatDialogRef, useValue: { close } },
        { provide: RemoteCreationOrchestrator, useValue: orchestrator },
        {
          provide: RemoteManagementService,
          useValue: {
            getOAuthSupportedRemotes: vi.fn().mockResolvedValue([]),
            getRemotes: vi.fn().mockResolvedValue([]),
            createRemote,
            buildOpt: vi.fn().mockReturnValue({}),
          },
        },
        {
          provide: AuthStateService,
          useValue: {
            isAuthInProgress: inProgress,
            isAuthCancelled: signal(false),
            startAuth: vi.fn(async () => inProgress.set(true)),
            resetAuthState,
            cancelAuth: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NotificationService, useValue: { showError: notifyError } },
        {
          provide: ValidatorRegistryService,
          useValue: {
            setupOperationValidation: vi.fn(),
            createRemoteNameValidator: vi.fn().mockReturnValue(() => null),
          },
        },
        { provide: IconService, useValue: {} },
        PathService,
        { provide: BackendService, useValue: { isWindows: (): boolean => false } },
        { provide: RemotePresetsService, useValue: { resolvePresets: (): PresetValues => ({}) } },
      ],
    });
    component = TestBed.runInInjectionContext(() => new QuickAddRemoteComponent());
    await Promise.resolve();
    component.setupFormGroup.patchValue({ name: 'new-remote', type: 'drive' });
    component.commandOptions.set([{ key: 'nonInteractive', value: true }]);
  });

  it('shows an initial interactive error without finalizing or closing as a success', async () => {
    const error = new Error('connection failed');
    orchestrator.startInteractiveCreation.mockRejectedValue(error);
    await component.onSubmit();
    expect(orchestrator.finalizeCreation).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(error);
    expect(resetAuthState).toHaveBeenCalledOnce();
  });

  it('keeps a completed backend flow available to retry a failed settings save', async () => {
    orchestrator.startInteractiveCreation.mockImplementation(async () => {
      orchestrator.interactiveFlowState.update(state => ({
        ...state,
        isActive: true,
        question: { State: '', Option: null, Error: '' },
      }));
      throw new Error('disk full');
    });
    await component.onSubmit();
    expect(component.currentStep()).toBe('interactive');
    expect(close).not.toHaveBeenCalled();
    expect(resetAuthState).not.toHaveBeenCalled();
  });

  it('closes after a successful interactive creation', async () => {
    await component.onSubmit();
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
    expect(orchestrator.finalizeCreation).not.toHaveBeenCalled();
  });

  it('does not finalize a failed non-interactive remote creation', async () => {
    component.commandOptions.set([]);
    createRemote.mockRejectedValue(new Error('unreachable'));
    await component.onSubmit();
    expect(orchestrator.finalizeCreation).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('finalizes a successful non-interactive remote creation', async () => {
    component.commandOptions.set([]);
    await component.onSubmit();
    expect(orchestrator.finalizeCreation).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not infer success merely because the interactive flow is inactive', async () => {
    await component.onInteractiveContinue(null);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes when answer submission explicitly succeeds', async () => {
    orchestrator.submitInteractiveAnswer.mockResolvedValue(true);
    await component.onInteractiveContinue('yes');
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('ignores repeated continuation clicks while processing', async () => {
    orchestrator.interactiveFlowState.update(state => ({ ...state, isProcessing: true }));
    await component.onInteractiveContinue('yes');
    expect(orchestrator.submitInteractiveAnswer).not.toHaveBeenCalled();
  });
});
