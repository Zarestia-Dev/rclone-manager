import { TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RcConfigQuestionResponse, RemoteConfigSections } from '@app/types';
import { RemoteCreationOrchestrator } from './remote-creation-orchestrator.service';
import { RemoteManagementService } from './remote-management.service';
import { AuthStateService } from '../security/auth-state.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { JobManagementService } from '../operations/job-management.service';
import { NotificationService } from '../ui/notification.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { PathInspectionService } from '../infrastructure/platform/path-inspection.service';

describe('RemoteCreationOrchestrator', () => {
  let service: RemoteCreationOrchestrator;
  const remote = { name: 'my-drive', type: 'drive' };
  const config: RemoteConfigSections = { showOnTray: true };
  const question: RcConfigQuestionResponse = { State: 'question-token', Option: null, Error: '' };
  const complete: RcConfigQuestionResponse = { State: '', Option: null, Error: '' };
  let remoteService: {
    startRemoteConfigInteractive: ReturnType<typeof vi.fn>;
    continueRemoteConfigInteractive: ReturnType<typeof vi.fn>;
    getRemotes: ReturnType<typeof vi.fn>;
    buildOpt: ReturnType<typeof vi.fn>;
  };
  let saveSettings: ReturnType<typeof vi.fn>;
  let auth: {
    isAuthInProgress: WritableSignal<boolean>;
    isAuthCancelled: WritableSignal<boolean>;
    oauthUrl: WritableSignal<string | null>;
    resetAuthState: ReturnType<typeof vi.fn>;
    cancelAuth: ReturnType<typeof vi.fn>;
  };
  let startBatch: ReturnType<typeof vi.fn>;
  let notifyError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    remoteService = {
      startRemoteConfigInteractive: vi.fn().mockResolvedValue(question),
      continueRemoteConfigInteractive: vi.fn().mockResolvedValue(complete),
      getRemotes: vi.fn().mockResolvedValue(['my-drive']),
      buildOpt: vi.fn().mockReturnValue({}),
    };
    saveSettings = vi.fn().mockResolvedValue(undefined);
    auth = {
      isAuthInProgress: signal(true),
      isAuthCancelled: signal(false),
      oauthUrl: signal(null),
      resetAuthState: vi.fn(),
      cancelAuth: vi.fn().mockResolvedValue(undefined),
    };
    startBatch = vi.fn().mockResolvedValue(undefined);
    notifyError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        RemoteCreationOrchestrator,
        { provide: BackendService, useValue: { activeBackend: signal('Local') } },
        { provide: RemoteManagementService, useValue: remoteService },
        { provide: AuthStateService, useValue: auth },
        { provide: AppSettingsService, useValue: { saveRemoteSettings: saveSettings } },
        {
          provide: MountManagementService,
          useValue: { mountRemoteProfile: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ServeManagementService,
          useValue: { startServeProfile: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: JobManagementService, useValue: { startProfileBatch: startBatch } },
        { provide: NotificationService, useValue: { showError: notifyError } },
        {
          provide: PathInspectionService,
          useValue: { createRequiredDirectories: vi.fn().mockResolvedValue(undefined) },
        },
      ],
    });
    service = TestBed.inject(RemoteCreationOrchestrator);
  });

  it('waits for answers without saving settings when the backend asks a question', async () => {
    expect(await service.startInteractiveCreation(remote, config, [])).toBe(false);
    expect(service.interactiveFlowState()).toMatchObject({ isActive: true, question });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('reports initial backend failures without finalizing creation', async () => {
    remoteService.startRemoteConfigInteractive.mockRejectedValue(new Error('connection failed'));
    await expect(service.startInteractiveCreation(remote, config, [])).rejects.toThrow(
      'connection failed'
    );
    expect(saveSettings).not.toHaveBeenCalled();
    expect(service.interactiveFlowState().isActive).toBe(false);
  });

  it('completes a flow with no questions and does not finalize it twice', async () => {
    remoteService.startRemoteConfigInteractive.mockResolvedValue(complete);
    expect(await service.startInteractiveCreation(remote, config, [])).toBe(true);
    await service.finalizeCreation();
    expect(saveSettings).toHaveBeenCalledExactlyOnceWith(remote.name, config, undefined, 'Local');
    expect(auth.resetAuthState).toHaveBeenCalledOnce();
    expect(service.interactiveFlowState().isActive).toBe(false);
  });

  it('reports success only after the last answer and settings have been saved', async () => {
    await service.startInteractiveCreation(remote, config, []);
    expect(await service.submitInteractiveAnswer('yes', [])).toBe(true);
    expect(saveSettings).toHaveBeenCalledExactlyOnceWith(remote.name, config, undefined, 'Local');
    expect(auth.resetAuthState).toHaveBeenCalledOnce();
    expect(service.interactiveFlowState().isActive).toBe(false);
  });

  it('keeps the flow open when the backend returns another question', async () => {
    remoteService.continueRemoteConfigInteractive.mockResolvedValue({ ...question, State: 'next' });
    await service.startInteractiveCreation(remote, config, []);
    expect(await service.submitInteractiveAnswer('', [])).toBe(false);
    expect(service.interactiveFlowState()).toMatchObject({
      isActive: true,
      question: { State: 'next' },
      isProcessing: false,
    });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('keeps a failed answer retryable without claiming completion', async () => {
    remoteService.continueRemoteConfigInteractive.mockRejectedValue(new Error('network failure'));
    await service.startInteractiveCreation(remote, config, []);
    service.interactiveFlowState.update(state => ({ ...state, isProcessing: true }));
    expect(await service.submitInteractiveAnswer(null, [])).toBe(false);
    expect(service.interactiveFlowState()).toMatchObject({
      isActive: true,
      question,
      isProcessing: false,
    });
    expect(saveSettings).not.toHaveBeenCalled();
    expect(auth.resetAuthState).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledOnce();
  });

  it('retries a failed settings save without resubmitting the last backend answer', async () => {
    saveSettings.mockRejectedValueOnce(new Error('disk full'));
    await service.startInteractiveCreation(remote, config, []);
    expect(await service.submitInteractiveAnswer('yes', [])).toBe(false);
    expect(service.interactiveFlowState()).toMatchObject({
      isActive: true,
      question: complete,
      isProcessing: false,
    });
    expect(auth.resetAuthState).not.toHaveBeenCalled();

    expect(await service.submitInteractiveAnswer('yes', [])).toBe(true);
    expect(remoteService.continueRemoteConfigInteractive).toHaveBeenCalledOnce();
    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(auth.resetAuthState).toHaveBeenCalledOnce();
  });

  it('can retry saving when a flow with no questions fails during persistence', async () => {
    remoteService.startRemoteConfigInteractive.mockResolvedValue(complete);
    saveSettings.mockRejectedValueOnce(new Error('disk full'));
    await expect(service.startInteractiveCreation(remote, config, [])).rejects.toThrow('disk full');
    expect(service.interactiveFlowState().isActive).toBe(true);
    expect(await service.submitInteractiveAnswer(null, [])).toBe(true);
    expect(remoteService.startRemoteConfigInteractive).toHaveBeenCalledOnce();
    expect(remoteService.continueRemoteConfigInteractive).not.toHaveBeenCalled();
  });

  it('keeps the original backend through an interactive flow and settings preparation', async () => {
    expect(await service.startInteractiveCreation(remote, config, [])).toBe(false);
    const backend = TestBed.inject(BackendService).activeBackend as WritableSignal<string>;
    backend.set('B');
    expect(await service.submitInteractiveAnswer('yes', [])).toBe(true);
    expect(remoteService.continueRemoteConfigInteractive).toHaveBeenCalledWith(
      remote.name,
      question.State,
      'yes',
      { type: remote.type },
      {},
      'Local'
    );
    expect(TestBed.inject(PathInspectionService).createRequiredDirectories).toHaveBeenCalledWith(
      config,
      'Local'
    );
    expect(saveSettings).toHaveBeenCalledWith(remote.name, config, undefined, 'Local');
  });

  it('does not save or auto-start when directory preparation fails', async () => {
    vi.mocked(TestBed.inject(PathInspectionService).createRequiredDirectories).mockRejectedValue(
      new Error('denied')
    );
    service.setPendingConfig(remote, config);
    await expect(service.finalizeCreation()).rejects.toThrow('denied');
    expect(saveSettings).not.toHaveBeenCalled();
    expect(startBatch).not.toHaveBeenCalled();
  });

  it('does not report completion without an active pending flow', async () => {
    expect(await service.submitInteractiveAnswer(null, [])).toBe(false);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('ignores a late backend response after cancellation', async () => {
    let resolveResponse!: (value: RcConfigQuestionResponse) => void;
    remoteService.startRemoteConfigInteractive.mockReturnValue(
      new Promise<RcConfigQuestionResponse>(resolve => {
        resolveResponse = resolve;
      })
    );
    const pending = service.startInteractiveCreation(remote, config, []);
    await service.cancelAuth();
    resolveResponse(complete);
    expect(await pending).toBe(false);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(service.interactiveFlowState().isActive).toBe(false);
  });

  it('starts source-only Delete profiles while preserving destination requirements for transfers', async () => {
    await service.triggerAutoStartJobs(remote.name, {
      showOnTray: true,
      deleteConfigs: {
        Enabled: { app: { autoStart: true }, rclone: { srcFs: 'my-drive:trash' } },
        Disabled: { app: { autoStart: false }, rclone: { srcFs: 'my-drive:other' } },
        Empty: { app: { autoStart: true }, rclone: { srcFs: '' } },
        EmptyArray: { app: { autoStart: true }, rclone: { srcFs: [] } },
        EmptyEntries: { app: { autoStart: true }, rclone: { srcFs: [''] } },
      },
      syncConfigs: {
        MissingDest: { app: { autoStart: true }, rclone: { srcFs: '/src' } },
        Valid: { app: { autoStart: true }, rclone: { srcFs: '/src', dstFs: 'my-drive:backup' } },
      },
    });
    expect(startBatch).toHaveBeenCalledTimes(2);
    expect(startBatch).toHaveBeenCalledWith('Delete', {
      remoteName: remote.name,
      profileName: 'Enabled',
      backendName: 'Local',
    });
    expect(startBatch).toHaveBeenCalledWith('Sync', {
      remoteName: remote.name,
      profileName: 'Valid',
      backendName: 'Local',
    });
  });
});
