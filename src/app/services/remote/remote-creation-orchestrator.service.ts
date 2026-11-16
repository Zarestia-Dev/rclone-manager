import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AppConfig,
  BATCH_OP_LABELS,
  CommandOption,
  ConfigRecord,
  InteractiveFlowState,
  JobMap,
  PendingRemoteData,
  RcConfigQuestionResponse,
  RemoteConfigSections,
  REMOTE_CONFIG_KEYS,
  SYNC_TYPES,
  isSourceOnlyOperation,
} from '@app/types';
import { AuthStateService } from '../security/auth-state.service';
import { RemoteManagementService } from './remote-management.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { JobManagementService } from '../operations/job-management.service';
import { NotificationService } from '../ui/notification.service';
import { TranslateService } from '@ngx-translate/core';
import { BackendService } from '../infrastructure/system/backend.service';
import { PathInspectionService } from '../infrastructure/platform/path-inspection.service';
import {
  getAppCfg,
  getRcloneCfg,
  type RcloneSubConfig,
} from 'src/app/shared/utils/profile-config.util';
import {
  convertBoolAnswerToString,
  createInitialInteractiveFlowState,
  getDefaultAnswerFromQuestion,
  updateInteractiveAnswer,
} from './utils/interactive-flow.utils';

/** One remote being configured: what rclone is told and what the app saves once rclone is done. */
interface PendingConfig {
  remoteData: PendingRemoteData;
  /** Sent to rclone as parameters. The name and type travel on their own. */
  parameters: ConfigRecord;
  /** rclone's own option block (`obscure`, `all`, ...). */
  opt: Record<string, unknown>;
  /** Present for a new remote: the settings saved beside rclone's config. */
  finalConfig?: RemoteConfigSections;
  /** Present when an existing remote is edited: saves what the app keeps beside rclone's config. */
  save?: () => Promise<boolean>;
}

/** The name and type go to rclone on their own; writing them as parameters would put them in the config. */
function splitRemoteData(data: PendingRemoteData): {
  name: string;
  type: string;
  parameters: ConfigRecord;
} {
  const { name, type, ...parameters } = data;
  return { name, type, parameters };
}

function isAnswerRequired(state: InteractiveFlowState): boolean {
  const opt = state.question?.Option;
  if (!opt?.Required) return false;
  return state.answer == null || String(state.answer).trim() === '';
}

/**
 * Creates and edits remotes in one of two ways, chosen by the `nonInteractive` command option.
 *
 * Without it one call does everything and rclone answers each of its questions with the default
 * (its `AutoConfirm`), which is all most remotes need. With it every call is answered with the
 * next question, or with an empty `State` once the remote is complete, and each question is shown
 * to the user.
 */
@Injectable()
export class RemoteCreationOrchestrator {
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly pathInspectionService = inject(PathInspectionService);

