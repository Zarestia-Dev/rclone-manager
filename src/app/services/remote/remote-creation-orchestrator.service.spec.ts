import { TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommandOption,
  RcConfigOption,
  RcConfigQuestionResponse,
  RemoteConfigSections,
} from '@app/types';
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

function option(fields: Partial<RcConfigOption>): RcConfigOption {
  return { Name: '', FieldName: '', Help: '', DefaultStr: '', Type: 'string', ...fields };
}

const yesNo = [
  { Value: 'true', Help: 'Yes' },
  { Value: 'false', Help: 'No' },
];
const stepwise: CommandOption[] = [{ key: 'nonInteractive', value: true }];

// The questions below are what a real rclone returns for `config/create` with `nonInteractive`.
const done: RcConfigQuestionResponse = { State: '', Option: null, Error: '', Result: '' };
const isLocal: RcConfigQuestionResponse = {
  State: '*oauth-islocal,,,',
  Error: '',
  Option: option({
    Name: 'config_is_local',
    Type: 'bool',
    Default: true,
    DefaultStr: 'true',
    Exclusive: true,
    Examples: yesNo,
  }),
};
const sharedClientId: RcConfigQuestionResponse = {
  State: 'client_id_warning',
  Error: '',
  Option: option({
    Name: 'config_shared_client_id',
    Type: 'bool',
    Default: false,
    DefaultStr: 'false',
    Exclusive: true,
    Examples: yesNo,
  }),
};
const username: RcConfigQuestionResponse = {
  State: 'password',
  Error: '',
  Option: option({ Name: 'config_username', Required: true }),
};
const password: RcConfigQuestionResponse = {
  State: 'auth',
  Error: '',
  Option: option({ Name: 'config_password', IsPassword: true }),
};
const jottaType: RcConfigQuestionResponse = {
  State: 'auth_type_done',
  Error: '',
  Option: option({
    Name: 'config_type',
    Default: 'standard',
    DefaultStr: 'standard',
    Exclusive: true,
    Examples: [
      { Value: 'standard', Help: 'Standard' },
      { Value: 'traditional', Help: 'Traditional' },
    ],
  }),
};

