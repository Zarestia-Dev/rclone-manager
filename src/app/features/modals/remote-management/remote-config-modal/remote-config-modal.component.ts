import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { RemoteConfigStepComponent } from '../../../../shared/remote-config/remote-config-step/remote-config-step.component';
import { FlagConfigStepComponent } from '../../../../shared/remote-config/flag-config-step/flag-config-step.component';
import { CliImportComponent } from '../../../../shared/remote-config/cli-import/cli-import.component';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { AuthStateService } from '../../../../services/security/auth-state.service';
import { JobManagementService } from '../../../../services/operations/job-management.service';
import { MountManagementService } from '../../../../services/operations/mount-management.service';
import { AppSettingsService } from '../../../../services/settings/app-settings.service';
import { ServeManagementService } from '../../../../services/operations/serve-management.service';
import { NautilusService } from '../../../../services/ui/nautilus.service';
import { ModalService } from '../../../../services/ui/modal.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { IconService } from '../../../../services/ui/icon.service';
import { RemoteManagementService } from '../../../../services/remote/remote-management.service';
import {
  RemoteConfigStateService,
  DialogData,
} from '../../../../services/remote/remote-config-state.service';
import {
  RemoteConfigFormBuilderService,
  PendingRemoteData,
} from '../../../../services/remote/remote-config-form-builder.service';
import {
  RemoteConfigProfileManagerService,
  PROFILE_TYPES,
  LINKED_PROFILE_TYPES,
} from '../../../../services/remote/remote-config-profile-manager.service';
import { RemoteConfigCliImporterService } from '../../../../services/remote/remote-config-cli-importer.service';
import {
  FLAG_TYPES,
  RemoteConfigSections,
  REMOTE_CONFIG_KEYS,
  MountConfig,
  CopyConfig,
  SyncConfig,
  BisyncConfig,
  MoveConfig,
  ServeConfig,
  VfsConfig,
  BackendConfig,
  RuntimeRemoteConfig,
  SharedProfileType,
  FilterConfig,
} from '@app/types';
import { CopyToClipboardDirective } from '@app/directives';
import { ProfileHeaderComponent } from './profile-header/profile-header.component';
import { ConfigModalSidebarComponent } from './config-modal-sidebar/config-modal-sidebar.component';
import { ConfigModalFooterComponent } from './config-modal-footer/config-modal-footer.component';
import {
  createInitialInteractiveFlowState,
  convertBoolAnswerToString,
  getDefaultAnswerFromQuestion,
} from '../../../../services/remote/utils/remote-config.utils';

// ── Types ─────────────────────────────────────────────────────────────────────

interface JobProfile {
  autoStart?: boolean;
  source?: string;
  dest?: string;
}

