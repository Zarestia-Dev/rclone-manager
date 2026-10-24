import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatSidenavModule, MatDrawerMode } from '@angular/material/sidenav';
import { RemoteConfigStepComponent } from '../../../../shared/remote-config/remote-config-step/remote-config-step.component';
import { FlagConfigStepComponent } from '../../../../shared/remote-config/flag-config-step/flag-config-step.component';
import { OperationConfigComponent } from '../../../../shared/remote-config/app-operation-config/app-operation-config.component';
import { ObscureToolComponent } from '../../../../shared/remote-config/obscure-tool/obscure-tool.component';
import { CliImportComponent } from '../../../../shared/remote-config/cli-import/cli-import.component';
import { AlertBannerComponent } from '../../../../shared/components/alert-banner/alert-banner.component';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { AuthStateService } from '../../../../services/security/auth-state.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { RemoteManagementService } from '../../../../services/remote/remote-management.service';
import {
  RemoteConfigStateService,
  DialogData,
} from '../../../../services/remote/remote-config-state.service';
import { RemoteCreationOrchestrator } from '../../../../services/remote/remote-creation-orchestrator.service';
import { retargetProfilesRemote } from '../../../../services/remote/utils/profile-mapper.utils';
import {
  RemoteConfigSections,
  REMOTE_CONFIG_KEYS,
  LINKED_PROFILE_TYPES,
  PROFILE_ICONS,
  EditTarget,
  TemplateCategory,
} from '@app/types';
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';
import { ProfileSwitcherComponent } from './profile-switcher/profile-switcher.component';
import { ConfigModalSidebarComponent } from './config-modal-sidebar/config-modal-sidebar.component';
import { ConfigModalFooterComponent } from './config-modal-footer/config-modal-footer.component';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import { ApplyTemplateEvent } from '../../../../shared/remote-config/preset-template-bar/preset-template-bar.component';
import { getConfigCategories } from '../../../../services/remote/utils/config-metadata.utils';
import { syncResponsiveSidebar } from 'src/app/shared/utils';

import { ConfigFormSkeletonComponent } from 'src/app/shared/remote-config/config-form-skeleton/config-form-skeleton.component';

