import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  afterNextRender,
  viewChild,
} from '@angular/core';
import { ReactiveFormsModule, FormGroup, FormControl } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
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
import { IconService } from '../../../../services/ui/icon.service';
import { RemoteManagementService } from '../../../../services/remote/remote-management.service';
import {
  RemoteConfigStateService,
  DialogData,
} from '../../../../services/remote/remote-config-state.service';
import { RemoteCreationOrchestrator } from '../../../../services/remote/remote-creation-orchestrator.service';
import { RcloneValueMapperService } from '../../../../services/remote/rclone-value-mapper.service';
import {
  RemoteConfigSections,
  REMOTE_CONFIG_KEYS,
  LINKED_PROFILE_TYPES,
  PROFILE_ICONS,
  EditTarget,
} from '@app/types';
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';
import { ProfileSwitcherComponent } from './profile-switcher/profile-switcher.component';
import { ConfigModalSidebarComponent } from './config-modal-sidebar/config-modal-sidebar.component';
import { ConfigModalFooterComponent } from './config-modal-footer/config-modal-footer.component';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import { ApplyTemplateEvent } from '../../../../shared/remote-config/preset-template-bar/preset-template-bar.component';

@Component({
  selector: 'app-remote-config-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    ReactiveFormsModule,
    TranslatePipe,
    MatIconModule,
    MatButtonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
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
  readonly configStep = viewChild(RemoteConfigStepComponent);
  private readonly dialogData = (inject(MAT_DIALOG_DATA, { optional: true }) ?? undefined) as
    DialogData | undefined;
  readonly iconService = inject(IconService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly orchestrator = inject(RemoteCreationOrchestrator);
  private readonly valueMapper = inject(RcloneValueMapperService);

  readonly LINKED_PROFILE_TYPES = LINKED_PROFILE_TYPES;

  readonly PROFILE_ICONS = PROFILE_ICONS;

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

  constructor() {
    this.destroyRef.onDestroy(() => this.authStateService.cancelAuth());
    afterNextRender(() => this.setupResponsiveLayout());
    this.initializeState();
  }

  private setupResponsiveLayout(): void {
    const mql = window.matchMedia('(min-width: 768px)');
    const update = (matches: boolean): void => {
      this.sidebarMode.set(matches ? 'side' : 'over');
      if (!matches) {
        this.isSidebarOpen.set(false);
      }
    };
    const handler = (e: MediaQueryListEvent): void => update(e.matches);

    update(mql.matches);
    mql.addEventListener('change', handler);
    this.destroyRef.onDestroy(() => mql.removeEventListener('change', handler));
  }

  private async initializeState(): Promise<void> {
    try {
      await this.state.init(this.dialogData);
      this.state.isInitializing.set(false);
    } catch (error) {
      console.error('Failed to initialize remote config state:', error);
      const errorMsg = this.translate.instant('modals.remoteConfig.errors.loadFailed');
      this.notificationService.showError(
        errorMsg !== 'modals.remoteConfig.errors.loadFailed'
          ? errorMsg
          : 'Failed to load remote configuration settings'
      );
      this.close();
    }
  }

  goToStep(step: number): void {
    if (!this.state.isStepClickable(step)) return;
    this.saveCurrentStepProfile();
    this.state.currentStep.set(step);
    this.scrollToTop();
    if (step === 1 && !this.state.editTarget()) {
      this.state.showObscureTool.set(false);
      this.state.showCliImport.set(false);
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
    if (this.state.isAuthInProgress()) return;
    try {
      const result = this.state.editTarget()
        ? await this.handleEditMode()
        : await this.handleCreateMode();
      if (result.success && !this.state.isAuthCancelled()) this.close();
    } catch (error) {
      console.error('Submission error:', error);
      this.orchestrator.resetInteractiveFlow();

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

  private readonly requiresInteractiveFlow = computed(() =>
    this.state.commandOptions().some(o => o.key === 'nonInteractive' && o.value === true)
  );

  private async handleCreateMode(): Promise<{ success: boolean }> {
    this.state.PROFILE_TYPES.forEach(type => this.state.saveCurrentProfile(type));
    const remoteData = this.state.cleanFormData(this.state.remoteForm.getRawValue());
    const finalConfig = this.buildFinalConfig();
    await this.authStateService.startAuth(remoteData.name, false);

    if (!this.requiresInteractiveFlow()) {
      await this.remoteManagementService.createRemote(
        remoteData.name,
        remoteData,
        this.remoteManagementService.buildOpt(this.state.commandOptions())
      );
      this.orchestrator.setPendingConfig(remoteData, finalConfig);
      await this.orchestrator.finalizeCreation();
      return { success: true };
    }

    this.orchestrator.setPendingConfig(remoteData, finalConfig);
    const completed = await this.orchestrator.startInteractiveCreation(
      remoteData,
      finalConfig,
      this.state.commandOptions()
    );
    return { success: completed };
  }

  private async handleEditMode(): Promise<{ success: boolean }> {
    const remoteName = this.state.currentRemoteName();
    await this.authStateService.startAuth(remoteName, true);

    if (this.state.editTarget() === 'remote') {
      const remoteData = this.state.cleanFormData(this.state.remoteForm.getRawValue());
      if (this.requiresInteractiveFlow()) {
        const finalConfig = this.buildFinalConfig(true);
        this.orchestrator.setPendingConfig(remoteData, finalConfig);
        const completed = await this.orchestrator.startInteractiveCreation(
          remoteData,
          finalConfig,
          this.state.commandOptions()
        );
        return { success: completed };
      }
      await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
      return { success: true };
    }

    const target = this.state.editTarget();
    if (target === 'remote' || target === null) {
      return { success: false };
    }
    const success = await this.state.saveRemoteProfiles(remoteName, target);
    return { success };
  }

  private buildFinalConfig(empty = false): RemoteConfigSections {
    this.saveCurrentStepProfile();
    const p = this.state.profiles();
    const sections = Object.fromEntries(
      Object.entries(REMOTE_CONFIG_KEYS).map(([type, key]) => [
        key,
        empty ? {} : p[type as keyof typeof p],
      ])
    ) as unknown as RemoteConfigSections;
    return { ...sections, showOnTray: true };
  }

  saveCurrentStepProfile(): void {
    const editTargetValue = this.state.editTarget();
    const type =
      editTargetValue && editTargetValue !== 'remote'
        ? editTargetValue
        : this.state.stepConfigs()[this.state.currentStep() - 1]?.type;
    if (type && type !== 'remote') this.state.saveCurrentProfile(type);
  }

  onInteractiveContinue(answer: string | number | boolean | null): void {
    if (this.state.interactiveFlowState().isProcessing) return;
    this.state.interactiveFlowState.update(s => ({
      ...s,
      isProcessing: true,
      answer: String(answer),
    }));
    void this.orchestrator.submitInteractiveAnswer(answer, this.state.commandOptions()).then(() => {
      this.closeIfFlowComplete();
    });
  }

  private closeIfFlowComplete(): void {
    if (!this.state.interactiveFlowState().isActive) this.close();
  }

  async cancelAuth(): Promise<void> {
    await this.orchestrator.cancelAuth();
  }

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

  onApplyPresets(): void {
    const remoteType = this.state.remoteTypeSignal();
    if (!remoteType) return;
    this.state.applyPresets(remoteType);
    const msg = this.translate.instant('wizards.presets.applied');
    this.notificationService.showSuccess(
      msg !== 'wizards.presets.applied' ? msg : 'Default presets applied successfully'
    );
  }

  readonly currentValues = computed(() => {
    const rcf = this.state.remoteConfigForm;
    const flagFields = this.state.dynamicFlagFields();

    const getCleanOptions = (
      configKey: string,
      flagType: 'vfs' | 'mount' | 'backend' | 'filter'
    ): Record<string, unknown> => {
      const opts = (rcf.get(`${configKey}.options`) as FormGroup | null)?.getRawValue() ?? {};
      return this.valueMapper.cleanData(opts, flagFields[flagType] ?? []);
    };

    const remoteRaw = this.state.remoteForm.getRawValue();
    const cleanRemoteData = this.state.cleanFormData(remoteRaw) as Record<string, unknown>;
    delete cleanRemoteData['name'];
    delete cleanRemoteData['type'];

    return {
      vfs: getCleanOptions('vfsConfig', 'vfs'),
      mount: getCleanOptions('mountConfig', 'mount'),
      backend: getCleanOptions('backendConfig', 'backend'),
      filter: getCleanOptions('filterConfig', 'filter'),
      remote: cleanRemoteData,
    };
  });

  onApplyTemplate(event: ApplyTemplateEvent): void {
    const { values } = event;
    const patchGroupOptions = (configKey: string, opts?: Record<string, unknown>): void => {
      if (!opts) return;
      const group = this.state.remoteConfigForm.get(`${configKey}.options`) as FormGroup | null;
      if (group) {
        for (const [k, v] of Object.entries(opts)) {
          if (!group.contains(k)) {
            group.addControl(k, new FormControl(v));
          } else {
            group.get(k)?.setValue(v);
          }
        }
      }
    };

    if (values.vfs) patchGroupOptions('vfsConfig', values.vfs);
    if (values.mount) patchGroupOptions('mountConfig', values.mount);
    if (values.backend) patchGroupOptions('backendConfig', values.backend);
    if (values.filter) patchGroupOptions('filterConfig', values.filter);
    if (values.remote) {
      this.state.remoteForm.patchValue(values.remote, { emitEvent: false });
    }
    const msg = this.translate.instant('templates.applySuccess', { name: event.sourceName });
    this.notificationService.showSuccess(msg);
  }

  close(): void {
    this.dialogRef.close();
  }
}
