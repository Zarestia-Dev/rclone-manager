import {
  Component,
  inject,
  computed,
  signal,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  FormArray,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { startWith } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { TranslatePipe } from '@ngx-translate/core';

import { AuthStateService } from 'src/app/services/security/auth-state.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RemoteCreationOrchestrator } from 'src/app/services/remote/remote-creation-orchestrator.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { ValidatorRegistryService } from 'src/app/services/ui/validation/validator-registry.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { RemotePresetsService } from 'src/app/services/remote/remote-presets';
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import {
  RemoteType,
  RemoteConfigSections,
  REMOTE_CONFIG_KEYS,
  CommandOption,
  WizardStep,
  OperationType,
  PendingRemoteData,
} from '@app/types';
import { OperationConfigComponent } from '../../../../shared/remote-config/app-operation-config/app-operation-config.component';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { RemoteConfigStepComponent } from 'src/app/shared/remote-config/remote-config-step/remote-config-step.component';
import { INITIAL_COMMAND_OPTIONS } from 'src/app/services/remote/utils/command-options.util';
import { mapFormToConfigProfile } from '../../../../services/remote/utils/remote-config.utils';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-quick-add-remote',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    ReactiveFormsModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatTabsModule,
    InteractiveConfigStepComponent,
    RemoteConfigStepComponent,
    OperationConfigComponent,
    TranslatePipe,
    MatTooltipModule,
    CopyToClipboardDirective,
  ],
  providers: [RemoteCreationOrchestrator],
  templateUrl: './quick-add-remote.component.html',
  styleUrls: ['./quick-add-remote.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickAddRemoteComponent {
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<QuickAddRemoteComponent>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  readonly iconService = inject(IconService);
  private readonly pathService = inject(PathService);
  private readonly presetsService = inject(RemotePresetsService);
  private readonly orchestrator = inject(RemoteCreationOrchestrator);

  readonly operationTabs = [
    {
      type: 'mount' as OperationType,
      label: 'modals.quickAdd.operations.mount.label',
      description: 'modals.quickAdd.operations.mount.description',
    },
    {
      type: 'sync' as OperationType,
      label: 'modals.quickAdd.operations.sync.label',
      description: 'modals.quickAdd.operations.sync.description',
    },
    {
      type: 'copy' as OperationType,
      label: 'modals.quickAdd.operations.copy.label',
      description: 'modals.quickAdd.operations.copy.description',
    },
    {
      type: 'bisync' as OperationType,
      label: 'modals.quickAdd.operations.bisync.label',
      description: 'modals.quickAdd.operations.bisync.description',
    },
    {
      type: 'move' as OperationType,
      label: 'modals.quickAdd.operations.move.label',
      description: 'modals.quickAdd.operations.move.description',
    },
    {
      type: 'serve' as OperationType,
      label: 'modals.quickAdd.operations.serve.label',
      description: 'modals.quickAdd.operations.serve.description',
    },
  ] as const;

  private readonly operationNames = this.operationTabs.map(t => t.type);

  // ── Wizard state ─────────────────────────────────────────────────────────
  readonly currentStep = signal<WizardStep>('setup');
  // Delegated to RemoteCreationOrchestrator — same public API, single source of truth.
  readonly interactiveFlowState = this.orchestrator.interactiveFlowState;
  readonly commandOptions = signal<CommandOption[]>(INITIAL_COMMAND_OPTIONS);
  readonly remoteTypes = signal<RemoteType[]>([]);
  readonly existingRemotes = signal<string[]>([]);

  // ── Form ─────────────────────────────────────────────────────────────────
  readonly quickAddForm = this.createQuickAddForm();

  // Stable references — quickAddForm never changes after construction
  readonly setupFormGroup = this.quickAddForm.get('setup') as FormGroup;

  readonly operationFormGroups = new Map<OperationType, FormGroup>(
    this.operationNames.map(name => [
      name,
      this.quickAddForm.get(`operations.${name}`) as FormGroup,
    ])
  );

  // ── Signals derived from form ─────────────────────────────────────────────

  readonly setupFormStatus = toSignal(
    this.setupFormGroup.statusChanges.pipe(startWith(this.setupFormGroup.status))
  );

  readonly quickAddFormStatus = toSignal(
    this.quickAddForm.statusChanges.pipe(startWith(this.quickAddForm.status))
  );

  readonly setupTypeValue = toSignal(
    (this.quickAddForm.get('setup.type') ?? new FormControl('')).valueChanges.pipe(
      startWith((this.quickAddForm.get('setup.type')?.value ?? '') as string)
    )
  );

  readonly setupNameValue = toSignal(
    (this.quickAddForm.get('setup.name') ?? new FormControl('')).valueChanges.pipe(
      startWith((this.quickAddForm.get('setup.name')?.value ?? '') as string)
    )
  );

  // ── Auth state ───────────────────────────────────────────────────────────

  readonly isAuthInProgress = this.authStateService.isAuthInProgress;
  readonly isAuthCancelled = this.authStateService.isAuthCancelled;
  readonly oauthUrl = this.authStateService.oauthUrl;
  // Delegated to orchestrator (was a duplicate computed — now consistent with the modal).
  readonly oauthHelperUrl = this.orchestrator.oauthHelperUrl;
  readonly shouldShowRemoteOAuthFallback = this.authStateService.shouldShowRemoteOAuthFallback;

  // ── Computed ─────────────────────────────────────────────────────────────

  readonly isSetupStepValid = computed(() => this.setupFormStatus() === 'VALID');

  readonly submitButtonText = computed(() =>
    this.isAuthInProgress() && !this.isAuthCancelled()
      ? 'modals.quickAdd.buttons.creating'
      : 'modals.quickAdd.buttons.create'
  );

  // Delegated to orchestrator — the previous quick-add-only version branched on
  // `question?.Option?.Required`; using the orchestrator's version for
  // consistency with the modal (password-type questions are always considered
  // satisfiable so the user can submit an empty password).
  readonly isInteractiveContinueDisabled = this.orchestrator.isInteractiveContinueDisabled;

  constructor() {
    this.setupFormListeners();

    this.destroyRef.onDestroy(() => {
      void this.authStateService.cancelAuth();
    });

    void this.initializeComponent();
  }

  private async initializeComponent(): Promise<void> {
    try {
      const [oauthSupportedRemotes, existingRemotes] = await Promise.all([
        this.remoteManagementService.getOAuthSupportedRemotes(),
        this.remoteManagementService.getRemotes(),
      ]);

      this.remoteTypes.set(
        oauthSupportedRemotes.map(remote => ({
          value: remote.name,
          label: remote.description,
        }))
      );
      this.existingRemotes.set(existingRemotes);

      const remoteNameControl = this.quickAddForm.get('setup.name');
      if (remoteNameControl) {
        remoteNameControl.setValidators([
          Validators.required,
          this.validatorRegistry.createRemoteNameValidator(existingRemotes),
        ]);
        remoteNameControl.updateValueAndValidity();
      }
    } catch (error) {
      console.error('Error initializing component:', error);
    }
  }

  // ── Form builders ─────────────────────────────────────────────────────────

  private createOperationPathGroup(
    defaultType: 'local' | 'currentRemote' | 'otherRemote'
  ): FormGroup {
    return this.fb.group({
      type: new FormControl(defaultType),
      path: new FormControl(''),
      remote: new FormControl(''),
    });
  }

  private createOperationGroup(opType: OperationType): FormGroup {
    if (opType === 'mount') {
      return this.fb.group({
        autoStart: new FormControl(false),
        source: this.createOperationPathGroup('currentRemote'),
        dest: this.createOperationPathGroup('local'),
      });
    }

    if (opType === 'serve') {
      return this.fb.group({
        autoStart: new FormControl(false),
        source: this.createOperationPathGroup('currentRemote'),
      });
    }

    const baseGroup = {
      autoStart: new FormControl(false),
      cronEnabled: new FormControl(false),
      cronExpression: new FormControl(''),
      watchEnabled: new FormControl(false),
      watchDelay: new FormControl(5),
    };

    if (opType === 'bisync') {
      return this.fb.group({
        ...baseGroup,
        source: this.createOperationPathGroup('currentRemote'),
        dest: this.createOperationPathGroup('local'),
      });
    }

    // Sync, Copy, Move: Multiple sources, single destination
    if (opType === 'sync' || opType === 'copy' || opType === 'move') {
      return this.fb.group({
        ...baseGroup,
        source: this.fb.array([this.createOperationPathGroup('currentRemote')]),
        dest: this.createOperationPathGroup('local'),
      });
    }

    // Fallback (should not be reached if all types handled above)
    return this.fb.group({
      ...baseGroup,
      source: this.createOperationPathGroup('currentRemote'),
      dest: this.createOperationPathGroup('local'),
    });
  }

  private createQuickAddForm(): FormGroup {
    return this.fb.group({
      setup: this.fb.group({
        name: [
          '',
          [
            Validators.required,
            this.validatorRegistry.createRemoteNameValidator(this.existingRemotes()),
          ],
        ],
        type: ['', Validators.required],
      }),
      operations: this.fb.group(
        Object.fromEntries(this.operationNames.map(name => [name, this.createOperationGroup(name)]))
      ),
    });
  }

  // ── Listeners ─────────────────────────────────────────────────────────────

  private static readonly SOURCE_DEST_OP_TYPES = new Set<OperationType>([
    'sync',
    'copy',
    'bisync',
    'move',
  ]);

  private setupFormListeners(): void {
    for (const opName of this.operationNames) {
      const opGroup = this.quickAddForm.get(`operations.${opName}`);
      if (opGroup instanceof FormGroup) {
        this.validatorRegistry.setupOperationValidation(opGroup, this.destroyRef);
      }
    }
  }

  // ── Wizard navigation ─────────────────────────────────────────────────────

  nextStep(): void {
    if (this.currentStep() !== 'setup') return;
    this.quickAddForm.get('setup')?.markAllAsTouched();
    if (this.isSetupStepValid()) {
      this.currentStep.set('operations');
    }
  }

  prevStep(): void {
    if (this.currentStep() === 'operations') {
      this.currentStep.set('setup');
    }
  }

  // ── Folder selection ──────────────────────────────────────────────────────

  async selectFolder(opName: string, pathType: 'source' | 'dest'): Promise<void> {
    try {
      const requireEmpty = opName === 'mount' && pathType === 'dest';
      const selectedPath = await this.fileSystemService.selectFolder(requireEmpty);
      if (!selectedPath) return;

      const getControlPath = (): string | null => {
        if (opName === 'mount' && pathType === 'dest') return 'operations.mount.dest.path';

        const opGroup = this.quickAddForm.get(`operations.${opName}`);
        if (!opGroup) return null;

        const ctrl = opGroup.get(pathType);
        if (ctrl instanceof FormGroup) {
          return `operations.${opName}.${pathType}.path`;
        } else if (ctrl instanceof FormArray && ctrl.length > 0) {
          return `operations.${opName}.${pathType}.0.path`;
        }
        return null;
      };

      const controlPath = getControlPath();
      if (controlPath) {
        this.quickAddForm.get(controlPath)?.patchValue(selectedPath);
      }
    } catch (error) {
      console.error('Error selecting folder:', error);
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async onSubmit(): Promise<void> {
    const setup = this.quickAddForm.get('setup')?.value;
    const operations = this.quickAddForm.get('operations')?.value;

    if (this.quickAddForm.invalid || this.isAuthInProgress() || !setup || !operations) return;

    await this.authStateService.startAuth(setup.name, false);

    const requiresInteractiveFlow = this.commandOptions().some(
      o => o.key === 'nonInteractive' && o.value === true
    );

    try {
      if (requiresInteractiveFlow) {
        await this.handleInteractiveCreation(setup, operations);
      } else {
        await this.handleStandardCreation(setup, operations);
        if (!this.isAuthCancelled()) this.dialogRef.close(true);
      }
    } catch (error) {
      console.error('Error in onSubmit:', error);
    } finally {
      if (!requiresInteractiveFlow || !this.interactiveFlowState().isActive) {
        this.authStateService.resetAuthState();
      }
    }
  }

  private async handleStandardCreation(setup: any, operations: any): Promise<void> {
    const finalConfig = this.buildFinalConfig(setup.name, operations);
    const preset = this.presetsService.resolvePresets(setup.type || '');
    const parameters = {
      name: setup.name,
      type: setup.type,
      ...(preset.remote || {}),
    };
    await this.remoteManagementService.createRemote(
      setup.name,
      parameters,
      this.remoteManagementService.buildOpt(this.commandOptions())
    );
    // Persist settings + refresh remotes + trigger autostarts via the orchestrator's
    // unified finalizeCreation (matches what the modal does on its non-interactive path).
    const remoteData: PendingRemoteData = {
      name: setup.name,
      type: setup.type,
      ...(preset.remote || {}),
    };
    this.orchestrator.setPendingConfig(remoteData, finalConfig);
    await this.orchestrator.finalizeCreation();
  }

  private async handleInteractiveCreation(setup: any, operations: any): Promise<void> {
    const finalConfig = this.buildFinalConfig(setup.name, operations);
    const preset = this.presetsService.resolvePresets(setup.type || '');
    const remoteData: PendingRemoteData = {
      name: setup.name,
      type: setup.type,
      ...(preset.remote || {}),
    };
    this.orchestrator.setPendingConfig(remoteData, finalConfig);
    try {
      const completed = await this.orchestrator.startInteractiveCreation(
        remoteData,
        finalConfig,
        this.commandOptions()
      );
      if (completed) {
        this.dialogRef.close(true);
      } else {
        this.currentStep.set('interactive');
      }
    } catch (error) {
      // Match the previous quick-add behavior: on a fatal start error, try to
      // finalize (saves settings, triggers autostarts) and close the dialog
      // rather than leaving the user stuck on a dead interactive step.
      console.error('Error starting interactive config:', error);
      await this.orchestrator.finalizeCreation();
      this.dialogRef.close(true);
    }
  }

  private buildFinalConfig(remoteName: string, operations: any): RemoteConfigSections {
    const buildProfile = (type: string, opData: any): any => {
      return mapFormToConfigProfile(type, opData, {
        remoteName,
        pathService: this.pathService,
      });
    };

    const preset = this.presetsService.resolvePresets(
      this.quickAddForm.get('setup.type')?.value || ''
    );

    const mountProfile = buildProfile('mount', operations.mount);
    if (preset.mount && Object.keys(preset.mount).length) {
      if (!mountProfile['rclone']) mountProfile['rclone'] = {};
      mountProfile['rclone']['mountOpt'] = {
        ...mountProfile['rclone']['mountOpt'],
        ...preset.mount,
      };
    }

    const profileName = 'Default';

    return {
      [REMOTE_CONFIG_KEYS.mount]: {
        [profileName]: {
          ...mountProfile,
        },
      },
      [REMOTE_CONFIG_KEYS.copy]: {
        [profileName]: buildProfile('copy', operations.copy),
      },
      [REMOTE_CONFIG_KEYS.sync]: {
        [profileName]: buildProfile('sync', operations.sync),
      },
      [REMOTE_CONFIG_KEYS.bisync]: {
        [profileName]: buildProfile('bisync', operations.bisync),
      },
      [REMOTE_CONFIG_KEYS.move]: {
        [profileName]: buildProfile('move', operations.move),
      },
      [REMOTE_CONFIG_KEYS.serve]: {
        [profileName]: {
          ...buildProfile('serve', operations.serve),
        },
      },
      showOnTray: true,
    } as unknown as RemoteConfigSections;
  }

  // ── Interactive OAuth flow ─────────────────────────────────────────────────

  async onInteractiveContinue(answer: string | number | boolean | null): Promise<void> {
    this.interactiveFlowState.update(state => ({ ...state, answer, isProcessing: true }));
    try {
      await this.orchestrator.submitInteractiveAnswer(answer, this.commandOptions());
    } finally {
      if (this.interactiveFlowState().isActive) {
        this.interactiveFlowState.update(state => ({ ...state, isProcessing: false }));
      }
    }
    // submitInteractiveAnswer calls finalizeCreation internally when the backend
    // signals completion — at that point the flow is no longer active and we
    // should close the dialog.
    if (!this.interactiveFlowState().isActive) this.dialogRef.close(true);
  }

  handleInteractiveAnswerUpdate(newAnswer: string | number | boolean | null): void {
    this.orchestrator.updateInteractiveAnswer(newAnswer);
  }

  async cancelAuth(): Promise<void> {
    await this.orchestrator.cancelAuth();
    this.currentStep.set('operations');
  }

  close(): void {
    this.dialogRef.close();
  }
}