@Component({
  selector: 'app-remote-config-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    ConfigFormSkeletonComponent,
    ReactiveFormsModule,
    TranslatePipe,
    MatIconModule,
    MatButtonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatExpansionModule,
    MatSidenavModule,
    RemoteConfigStepComponent,
    FlagConfigStepComponent,
    OperationConfigComponent,
    ObscureToolComponent,
    CliImportComponent,
    AlertBannerComponent,
    InteractiveConfigStepComponent,
    SearchContainerComponent,
    CopyToClipboardDirective,
    ProfileSwitcherComponent,
    ConfigModalSidebarComponent,
    ConfigModalFooterComponent,
  ],

  providers: [RemoteCreationOrchestrator, RemoteConfigStateService],
  templateUrl: './remote-config-modal.component.html',
  styleUrls: ['../../../../styles/_shared-modal.scss', './remote-config-modal.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigModalComponent {
  readonly state = inject(RemoteConfigStateService);

  private readonly dialogRef = inject(MatDialogRef<RemoteConfigModalComponent>);
  private readonly hostEl = inject(ElementRef<HTMLElement>);
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly dialogData = (inject(MAT_DIALOG_DATA, { optional: true }) ?? undefined) as
    DialogData | undefined;
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly orchestrator = inject(RemoteCreationOrchestrator);

  readonly LINKED_PROFILE_TYPES = LINKED_PROFILE_TYPES;

  readonly PROFILE_ICONS = PROFILE_ICONS;

  readonly hasInitialized = signal(false);
  readonly isSidebarOpen = signal(true);
  readonly sidebarMode = signal<MatDrawerMode>('side');

  readonly remoteEditCategories = [
    { id: 'section-general', label: 'modals.remoteConfig.editMode.sections.general', icon: 'gear' },
    { id: 'section-auth', label: 'modals.remoteConfig.editMode.sections.auth', icon: 'lock' },
    {
      id: 'section-advanced',
      label: 'modals.remoteConfig.editMode.sections.advanced',
      icon: 'wrench',
    },
  ] as const;

  readonly visibleSections = this.state.remoteEditVisibleSections;

  constructor() {
    this.destroyRef.onDestroy(() => {
      void this.orchestrator.cancelAuth();
    });
    syncResponsiveSidebar(
      768,
      this.sidebarMode,
      this.isSidebarOpen,
      this.destroyRef,
      this.hostEl.nativeElement
    );
    this.initializeState();
  }

  private async initializeState(): Promise<void> {
    this.state.isInitializing.set(true);
    try {
      await this.state.init(this.dialogData);
      if (!this.state.loadFailed()) this.hasInitialized.set(true);
    } catch (error) {
      console.error('Failed to initialize remote config state:', error);
      const errorMsg = this.translate.instant('modals.remoteConfig.errors.loadFailed');
      this.notificationService.showError(
        errorMsg !== 'modals.remoteConfig.errors.loadFailed'
          ? errorMsg
          : 'Failed to load remote configuration settings'
      );
      this.state.initializationFailed.set(true);
    } finally {
      this.state.isInitializing.set(false);
    }
  }

  async retryLoading(): Promise<void> {
    if (this.hasInitialized()) await this.state.retryActiveFields();
    else await this.initializeState();
  }

  goToStep(step: number): void {
    if (!this.state.isStepClickable(step)) return;
    this.saveCurrentStepProfile();
    this.state.currentStep.set(step);
    void this.state.loadActiveProfile();
    this.scrollToTop();
    if (step === 1 && !this.state.editTarget()) {
      this.state.tools.close();
    }
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
    this.orchestrator.updateInteractiveAnswer(newAnswer);
  }

  async onSubmit(): Promise<void> {
    if (this.state.isSaveDisabled()) return;
    try {
      const result = this.state.isEditingExisting()
        ? await this.handleEditMode()
        : await this.handleCreateMode();
      if (result.success && !this.state.isAuthCancelled()) this.close();
    } catch (error) {
      console.error('Submission error:', error);

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
      if (
        this.state.isEditingExisting() &&
        this.state.isAuthInProgress() &&
        !this.state.interactiveFlowState().isActive
      ) {
        this.authStateService.resetAuthState();
      }
    }
  }

  private readonly requiresInteractiveFlow = computed(() =>
    this.state.commandOptions().some(o => o.key === 'nonInteractive' && o.value === true)
  );

  private async handleCreateMode(): Promise<{ success: boolean }> {
    const remoteData = this.state.cleanFormData(this.state.remoteForm.getRawValue());
    const success = await this.orchestrator.createRemote(
      remoteData,
      this.buildFinalConfig(),
      this.state.commandOptions()
    );
    return { success };
  }

  private async handleEditMode(): Promise<{ success: boolean }> {
    const remoteName = this.state.currentRemoteName();
    await this.authStateService.startAuth(remoteName, true);

    if (this.state.editTarget() === 'remote' || this.state.editTarget() === null) {
      const remoteData = this.state.cleanFormData(this.state.remoteForm.getRawValue());
      if (this.requiresInteractiveFlow()) {
        const finalConfig = this.buildFinalConfig();
        this.orchestrator.setPendingConfig(remoteData, finalConfig);
        const completed = await this.orchestrator.startInteractiveCreation(
          remoteData,
          finalConfig,
          this.state.commandOptions()
        );
        return { success: completed };
      }
      await this.remoteManagementService.updateRemote(
        remoteData.name,
        remoteData,
        undefined,
        this.orchestrator.backendName
      );
      let profileSuccess = true;
      if (this.state.editTarget() === null) {
        profileSuccess = await this.state.saveRemoteProfiles(remoteName);
      }
      return { success: profileSuccess };
    }

    const target = this.state.editTarget();
    if (!target || target === 'remote') {
      return { success: false };
    }
    const success = await this.state.saveRemoteProfiles(remoteName, target);
    return { success };
  }

  private buildFinalConfig(): RemoteConfigSections {
    this.saveCurrentStepProfile();
    let p = this.state.profiles();

    if (this.state.cloneTarget()) {
      const cloneFrom = this.dialogData?.cloneFrom;
      const targetName = this.state.remoteForm.get('name')?.value || this.state.currentRemoteName();
      if (cloneFrom && targetName && cloneFrom !== targetName) {
        p = retargetProfilesRemote(p, cloneFrom, targetName);
      }
    }

    const sections = Object.fromEntries(
      Object.entries(REMOTE_CONFIG_KEYS).map(([type, key]) => [
        key,
        p[type as keyof typeof p] ?? {},
      ])
    ) as unknown as RemoteConfigSections;
    return { ...sections, showOnTray: true };
  }

  saveCurrentStepProfile(): void {
    const editTargetValue = this.state.editTarget();
    const stepIdx = this.state.currentStep() - 1;
    const type =
      editTargetValue && editTargetValue !== 'remote'
        ? editTargetValue
        : stepIdx >= 0
          ? this.state.stepConfigs()[stepIdx]?.type
          : undefined;
    if (type && type !== 'remote') this.state.saveCurrentProfile(type);
  }

  onInteractiveContinue(answer: string | number | boolean | null): void {
    if (this.state.interactiveFlowState().isProcessing) return;
    this.state.interactiveFlowState.update(s => ({
      ...s,
      isProcessing: true,
      answer: answer != null ? String(answer) : '',
    }));
    void this.orchestrator
      .submitInteractiveAnswer(answer, this.state.commandOptions())
      .then(completed => {
        if (completed) this.close();
      });
  }

  async cancelAuth(): Promise<void> {
    await this.orchestrator.cancelAuth();
  }

  toggleSearchVisibility(): void {
    this.state.tools.toggle('search');
  }

  onSearchInput(query: string): void {
    this.state.searchQuery.set(query);
  }

  scrollToSection(sectionId: string): void {
    this.hostEl.nativeElement
      .querySelector('#' + CSS.escape(sectionId))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
  }

  toggleSidebar(): void {
    this.isSidebarOpen.update(v => !v);
  }

  private closeSidebarIfOver(): void {
    if (this.sidebarMode() === 'over') {
      this.isSidebarOpen.set(false);
    }
  }

  onStepSelected(step: number): void {
    this.goToStep(step);
    this.closeSidebarIfOver();
  }

  onSectionScrolled(sectionId: string): void {
    this.scrollToSection(sectionId);
    this.closeSidebarIfOver();
  }

  onProfileSelected(event: { type: EditTarget; name: string }): void {
    this.state.selectProfile(event.type, event.name);
    this.closeSidebarIfOver();
  }

  onSharedNavigated(type: EditTarget): void {
    this.state.navigateToShared(type);
    this.closeSidebarIfOver();
  }

  onReturnFromShared(): void {
    this.state.returnFromShared();
    this.closeSidebarIfOver();
  }

  onSearchToggled(): void {
    this.toggleSearchVisibility();
    this.closeSidebarIfOver();
  }

  onCliImportToggled(): void {
    this.state.toggleCliImportVisibility();
    if (this.state.showCliImport()) this.closeSidebarIfOver();
  }

  onObscureToolToggled(): void {
    this.state.toggleObscureToolVisibility();
    if (this.state.showObscureTool()) this.closeSidebarIfOver();
  }

  readonly applicableCategories = computed(() => getConfigCategories(this.state.activeStepType()));

  readonly currentValues = (): Partial<Record<TemplateCategory, Record<string, unknown>>> => {
    const applicable = new Set(this.applicableCategories());
    const result: Partial<Record<TemplateCategory, Record<string, unknown>>> = {};

    if (applicable.has('remote')) {
      const remoteRaw = this.state.remoteForm.getRawValue();
      const remoteClean = (this.state.cleanFormData(remoteRaw) as Record<string, unknown>) ?? {};
      const cleanRemoteData: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(remoteClean)) {
        if (k !== 'name' && k !== 'type') cleanRemoteData[k] = v;
      }
      result.remote = cleanRemoteData;
    }

    for (const cat of applicable) {
      if (cat === 'remote') continue;
      result[cat] = this.state.getProfileTemplateValues(cat);
    }

    return result;
  };

  onApplyTemplate(event: ApplyTemplateEvent): void {
    this.state.applyTemplate(event.values, this.state.activeStepType());
    const msg = this.translate.instant('templates.applySuccess', { name: event.sourceName });
    this.notificationService.showSuccess(msg);
  }

  close(): void {
    this.dialogRef.close();
  }
}