describe('RemoteCreationOrchestrator', () => {
  let service: RemoteCreationOrchestrator;
  const remote = { name: 'my-drive', type: 'drive' };
  const config: RemoteConfigSections = { showOnTray: true };
  let remoteService: {
    createRemote: ReturnType<typeof vi.fn>;
    updateRemote: ReturnType<typeof vi.fn>;
    deleteRemote: ReturnType<typeof vi.fn>;
    getRemotes: ReturnType<typeof vi.fn>;
    buildOpt: ReturnType<typeof vi.fn>;
  };
  let saveSettings: ReturnType<typeof vi.fn>;
  let auth: {
    isAuthInProgress: WritableSignal<boolean>;
    isAuthCancelled: WritableSignal<boolean>;
    oauthUrl: WritableSignal<string | null>;
    resetAuthState: ReturnType<typeof vi.fn>;
    startAuth: ReturnType<typeof vi.fn>;
    cancelAuth: ReturnType<typeof vi.fn>;
  };
  let startBatch: ReturnType<typeof vi.fn>;
  let notifyError: ReturnType<typeof vi.fn>;
  let notifySuccess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    remoteService = {
      createRemote: vi.fn().mockResolvedValue(done),
      updateRemote: vi.fn().mockResolvedValue(done),
      deleteRemote: vi.fn().mockResolvedValue(undefined),
      getRemotes: vi.fn().mockResolvedValue(['my-drive']),
      buildOpt: vi.fn((options: { key: string; value: unknown }[]) =>
        Object.fromEntries(options.map(o => [o.key, o.value]))
      ),
    };
    saveSettings = vi.fn().mockResolvedValue(undefined);
    auth = {
      isAuthInProgress: signal(false),
      isAuthCancelled: signal(false),
      oauthUrl: signal(null),
      resetAuthState: vi.fn(() => auth.isAuthInProgress.set(false)),
      startAuth: vi.fn(async () => auth.isAuthInProgress.set(true)),
      cancelAuth: vi.fn().mockResolvedValue(undefined),
    };
    startBatch = vi.fn().mockResolvedValue(undefined);
    notifyError = vi.fn();
    notifySuccess = vi.fn();
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
        {
          provide: NotificationService,
          useValue: { showError: notifyError, showSuccess: notifySuccess },
        },
        {
          provide: PathInspectionService,
          useValue: { createRequiredDirectories: vi.fn().mockResolvedValue(undefined) },
        },
      ],
    });
    service = TestBed.inject(RemoteCreationOrchestrator);
  });

  describe('creating a remote without nonInteractive', () => {
    it('sends the name and type on their own, never as config parameters', async () => {
      await service.createRemote({ ...remote, host: 'h' }, config, [
        { key: 'obscure', value: true },
      ]);
      expect(remoteService.createRemote).toHaveBeenCalledExactlyOnceWith(
        'my-drive',
        'drive',
        { host: 'h' },
        { obscure: true },
        'Local'
      );
    });

    it('finishes in one call and never asks, even for a remote whose backend has questions', async () => {
      // Google Drive: rclone answers its own questions (shared client id, ...) and returns {}.
      remoteService.createRemote.mockResolvedValue({});
      expect(await service.createRemote(remote, config, [])).toBe(true);
      expect(remoteService.updateRemote).not.toHaveBeenCalled();
      expect(service.interactiveFlowState().isActive).toBe(false);
      expect(saveSettings).toHaveBeenCalledExactlyOnceWith(remote.name, config, 'Local');
      expect(notifySuccess).toHaveBeenCalledOnce();
      expect(auth.startAuth).toHaveBeenCalledWith(remote.name, false);
      expect(auth.resetAuthState).toHaveBeenCalledOnce();
    });

    it('does not start a second flow while authentication is already in progress', async () => {
      auth.isAuthInProgress.set(true);
      expect(await service.createRemote(remote, config, [])).toBe(false);
      expect(remoteService.createRemote).not.toHaveBeenCalled();
      expect(auth.startAuth).not.toHaveBeenCalled();
    });

    it('removes the half configured remote when rclone fails', async () => {
      remoteService.createRemote.mockRejectedValue(new Error('failed to get oauth token: EOF'));
      await expect(service.createRemote(remote, config, [])).rejects.toThrow('oauth token');
      expect(remoteService.deleteRemote).toHaveBeenCalledExactlyOnceWith('my-drive', 'Local');
      expect(saveSettings).not.toHaveBeenCalled();
      expect(auth.resetAuthState).toHaveBeenCalledOnce();
    });

    it('still reports the original failure when removing the half configured remote fails', async () => {
      remoteService.createRemote.mockRejectedValue(new Error('no region set'));
      remoteService.deleteRemote.mockRejectedValue(new Error('gone'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(service.createRemote(remote, config, [])).rejects.toThrow('no region set');
    });

    it('ignores a late failure after cancellation', async () => {
      let fail!: (error: Error) => void;
      remoteService.createRemote.mockReturnValue(
        new Promise<RcConfigQuestionResponse>((_, reject) => (fail = reject))
      );
      const pending = service.createRemote(remote, config, []);
      await vi.waitFor(() => expect(remoteService.createRemote).toHaveBeenCalled());
      await service.cancelAuth();
      fail(new Error('failed to get oauth token'));
      expect(await pending).toBe(false);
      expect(remoteService.deleteRemote).not.toHaveBeenCalled();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it('ignores a late success after cancellation', async () => {
      let resolve!: (value: RcConfigQuestionResponse) => void;
      remoteService.createRemote.mockReturnValue(
        new Promise<RcConfigQuestionResponse>(r => (resolve = r))
      );
      const pending = service.createRemote(remote, config, []);
      await vi.waitFor(() => expect(remoteService.createRemote).toHaveBeenCalled());
      await service.cancelAuth();
      resolve({} as RcConfigQuestionResponse); // what rclone returns without nonInteractive
      expect(await pending).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
      expect(service.interactiveFlowState().isActive).toBe(false);
    });

    it('does not save or auto-start when directory preparation fails', async () => {
      vi.mocked(TestBed.inject(PathInspectionService).createRequiredDirectories).mockRejectedValue(
        new Error('denied')
      );
      await expect(service.createRemote(remote, config, [])).rejects.toThrow('denied');
      expect(saveSettings).not.toHaveBeenCalled();
      expect(startBatch).not.toHaveBeenCalled();
    });
  });

  describe('creating a remote with nonInteractive', () => {
    it('sends the options on, so rclone returns its questions', async () => {
      await service.createRemote({ ...remote, client_id: 'abc' }, config, stepwise);
      expect(remoteService.createRemote).toHaveBeenCalledExactlyOnceWith(
        'my-drive',
        'drive',
        { client_id: 'abc' },
        { nonInteractive: true },
        'Local'
      );
    });

    it('completes a remote without questions and saves settings once', async () => {
      expect(await service.createRemote(remote, config, stepwise)).toBe(true);
      expect(remoteService.updateRemote).not.toHaveBeenCalled();
      expect(saveSettings).toHaveBeenCalledExactlyOnceWith(remote.name, config, 'Local');
      expect(notifySuccess).toHaveBeenCalledOnce();
      expect(auth.resetAuthState).toHaveBeenCalledOnce();
      expect(service.interactiveFlowState().isActive).toBe(false);
    });

    it.each([
      ['a Yes/No question (OAuth: use the browser)', isLocal],
      ['a Yes/No question with a default of No', sharedClientId],
      ['an input', username],
      ['a choice', jottaType],
      ['a password', password],
    ])('shows %s to the user instead of answering it', async (_kind, question) => {
      remoteService.createRemote.mockResolvedValue(question);
      expect(await service.createRemote(remote, config, stepwise)).toBe(false);
      expect(remoteService.updateRemote).not.toHaveBeenCalled();
      expect(service.interactiveFlowState()).toMatchObject({ isActive: true, question });
      expect(saveSettings).not.toHaveBeenCalled();
      expect(auth.resetAuthState).not.toHaveBeenCalled();
    });

    it.each([
      ['a choice', jottaType, 'standard'],
      ['a Yes/No question', isLocal, true],
      ['a Yes/No question that defaults to No', sharedClientId, false],
    ])('preselects the default of %s', async (_kind, question, answer) => {
      remoteService.createRemote.mockResolvedValue(question);
      await service.createRemote(remote, config, stepwise);
      expect(service.interactiveFlowState().answer).toBe(answer);
    });

    it('walks through every question and finishes after the last answer', async () => {
      remoteService.createRemote.mockResolvedValue(username);
      remoteService.updateRemote.mockResolvedValueOnce(password).mockResolvedValueOnce(done);
      expect(await service.createRemote(remote, config, stepwise)).toBe(false);

      expect(await service.submitInteractiveAnswer('a@b.c')).toBe(false);
      expect(remoteService.updateRemote).toHaveBeenLastCalledWith(
        'my-drive',
        {},
        { nonInteractive: true, continue: true, state: 'password', result: 'a@b.c' },
        'Local'
      );
      expect(service.interactiveFlowState().question).toEqual(password);

      expect(await service.submitInteractiveAnswer('secret')).toBe(true);
      expect(remoteService.updateRemote).toHaveBeenLastCalledWith(
        'my-drive',
        {},
        { nonInteractive: true, continue: true, state: 'auth', result: 'secret' },
        'Local'
      );
      expect(saveSettings).toHaveBeenCalledExactlyOnceWith(remote.name, config, 'Local');
      expect(notifySuccess).toHaveBeenCalledOnce();
      expect(auth.resetAuthState).toHaveBeenCalledOnce();
      expect(service.interactiveFlowState().isActive).toBe(false);
    });

    it('keeps sending the parameters and options with every answer', async () => {
      remoteService.createRemote.mockResolvedValue(username);
      await service.createRemote({ ...remote, client_id: 'abc' }, config, [
        { key: 'obscure', value: true },
        ...stepwise,
      ]);
      await service.submitInteractiveAnswer('a@b.c');
      expect(remoteService.updateRemote).toHaveBeenCalledWith(
        'my-drive',
        { client_id: 'abc' },
        { obscure: true, nonInteractive: true, continue: true, state: 'password', result: 'a@b.c' },
        'Local'
      );
    });

    it.each([
      [42, '42'],
      [null, ''],
      ['a@b.c', 'a@b.c'],
    ])(
      'sends the answer %j as the string %j, the only type rclone accepts for a result',
      async (answer, result) => {
        remoteService.createRemote.mockResolvedValue(username);
        await service.createRemote(remote, config, stepwise);
        await service.submitInteractiveAnswer(answer);
        expect(remoteService.updateRemote).toHaveBeenCalledExactlyOnceWith(
          'my-drive',
          {},
          { nonInteractive: true, continue: true, state: 'password', result },
          'Local'
        );
      }
    );

    it('turns a Yes/No answer into true or false', async () => {
      remoteService.createRemote.mockResolvedValue(isLocal);
      await service.createRemote(remote, config, stepwise);
      await service.submitInteractiveAnswer(false);
      expect(remoteService.updateRemote).toHaveBeenLastCalledWith(
        'my-drive',
        {},
        { nonInteractive: true, continue: true, state: '*oauth-islocal,,,', result: 'false' },
        'Local'
      );
    });

    it('carries on after an error rclone only reports and shows it with the next question', async () => {
      const blank: RcConfigQuestionResponse = {
        State: 'password',
        Error: "2FA codes can't be blank",
        Option: null,
        Result: '',
      };
      remoteService.createRemote.mockResolvedValue(blank);
      remoteService.updateRemote.mockResolvedValue(username);
      expect(await service.createRemote(remote, config, stepwise)).toBe(false);
      expect(remoteService.updateRemote).toHaveBeenCalledExactlyOnceWith(
        'my-drive',
        {},
        { nonInteractive: true, continue: true, state: 'password', result: '' },
        'Local'
      );
      expect(service.interactiveFlowState().question).toEqual({
        ...username,
        Error: "2FA codes can't be blank",
      });
      expect(service.isInteractiveContinueDisabled()).toBe(true);
      service.updateInteractiveAnswer('a@b.c');
      expect(service.isInteractiveContinueDisabled()).toBe(false);
    });

    it('stops on an error that repeats instead of looping forever', async () => {
      const blank: RcConfigQuestionResponse = {
        State: 'authenticate',
        Error: 'nope',
        Option: null,
        Result: '',
      };
      remoteService.createRemote.mockResolvedValue(blank);
      remoteService.updateRemote.mockResolvedValue(blank);
      expect(await service.createRemote(remote, config, stepwise)).toBe(false);
      expect(remoteService.updateRemote).toHaveBeenCalledOnce();
      expect(service.interactiveFlowState().question).toEqual(blank);
      expect(service.isInteractiveContinueDisabled()).toBe(false);
    });

    it('requires an answer for a required question', async () => {
      remoteService.createRemote.mockResolvedValue(username);
      await service.createRemote(remote, config, stepwise);
      service.updateInteractiveAnswer('');
      expect(service.isInteractiveContinueDisabled()).toBe(true);
    });

    it('removes the half configured remote when the first step fails', async () => {
      remoteService.createRemote.mockRejectedValue(new Error('no region set'));
      await expect(service.createRemote(remote, config, stepwise)).rejects.toThrow('no region set');
      expect(remoteService.deleteRemote).toHaveBeenCalledExactlyOnceWith('my-drive', 'Local');
      expect(service.interactiveFlowState().isActive).toBe(false);
    });

    it('keeps a failed answer retryable without claiming completion', async () => {
      remoteService.createRemote.mockResolvedValue(username);
      remoteService.updateRemote.mockRejectedValue(new Error('network failure'));
      await service.createRemote(remote, config, stepwise);
      service.interactiveFlowState.update(state => ({ ...state, isProcessing: true }));
      expect(await service.submitInteractiveAnswer('a@b.c')).toBe(false);
      expect(service.interactiveFlowState()).toMatchObject({
        isActive: true,
        question: username,
        isProcessing: false,
      });
      expect(saveSettings).not.toHaveBeenCalled();
      expect(auth.resetAuthState).not.toHaveBeenCalled();
      expect(notifyError).toHaveBeenCalledOnce();
    });

    it('retries a failed settings save without resubmitting the last backend answer', async () => {
      saveSettings.mockRejectedValueOnce(new Error('disk full'));
      remoteService.createRemote.mockResolvedValue(username);
      await service.createRemote(remote, config, stepwise);
      expect(await service.submitInteractiveAnswer('a@b.c')).toBe(false);
      expect(service.interactiveFlowState()).toMatchObject({
        isActive: true,
        question: done,
        isProcessing: false,
      });
      expect(auth.resetAuthState).not.toHaveBeenCalled();

      expect(await service.submitInteractiveAnswer(null)).toBe(true);
      expect(remoteService.updateRemote).toHaveBeenCalledOnce();
      expect(saveSettings).toHaveBeenCalledTimes(2);
      expect(auth.resetAuthState).toHaveBeenCalledOnce();
      expect(notifySuccess).toHaveBeenCalledOnce();
    });

    it('can retry saving when a remote without questions fails during persistence', async () => {
      saveSettings.mockRejectedValueOnce(new Error('disk full'));
      await expect(service.createRemote(remote, config, stepwise)).rejects.toThrow('disk full');
      expect(service.interactiveFlowState().isActive).toBe(true);
      expect(await service.submitInteractiveAnswer(null)).toBe(true);
      expect(remoteService.createRemote).toHaveBeenCalledOnce();
      expect(remoteService.updateRemote).not.toHaveBeenCalled();
    });

    it('keeps the original backend through a flow and settings preparation', async () => {
      remoteService.createRemote.mockResolvedValue(username);
      await service.createRemote(remote, config, stepwise);
      const backend = TestBed.inject(BackendService).activeBackend as WritableSignal<string>;
      backend.set('B');
      expect(await service.submitInteractiveAnswer('a@b.c')).toBe(true);
      expect(remoteService.updateRemote).toHaveBeenCalledWith(
        'my-drive',
        {},
        expect.any(Object),
        'Local'
      );
      expect(TestBed.inject(PathInspectionService).createRequiredDirectories).toHaveBeenCalledWith(
        config,
        'Local'
      );
      expect(saveSettings).toHaveBeenCalledWith(remote.name, config, 'Local');
    });

    it('does not report completion without an active flow', async () => {
      expect(await service.submitInteractiveAnswer(null)).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it('ignores the answer to a cancelled flow', async () => {
      remoteService.createRemote.mockResolvedValue(username);
      let resolve!: (value: RcConfigQuestionResponse) => void;
      remoteService.updateRemote.mockReturnValue(
        new Promise<RcConfigQuestionResponse>(r => (resolve = r))
      );
      await service.createRemote(remote, config, stepwise);
      const answer = service.submitInteractiveAnswer('a@b.c');
      await service.cancelAuth();
      resolve(done);
      expect(await answer).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
    });
  });

  describe('editing a remote', () => {
    const edited = { name: 'my-drive', type: 'drive', root_folder_id: 'x' };

    it('updates the remote without wiping keys, with no command options and no name or type', async () => {
      const save = vi.fn().mockResolvedValue(true);
      expect(await service.editRemote(edited, save, [{ key: 'obscure', value: true }])).toBe(true);
      expect(auth.startAuth).toHaveBeenCalledWith('my-drive', true);
      expect(remoteService.createRemote).not.toHaveBeenCalled();
      expect(remoteService.updateRemote).toHaveBeenCalledExactlyOnceWith(
        'my-drive',
        { root_folder_id: 'x' },
        {},
        'Local'
      );
    });

    it('saves through the caller instead of the creation settings, then reports the update', async () => {
      const save = vi.fn().mockResolvedValue(true);
      await service.editRemote(edited, save, []);
      expect(save).toHaveBeenCalledOnce();
      expect(saveSettings).not.toHaveBeenCalled();
      expect(notifySuccess).toHaveBeenCalledOnce();
      expect(auth.resetAuthState).toHaveBeenCalledOnce();
    });

    it('with nonInteractive it asks rclone for questions through config/update, not config/create', async () => {
      const save = vi.fn().mockResolvedValue(true);
      remoteService.updateRemote.mockResolvedValueOnce(username).mockResolvedValueOnce(done);
      expect(await service.editRemote(edited, save, stepwise)).toBe(false);
      expect(remoteService.createRemote).not.toHaveBeenCalled();
      expect(remoteService.updateRemote).toHaveBeenCalledExactlyOnceWith(
        'my-drive',
        { root_folder_id: 'x' },
        { nonInteractive: true },
        'Local'
      );
      expect(service.interactiveFlowState().question).toEqual(username);

      expect(await service.submitInteractiveAnswer('a@b.c')).toBe(true);
      expect(remoteService.updateRemote).toHaveBeenLastCalledWith(
        'my-drive',
        { root_folder_id: 'x' },
        { nonInteractive: true, continue: true, state: 'password', result: 'a@b.c' },
        'Local'
      );
      expect(save).toHaveBeenCalledOnce();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it('never deletes the remote when editing fails', async () => {
      remoteService.updateRemote.mockRejectedValue(new Error('offline'));
      await expect(service.editRemote(edited, vi.fn(), [])).rejects.toThrow('offline');
      expect(remoteService.deleteRemote).not.toHaveBeenCalled();
    });

    it('stays open and can retry when the caller could not save', async () => {
      const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      expect(await service.editRemote(edited, save, stepwise)).toBe(false);
      expect(service.interactiveFlowState().isActive).toBe(true);
      expect(notifySuccess).not.toHaveBeenCalled();
      expect(await service.submitInteractiveAnswer(null)).toBe(true);
      expect(save).toHaveBeenCalledTimes(2);
      expect(remoteService.updateRemote).toHaveBeenCalledOnce();
    });
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
