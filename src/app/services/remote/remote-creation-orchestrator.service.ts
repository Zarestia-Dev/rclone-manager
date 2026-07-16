import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AppConfig,
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
import { PathService } from '../infrastructure/platform/path.service';
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
  private readonly pathService = inject(PathService);

  readonly interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());

  readonly oauthHelperUrl = computed(() =>
    (this.authStateService.isAuthInProgress?.() ?? false) &&
    !(this.authStateService.isAuthCancelled?.() ?? false)
      ? (this.authStateService.oauthUrl?.() ?? null)
      : null
  );

  readonly isInteractiveContinueDisabled = computed(() => {
    const s = this.interactiveFlowState();
    return (
      s.isProcessing ||
      (s.question?.Option?.Type !== 'password' &&
        (s.answer == null || String(s.answer).trim() === '')) ||
      (this.authStateService.isAuthCancelled?.() ?? false)
    );
  });

  private pendingConfig: {
    remoteData: PendingRemoteData;
    finalConfig: RemoteConfigSections;
  } | null = null;

  setPendingConfig(remoteData: PendingRemoteData, finalConfig: RemoteConfigSections): void {
    this.pendingConfig = { remoteData, finalConfig };
  }

  async startInteractiveCreation(
    remoteData: PendingRemoteData,
    finalConfig: RemoteConfigSections,
    commandOptions: CommandOption[]
  ): Promise<boolean> {
    this.pendingConfig = { remoteData, finalConfig };
    try {
      const resp = await this.remoteManagementService.startRemoteConfigInteractive(
        remoteData.name,
        remoteData.type,
        remoteData,
        this.remoteManagementService.buildOpt(commandOptions)
      );

      if (!resp || resp.State === '') {
        await this.finalizeCreation();
        return true;
      }

      this.interactiveFlowState.set({
        isActive: true,
        isProcessing: false,
        question: resp,
        answer: getDefaultAnswerFromQuestion(resp),
      });

      return false;
    } catch (error) {
      this.interactiveFlowState.set(createInitialInteractiveFlowState());
      throw error;
    }
  }

  async submitInteractiveAnswer(
    answer: string | number | boolean | null,
    commandOptions: CommandOption[]
  ): Promise<void> {
    try {
      const state = this.interactiveFlowState();
      if (!state.isActive || !state.question || !this.pendingConfig) return;

      const { name, ...paramRest } = this.pendingConfig.remoteData;
      const processedAnswer: unknown =
        state.question?.Option?.Type === 'bool'
          ? convertBoolAnswerToString(String(answer))
          : answer;

      const resp = await this.remoteManagementService.continueRemoteConfigInteractive(
        name,
        state.question.State,
        processedAnswer,
        paramRest,
        this.remoteManagementService.buildOpt(commandOptions)
      );

      if (!resp || resp.State === '') {
        this.interactiveFlowState.set(createInitialInteractiveFlowState());
        await this.finalizeCreation();
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
        this.translate.instant('modals.remoteConfig.errors.interactiveProcessingFailed')
      );
    }
  }

  async finalizeCreation(): Promise<void> {
    if (!this.pendingConfig) return;
    const { remoteData, finalConfig } = this.pendingConfig;
    this.interactiveFlowState.set(createInitialInteractiveFlowState());
    await this.appSettingsService.saveRemoteSettings(remoteData.name, finalConfig);
    try {
      await this.pathService.createRequiredDirectories(finalConfig);
    } catch (err) {
      console.error('Failed to create required directories:', err);
    }
    await this.remoteManagementService.getRemotes();
    this.authStateService.resetAuthState();
    await this.triggerAutoStartJobs(remoteData.name, finalConfig);
  }

  async cancelAuth(): Promise<void> {
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
    const mountConfigs = finalConfig[REMOTE_CONFIG_KEYS.mount];
    if (mountConfigs) {
      for (const [profileName, config] of Object.entries(mountConfigs)) {
        const appCfg = (getAppCfg(config) ?? config) as AppConfig;
        const rcloneCfg = (getRcloneCfg(config) ?? config) as RcloneSubConfig;
        if (appCfg.autoStart && rcloneCfg.mountPoint) {
          void this.mountManagementService.mountRemoteProfile(remoteName, profileName);
        }
      }
    }

    for (const jobType of SYNC_TYPES) {
      const configs = finalConfig[REMOTE_CONFIG_KEYS[jobType]] as JobMap | undefined;
      if (!configs) continue;
      for (const [profileName, config] of Object.entries(configs)) {
        const appCfg = getAppCfg(config) ?? config;
        const rcloneCfg = getRcloneCfg(config) ?? config;
        const hasSource = rcloneCfg.srcFs || rcloneCfg.path1;
        const hasDest = rcloneCfg.dstFs || rcloneCfg.path2;
        if (appCfg.autoStart && hasSource && hasDest) {
          const batchType = (jobType.charAt(0).toUpperCase() + jobType.slice(1)) as
            | 'Copy'
            | 'Sync'
            | 'Bisync'
            | 'Move'
            | 'Check'
            | 'Delete'
            | 'Copyurl'
            | 'Archivecreate'
            | 'Cryptcheck';
          void this.jobManagementService.startProfileBatch(batchType, {
            remoteName,
            profileName,
          });
        }
      }
    }

    const serveConfigs = finalConfig[REMOTE_CONFIG_KEYS.serve];
    if (serveConfigs) {
      for (const [profileName, config] of Object.entries(serveConfigs)) {
        const appCfg = (getAppCfg(config) ?? config) as AppConfig;
        if (appCfg.autoStart) {
          void this.serveManagementService.startServeProfile(remoteName, profileName);
        }
      }
    }
  }
}