type JobMap = Record<string, JobProfile>;

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-remote-config-modal',
  imports: [
    ReactiveFormsModule,
    TranslateModule,
    MatIconModule,
    MatButtonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatTooltipModule,
    MatExpansionModule,
    RemoteConfigStepComponent,
    FlagConfigStepComponent,
    CliImportComponent,
    InteractiveConfigStepComponent,
    SearchContainerComponent,
    CopyToClipboardDirective,
    ProfileHeaderComponent,
    ConfigModalSidebarComponent,
    ConfigModalFooterComponent,
  ],
  providers: [
    RemoteConfigStateService,
    RemoteConfigFormBuilderService,
    RemoteConfigProfileManagerService,
    RemoteConfigCliImporterService,
  ],
  templateUrl: './remote-config-modal.component.html',
  styleUrls: ['./remote-config-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigModalComponent implements OnInit {
  readonly state = inject(RemoteConfigStateService);

  // ── Injections ────────────────────────────────────────────────────────────────

  private readonly dialogRef = inject(MatDialogRef<RemoteConfigModalComponent>);
  private readonly hostEl = inject(ElementRef<HTMLElement>);
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly jobManagementService = inject(JobManagementService);
  readonly configStep = viewChild(RemoteConfigStepComponent);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly dialogData = inject(MAT_DIALOG_DATA, { optional: true }) as DialogData;
  private readonly serveManagementService = inject(ServeManagementService);
  readonly iconService = inject(IconService);
  private readonly nautilusService = inject(NautilusService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly destroyRef = inject(DestroyRef);

  // ── Static config ─────────────────────────────────────────────────────────────

  readonly FLAG_TYPES = FLAG_TYPES;
  readonly LINKED_PROFILE_TYPES = LINKED_PROFILE_TYPES;

  readonly PROFILE_ICONS: Readonly<Record<string, string>> = {
    mount: 'hard-drive',
    sync: 'refresh',
    copy: 'copy',
    move: 'move',
    bisync: 'right-left',
    serve: 'server',
    vfs: 'vfs',
    filter: 'filter',
    backend: 'database',
    runtimeRemote: 'gear',
  };

  readonly remoteEditCategories = [
    { id: 'section-general', label: 'modals.remoteConfig.editMode.sections.general', icon: 'gear' },
    { id: 'section-auth', label: 'modals.remoteConfig.editMode.sections.auth', icon: 'lock' },
    {
      id: 'section-advanced',
      label: 'modals.remoteConfig.editMode.sections.advanced',
      icon: 'wrench',
    },
  ] as const;

  readonly visibleSections = computed(() => {
    const step = this.configStep();
    if (!step) return new Set<string>();

    const visible = new Set<string>();
    if (step.showNameField() || step.showAdvancedToggle()) visible.add('section-general');
    if (step.providerField()) visible.add('section-auth');
    if (step.showAdvancedOptions() && step.advancedFields().length > 0 && step.providerReady()) {
      visible.add('section-advanced');
    }
    return visible;
  });

  private pendingConfig: {
    remoteData: PendingRemoteData;
    finalConfig: RemoteConfigSections;
  } | null = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  constructor() {
    this.state.initStepConfigs(this.iconService);
    this.destroyRef.onDestroy(() => this.authStateService.cancelAuth());
    this.state.setStepInvalidFn((stepType: string) => this.isStepInvalid(stepType));
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.state.init(this.dialogData);
    } finally {
      this.state.isInitializing.set(false);
    }
  }

  isStepInvalid(stepType: string): boolean {
    return this.state.remoteConfigForm.get(`${stepType}Config`)?.invalid ?? false;
  }

  // ── Step navigation ───────────────────────────────────────────────────────────

  goToStep(step: number): void {
    if (this.isStepDisabled(step)) return;
    this.saveCurrentStepProfile();
    this.state.currentStep.set(step);
    this.scrollToTop();
    if (step === 1 && !this.state.editTarget()) {
      this.state.showCliImport.set(false);
    }
  }

  isStepDisabled(step: number): boolean {
    if (this.state.isStepNavigationLocked()) return true;
    return !this.state.editTarget() && step > 1 && this.state.remoteFormStatus() === 'INVALID';
  }

  nextStep(): void {
    const steps = this.state.applicableSteps();
    const idx = steps.indexOf(this.state.currentStep());
    if (idx !== -1 && idx < steps.length - 1) this.goToStep(steps[idx + 1]);
  }

  prevStep(): void {
    const steps = this.state.applicableSteps();
    const idx = steps.indexOf(this.state.currentStep());
    if (idx > 0) this.goToStep(steps[idx - 1]);
  }

  private scrollToTop(): void {
    this.hostEl.nativeElement.querySelector('.modal-content')?.scrollTo(0, 0);
  }

  handleInteractiveAnswerUpdate(newAnswer: string | number | boolean | null): void {
    if (this.state.interactiveFlowState().isActive) {
      this.state.interactiveFlowState.update(s => ({ ...s, answer: newAnswer }));
    }
  }

  // ── Form submission ───────────────────────────────────────────────────────────

  async onSubmit(): Promise<void> {
    if (this.state.isAuthInProgress()) return;
    try {
      const result = this.state.editTarget()
        ? await this.handleEditMode()
        : await this.handleCreateMode();
      if (result.success && !this.state.isAuthCancelled()) this.close();
    } catch (error) {
      console.error('Submission error:', error);
      this.state.interactiveFlowState.set(createInitialInteractiveFlowState());

      let errorMessage = this.translate.instant(
        'modals.remoteConfig.errors.interactiveProcessingFailed'
      );
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      this.notificationService.showError(errorMessage);
    } finally {
      if (!this.state.interactiveFlowState().isActive) {
        this.authStateService.resetAuthState();
      }
    }
  }

  private async handleCreateMode(): Promise<{ success: boolean }> {
    PROFILE_TYPES.forEach(type => this.state.saveCurrentProfile(type));
    const remoteData = this.state.cleanFormData(this.state.remoteForm.getRawValue());
    const finalConfig = this.buildFinalConfig();
    await this.authStateService.startAuth(remoteData.name, false);

    const requiresInteractiveFlow = this.state
      .commandOptions()
      .some(o => o.key === 'nonInteractive' && o.value === true);

    if (!requiresInteractiveFlow) {
      await this.remoteManagementService.createRemote(
        remoteData.name,
        remoteData,
        this.remoteManagementService.buildOpt(this.state.commandOptions())
      );
      this.pendingConfig = { remoteData, finalConfig };
      await this.finalizeRemoteCreation();
      return { success: true };
    }

    this.pendingConfig = { remoteData, finalConfig };
    return await this.startInteractiveRemoteConfig(remoteData);
  }

  private async handleEditMode(): Promise<{ success: boolean }> {
    const remoteName = this.state.currentRemoteName();
    await this.authStateService.startAuth(remoteName, true);

    const requiresInteractiveFlow = this.state
      .commandOptions()
      .some(o => o.key === 'nonInteractive' && o.value === true);

    if (this.state.editTarget() === 'remote') {
      const remoteData = this.state.cleanFormData(this.state.remoteForm.getRawValue());
      if (requiresInteractiveFlow) {
        this.pendingConfig = { remoteData, finalConfig: this.createEmptyFinalConfig() };
        return await this.startInteractiveRemoteConfig(remoteData);
      }
      await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
      return { success: true };
    }

    const updatedConfig = this.buildUpdateConfig();
    await this.appSettingsService.saveRemoteSettings(remoteName, updatedConfig);
    return { success: true };
  }

  // ── Config building ───────────────────────────────────────────────────────────

  private buildFinalConfig(): RemoteConfigSections {
    this.saveCurrentStepProfile();
    const p = this.state.profiles();
    return {
      [REMOTE_CONFIG_KEYS.mount]: p['mount'] as Record<string, MountConfig>,
      [REMOTE_CONFIG_KEYS.copy]: p['copy'] as Record<string, CopyConfig>,
      [REMOTE_CONFIG_KEYS.sync]: p['sync'] as Record<string, SyncConfig>,
      [REMOTE_CONFIG_KEYS.bisync]: p['bisync'] as Record<string, BisyncConfig>,
      [REMOTE_CONFIG_KEYS.move]: p['move'] as Record<string, MoveConfig>,
      [REMOTE_CONFIG_KEYS.serve]: p['serve'] as unknown as Record<string, ServeConfig>,
      [REMOTE_CONFIG_KEYS.filter]: p['filter'] as Record<string, FilterConfig>,
      [REMOTE_CONFIG_KEYS.vfs]: p['vfs'] as Record<string, VfsConfig>,
      [REMOTE_CONFIG_KEYS.backend]: p['backend'] as Record<string, BackendConfig>,
      [REMOTE_CONFIG_KEYS.runtimeRemote]: p['runtimeRemote'] as Record<string, RuntimeRemoteConfig>,
      showOnTray: true,
    };
  }

  private buildUpdateConfig(): Record<string, unknown> {
    const target = this.state.editTarget() as SharedProfileType;
    if (!target) return {};

    this.state.saveCurrentProfile(target);
    this.state.dirtyProfileTypes.add(target);

    const updatedConfig: Record<string, unknown> = {};
    for (const dirty of this.state.dirtyProfileTypes) {
      const key = REMOTE_CONFIG_KEYS[dirty as keyof typeof REMOTE_CONFIG_KEYS];
      if (key) updatedConfig[key] = this.state.profiles()[dirty];
    }

    return updatedConfig;
  }

  private createEmptyFinalConfig(): RemoteConfigSections {
    const empty = Object.fromEntries(
      Object.values(REMOTE_CONFIG_KEYS).map(k => [k, {}])
    ) as unknown as RemoteConfigSections;
    return { ...empty, showOnTray: true };
  }

  saveCurrentStepProfile(): void {
    const editTargetValue = this.state.editTarget();
    const type =
      editTargetValue && editTargetValue !== 'remote'
        ? editTargetValue
        : this.state.stepConfigs()[this.state.currentStep() - 1]?.type;
    if (type && type !== 'remote') this.state.saveCurrentProfile(type as SharedProfileType);
  }

  // ── Interactive flow ──────────────────────────────────────────────────────────

  onInteractiveContinue(answer: string | number | boolean | null): void {
    if (this.state.interactiveFlowState().isProcessing) return;
    this.state.interactiveFlowState.update(s => ({
      ...s,
      isProcessing: true,
      answer: String(answer),
    }));
    void this.processInteractiveResponse(String(answer));
  }

  private async startInteractiveRemoteConfig(
    remoteData: PendingRemoteData
  ): Promise<{ success: boolean }> {
    try {
      const resp = await this.remoteManagementService.startRemoteConfigInteractive(
        remoteData.name,
        remoteData.type,
        remoteData,
        this.remoteManagementService.buildOpt(this.state.commandOptions())
      );

      if (!resp || resp.State === '') {
        await this.finalizeRemoteCreation();
        return { success: true };
      }

      this.state.interactiveFlowState.set({
        isActive: true,
        isProcessing: false,
        question: resp,
        answer: getDefaultAnswerFromQuestion(resp),
      });

      return { success: false };
    } catch (error) {
      this.state.interactiveFlowState.set(createInitialInteractiveFlowState());
      throw error;
    }
  }

  private async processInteractiveResponse(answer: string): Promise<void> {
    try {
      const state = this.state.interactiveFlowState();
      if (!state.isActive || !state.question || !this.pendingConfig) return;

      const { name, ...paramRest } = this.pendingConfig.remoteData;
      const processedAnswer: unknown =
        state.question?.Option?.Type === 'bool' ? convertBoolAnswerToString(answer) : answer;

      const resp = await this.remoteManagementService.continueRemoteConfigInteractive(
        name,
        state.question.State,
        processedAnswer,
        paramRest,
        this.remoteManagementService.buildOpt(this.state.commandOptions())
      );

      if (!resp || resp.State === '') {
        this.state.interactiveFlowState.set(createInitialInteractiveFlowState());
        await this.finalizeRemoteCreation();
      } else {
        this.state.interactiveFlowState.update(s => ({
          ...s,
          question: resp,
          answer: getDefaultAnswerFromQuestion(resp),
          isProcessing: false,
        }));
      }
    } catch (error) {
      console.error('Error processing interactive response:', error);
      this.state.interactiveFlowState.update(s => ({ ...s, isProcessing: false }));
      this.notificationService.showError(
        this.translate.instant('modals.remoteConfig.errors.interactiveProcessingFailed')
      );
    }
  }

  // ── Finalization ──────────────────────────────────────────────────────────────

  private async finalizeRemoteCreation(): Promise<void> {
    if (!this.pendingConfig) return;
    const { remoteData, finalConfig } = this.pendingConfig;
    this.state.interactiveFlowState.set(createInitialInteractiveFlowState());
    await this.appSettingsService.saveRemoteSettings(remoteData.name, finalConfig);
    await this.remoteManagementService.getRemotes();
    this.authStateService.resetAuthState();
    await this.triggerAutoStartJobs(remoteData.name, finalConfig);
    this.close();
  }

  private async triggerAutoStartJobs(
    remoteName: string,
    finalConfig: RemoteConfigSections
  ): Promise<void> {
    const mountConfigs = finalConfig[REMOTE_CONFIG_KEYS.mount];
    if (mountConfigs) {
      for (const [profileName, config] of Object.entries(mountConfigs)) {
        if (config.autoStart && config.dest) {
          void this.mountManagementService.mountRemoteProfile(remoteName, profileName);
        }
      }
    }

    const jobStarters: Record<string, (remote: string, profile: string) => Promise<number>> = {
      copy: (remote, profile) =>
        this.jobManagementService.startProfileBatch('Copy', {
          remoteName: remote,
          profileName: profile,
        }),
      sync: (remote, profile) =>
        this.jobManagementService.startProfileBatch('Sync', {
          remoteName: remote,
          profileName: profile,
        }),
      bisync: (remote, profile) =>
        this.jobManagementService.startProfileBatch('Bisync', {
          remoteName: remote,
          profileName: profile,
        }),
      move: (remote, profile) =>
        this.jobManagementService.startProfileBatch('Move', {
          remoteName: remote,
          profileName: profile,
        }),
    };

    for (const [jobType, starter] of Object.entries(jobStarters)) {
      const configs = finalConfig[
        REMOTE_CONFIG_KEYS[jobType as keyof typeof REMOTE_CONFIG_KEYS]
      ] as JobMap | undefined;
      if (!configs) continue;
      for (const [profileName, config] of Object.entries(configs)) {
        if (config.autoStart && config.source && config.dest) {
          void starter(remoteName, profileName);
        }
      }
    }

    const serveConfigs = finalConfig[REMOTE_CONFIG_KEYS.serve];
    if (serveConfigs) {
      for (const [profileName, config] of Object.entries(serveConfigs)) {
        if (config.autoStart && (config as Record<string, unknown>)['options']) {
          void this.serveManagementService.startServeProfile(remoteName, profileName);
        }
      }
    }
  }

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.state.interactiveFlowState.set(createInitialInteractiveFlowState());
  }

  // ── Search & Listeners ─────────────────────────────────────────────────────────

  toggleSearchVisibility(): void {
    this.state.isSearchVisible.update(visible => !visible);
    if (!this.state.isSearchVisible()) this.state.searchQuery.set('');
  }

  onSearchInput(query: string): void {
    this.state.searchQuery.set(query);
  }

  scrollToSection(sectionId: string): void {
    this.hostEl.nativeElement
      .querySelector('#' + sectionId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
  }

  @HostListener('window:keydown', ['$event'])
  handleSearchKeyboard(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      this.toggleSearchVisibility();
    }
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.nautilusService.isNautilusOverlayOpen()) return;
    this.modalService.animatedClose(this.dialogRef);
  }
}
