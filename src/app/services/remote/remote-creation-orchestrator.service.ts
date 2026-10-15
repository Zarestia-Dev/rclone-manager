import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AppConfig,
  BATCH_OP_LABELS,
  CommandOption,
  InteractiveFlowState,
  JobMap,
  PendingRemoteData,
  RemoteConfigSections,
  REMOTE_CONFIG_KEYS,
  SYNC_TYPES,
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
} from './utils/remote-config.utils';

interface PendingConfig {
  remoteData: PendingRemoteData;
  finalConfig: RemoteConfigSections;
}

function isAnswerRequired(state: InteractiveFlowState): boolean {
  const opt = state.question?.Option;
  if (!opt?.Required) return false;
  return state.answer == null || String(state.answer).trim() === '';
}

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
    if (s.question?.Error) return true;
    return isAnswerRequired(s);
  });

  readonly backendName = inject(BackendService).activeBackend();
  private pendingConfig: PendingConfig | null = null;

  setPendingConfig(remoteData: PendingRemoteData, finalConfig: RemoteConfigSections): void {
    this.pendingConfig = { remoteData, finalConfig };
  }

  async startInteractiveCreation(
    remoteData: PendingRemoteData,
    finalConfig: RemoteConfigSections,
    commandOptions: CommandOption[]
  ): Promise<boolean> {
    this.pendingConfig = { remoteData, finalConfig };
    const pending = this.pendingConfig;
    this.resetInteractiveFlow();
    const resp = await this.remoteManagementService.startRemoteConfigInteractive(
      remoteData.name,
      remoteData.type,
      remoteData,
      this.remoteManagementService.buildOpt(commandOptions),
      this.backendName
    );
    if (this.pendingConfig !== pending) return false;

    this.interactiveFlowState.set({
      isActive: true,
      isProcessing: false,
      question: resp ?? { State: '', Option: null, Error: '' },
      answer: resp ? getDefaultAnswerFromQuestion(resp) : null,
    });
    if (!resp || resp.State === '') {
      await this.finalizeCreation();
      return true;
    }
    return false;
  }

  async submitInteractiveAnswer(
    answer: string | number | boolean | null,
    commandOptions: CommandOption[]
  ): Promise<boolean> {
    try {
      const state = this.interactiveFlowState();
      const pending = this.pendingConfig;
      if (!state.isActive || !state.question || !pending) return false;
      // A completed backend flow can retry saving settings without submitting the last answer again.
      if (state.question.State === '') {
        await this.finalizeCreation();
        return true;
      }

      const { name, ...paramRest } = pending.remoteData;
      const processedAnswer: string | number | boolean | null =
        state.question?.Option?.Type === 'bool'
          ? convertBoolAnswerToString(answer)
          : (answer ?? '');

      const resp = await this.remoteManagementService.continueRemoteConfigInteractive(
        name,
        state.question.State,
        processedAnswer,
        paramRest,
        this.remoteManagementService.buildOpt(commandOptions),
        this.backendName
      );
      if (this.pendingConfig !== pending) return false;

      if (!resp || resp.State === '') {
        this.interactiveFlowState.update(s => ({
          ...s,
          question: resp ?? { State: '', Option: null, Error: '' },
        }));
        await this.finalizeCreation();
        return true;
      } else {
        this.interactiveFlowState.update(s => ({
          ...s,
          question: resp,
          answer: getDefaultAnswerFromQuestion(resp),
          isProcessing: false,
        }));
      }
    } catch (error) {
      console.error('Error processing interactive response:', error);
      this.interactiveFlowState.update(s => ({ ...s, isProcessing: false }));
      this.notificationService.showError(
        error || this.translate.instant('modals.remoteConfig.errors.interactiveProcessingFailed')
      );
    }
    return false;
  }

  async finalizeCreation(): Promise<void> {
    if (!this.pendingConfig) return;
    const pending = this.pendingConfig;
    const { remoteData, finalConfig } = pending;
    await this.pathInspectionService.createRequiredDirectories(finalConfig, this.backendName);
    if (this.pendingConfig !== pending) return;
    await this.appSettingsService.saveRemoteSettings(
      remoteData.name,
      finalConfig,
      undefined,
      this.backendName
    );
    if (this.pendingConfig !== pending) return;
    await this.remoteManagementService.getRemotes();
    if (this.pendingConfig !== pending) return;
    this.authStateService.resetAuthState();
    this.resetInteractiveFlow();
    this.pendingConfig = null;
    await this.triggerAutoStartJobs(remoteData.name, finalConfig);
  }

  async cancelAuth(): Promise<void> {
    this.pendingConfig = null;
    await this.authStateService.cancelAuth();
    this.interactiveFlowState.set(createInitialInteractiveFlowState());
  }

  resetInteractiveFlow(): void {
    this.interactiveFlowState.set(createInitialInteractiveFlowState());
  }

  updateInteractiveAnswer(answer: string | number | boolean | null): void {
    if (this.interactiveFlowState().isActive) {
      this.interactiveFlowState.update(state => updateInteractiveAnswer(state, answer));
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
        if (appCfg.autoStart && hasSource && (jobType === 'delete' || hasDest)) {
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