  readonly interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());

  readonly oauthHelperUrl = computed(() => {
    const inProgress = this.authStateService.isAuthInProgress();
    const cancelled = this.authStateService.isAuthCancelled();
    return inProgress && !cancelled ? this.authStateService.oauthUrl() : null;
  });

  readonly isInteractiveContinueDisabled = computed(() => {
    const s = this.interactiveFlowState();
    if (s.isProcessing || this.authStateService.isAuthCancelled()) return true;
    return isAnswerRequired(s);
  });

  readonly backendName = inject(BackendService).activeBackend();
  private pendingConfig: PendingConfig | null = null;
  /** States already answered in this flow. */
  private readonly answeredStates = new Set<string>();

  /** Creates a new remote. Returns true once it is complete, false while a question is open. */
  async createRemote(
    remoteData: PendingRemoteData,
    finalConfig: RemoteConfigSections,
    commandOptions: CommandOption[]
  ): Promise<boolean> {
    if (this.authStateService.isAuthInProgress()) return false;
    const { name, type, parameters } = splitRemoteData(remoteData);
    const opt = this.remoteManagementService.buildOpt(commandOptions);
    return this.runFlow({ remoteData, parameters, opt, finalConfig }, false, () =>
      this.remoteManagementService.createRemote(name, type, parameters, opt, this.backendName)
    );
  }

  /**
   * Edits an existing remote with `config/update`, which keeps the keys the form does not know.
   * The command options only apply to the stepwise flow: a plain edit sends none, because the
   * form holds passwords that are already obscured.
   */
  async editRemote(
    remoteData: PendingRemoteData,
    save: () => Promise<boolean>,
    commandOptions: CommandOption[]
  ): Promise<boolean> {
    if (this.authStateService.isAuthInProgress()) return false;
    const { name, parameters } = splitRemoteData(remoteData);
    const opt = this.isStepwise(commandOptions)
      ? this.remoteManagementService.buildOpt(commandOptions)
      : {};
    return this.runFlow({ remoteData, parameters, opt, save }, true, () =>
      this.remoteManagementService.updateRemote(name, parameters, opt, this.backendName)
    );
  }

  async submitInteractiveAnswer(answer: string | number | boolean | null): Promise<boolean> {
    try {
      const state = this.interactiveFlowState();
      const pending = this.pendingConfig;
      if (!state.isActive || !state.question || !pending) return false;
      // A completed backend flow can retry saving settings without submitting the last answer again.
      if (state.question.State === '') return await this.complete(pending);

      const result =
        state.question.Option?.Type === 'bool'
          ? convertBoolAnswerToString(answer)
          : String(answer ?? '');
      const response = await this.answerQuestion(pending, state.question.State, result);
      if (this.pendingConfig !== pending) return false;
      return await this.advance(response, pending);
    } catch (error) {
      console.error('Error processing interactive response:', error);
      this.interactiveFlowState.update(s => ({ ...s, isProcessing: false }));
      this.notificationService.showError(
        error || this.translate.instant('modals.remoteConfig.errors.interactiveProcessingFailed')
      );
    }
    return false;
  }

  /** Saves the app's settings for the new remote. False when the flow was cancelled meanwhile. */
  async finalizeCreation(): Promise<boolean> {
    const pending = this.pendingConfig;
    if (!pending?.finalConfig) return false;
    const { remoteData, finalConfig } = pending;
    await this.pathInspectionService.createRequiredDirectories(finalConfig, this.backendName);
    if (this.pendingConfig !== pending) return false;
    await this.appSettingsService.saveRemoteSettings(
      remoteData.name,
      finalConfig,
      this.backendName
    );
    if (this.pendingConfig !== pending) return false;
    await this.remoteManagementService.getRemotes();
    if (this.pendingConfig !== pending) return false;
    this.finish();
    await this.triggerAutoStartJobs(remoteData.name, finalConfig);
    return true;
  }

  async cancelAuth(): Promise<void> {
    this.pendingConfig = null;
    await this.authStateService.cancelAuth();
    this.resetInteractiveFlow();
  }

  resetInteractiveFlow(): void {
    this.answeredStates.clear();
    this.interactiveFlowState.set(createInitialInteractiveFlowState());
  }

  updateInteractiveAnswer(answer: string | number | boolean | null): void {
    if (this.interactiveFlowState().isActive) {
      this.interactiveFlowState.update(state => updateInteractiveAnswer(state, answer));
    }
  }

  private async runFlow(
    pending: PendingConfig,
    isEdit: boolean,
    start: () => Promise<RcConfigQuestionResponse>
  ): Promise<boolean> {
    this.resetInteractiveFlow();
    this.pendingConfig = pending;
    try {
      await this.authStateService.startAuth(pending.remoteData.name, isEdit);
      let response: RcConfigQuestionResponse;
      try {
        response = await start();
      } catch (error) {
        // A cancelled flow is not an error, and a new remote must not be left half configured.
        if (this.pendingConfig !== pending) return false;
        if (!isEdit) await this.discardRemote(pending.remoteData.name);
        throw error;
      }
      if (this.pendingConfig !== pending || this.authStateService.isAuthCancelled()) return false;
      // Without nonInteractive rclone has already answered every question itself.
      if (!this.isStepwise(pending.opt)) return await this.complete(pending);
      return await this.advance(response, pending);
    } finally {
      if (!this.interactiveFlowState().isActive && this.authStateService.isAuthInProgress())
        this.authStateService.resetAuthState();
    }
  }

  private isStepwise(options: CommandOption[] | Record<string, unknown>): boolean {
    return Array.isArray(options)
      ? options.some(option => option.key === 'nonInteractive' && option.value === true)
      : options['nonInteractive'] === true;
  }

  /** Shows the question rclone asks. Every question is the user's to answer. */
  private async advance(first: RcConfigQuestionResponse, pending: PendingConfig): Promise<boolean> {
    let question = first;
    let notice = '';
    // rclone can report an error without asking anything, and expects the caller to go on with
    // the next state, as its own terminal loop does. The error is kept for the question that follows.
    while (question.State !== '' && !question.Option && !this.answeredStates.has(question.State)) {
      this.answeredStates.add(question.State);
      if (question.Error) notice = question.Error;
      question = await this.answerQuestion(pending, question.State, question.Result ?? '');
      if (this.pendingConfig !== pending) return false;
    }
    if (notice && !question.Error) question = { ...question, Error: notice };

    this.interactiveFlowState.set({
      isActive: true,
      isProcessing: false,
      question,
      answer: getDefaultAnswerFromQuestion(question),
    });
    return question.State === '' ? this.complete(pending) : false;
  }

  private answerQuestion(
    pending: PendingConfig,
    state: string,
    result: string
  ): Promise<RcConfigQuestionResponse> {
    return this.remoteManagementService.updateRemote(
      pending.remoteData.name,
      pending.parameters,
      { ...pending.opt, continue: true, state, result },
      this.backendName
    );
  }

  private async complete(pending: PendingConfig): Promise<boolean> {
    if (pending.save) {
      if (!(await pending.save())) return false;
      this.finish();
    } else if (!(await this.finalizeCreation())) {
      return false;
    }
    this.notificationService.showSuccess(
      this.translate.instant(
        pending.save ? 'backendSuccess.remote.updated' : 'backendSuccess.remote.created',
        { name: pending.remoteData.name }
      )
    );
    return true;
  }

  private finish(): void {
    this.authStateService.resetAuthState();
    this.resetInteractiveFlow();
    this.pendingConfig = null;
  }

  private async discardRemote(name: string): Promise<void> {
    try {
      await this.remoteManagementService.deleteRemote(name, this.backendName);
    } catch (error) {
      console.warn('Could not remove the partly configured remote', name, error);
    }
  }

  async triggerAutoStartJobs(remoteName: string, finalConfig: RemoteConfigSections): Promise<void> {
    this.startAutoMounts(remoteName, finalConfig[REMOTE_CONFIG_KEYS.mount]);
    this.startAutoSyncJobs(remoteName, finalConfig);
    this.startAutoServes(remoteName, finalConfig[REMOTE_CONFIG_KEYS.serve]);
  }

  private startAutoMounts(
    remoteName: string,
    mountConfigs: RemoteConfigSections['mountConfigs']
  ): void {
    if (!mountConfigs) return;
    for (const [profileName, config] of Object.entries(mountConfigs)) {
      const appCfg = (getAppCfg(config) ?? config) as AppConfig;
      const rcloneCfg = (getRcloneCfg(config) ?? config) as RcloneSubConfig;
      if (appCfg.autoStart && rcloneCfg.mountPoint) {
        void this.mountManagementService
          .mountRemoteProfile(remoteName, profileName, undefined, undefined, this.backendName)
          .catch(error => console.error('Auto-start mount failed', error));
      }
    }
  }

  private startAutoSyncJobs(remoteName: string, finalConfig: RemoteConfigSections): void {
    for (const jobType of SYNC_TYPES) {
      const configs = finalConfig[REMOTE_CONFIG_KEYS[jobType]] as JobMap | undefined;
      if (!configs) continue;
      for (const [profileName, config] of Object.entries(configs)) {
        const appCfg = getAppCfg(config) ?? config;
        const rcloneCfg = getRcloneCfg(config) ?? config;
        const source = rcloneCfg.srcFs || rcloneCfg.path1;
        const hasSource = (Array.isArray(source) ? source : [source]).some(
          path => typeof path === 'string' && path.length > 0
        );
        const hasDest = rcloneCfg.dstFs || rcloneCfg.path2;
        if (appCfg.autoStart && hasSource && (isSourceOnlyOperation(jobType) || hasDest)) {
          void this.jobManagementService
            .startProfileBatch(BATCH_OP_LABELS[jobType], {
              remoteName,
              profileName,
              backendName: this.backendName,
            })
            .catch(error => console.error('Auto-start transfer failed', error));
        }
      }
    }
  }

  private startAutoServes(
    remoteName: string,
    serveConfigs: RemoteConfigSections['serveConfigs']
  ): void {
    if (!serveConfigs) return;
    for (const [profileName, config] of Object.entries(serveConfigs)) {
      const appCfg = (getAppCfg(config) ?? config) as AppConfig;
      if (appCfg.autoStart) {
        void this.serveManagementService
          .startServeProfile(remoteName, profileName, this.backendName)
          .catch(error => console.error('Auto-start serve failed', error));
      }
    }
  }
}
