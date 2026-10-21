import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  OnInit,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatListModule } from '@angular/material/list';
import { MatSidenavModule, MatDrawerMode } from '@angular/material/sidenav';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  AppConfig,
  FlagType,
  FLAG_TYPES,
  OperationDefinition,
  PrimaryActionType,
  QuickRun,
  QuickRunConfig,
  QuickRunInput,
  RcConfigOption,
  TemplateCategory,
  PROFILE_ICONS,
  ALL_PRIMARY_ACTIONS,
  OPERATION_REGISTRY,
  WorkflowNode,
} from '@app/types';
import { WorkflowStateService } from 'src/app/services/flow/workflow-state.service';
import { OperationConfigComponent } from 'src/app/shared/remote-config/app-operation-config/app-operation-config.component';
import { FlagConfigStepComponent } from 'src/app/shared/remote-config/flag-config-step/flag-config-step.component';
import { RemoteConfigStepComponent } from 'src/app/shared/remote-config/remote-config-step/remote-config-step.component';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { SearchContainerComponent } from 'src/app/shared/components/search-container/search-container.component';
import { CliImportComponent } from 'src/app/shared/remote-config/cli-import/cli-import.component';
import { ImportResult } from 'src/app/services/remote/cli-flag-mapper.service';
import { ObscureToolComponent } from 'src/app/shared/remote-config/obscure-tool/obscure-tool.component';
import {
  PresetTemplateBarComponent,
  ApplyTemplateEvent,
} from 'src/app/shared/remote-config/preset-template-bar/preset-template-bar.component';
import { getConfigCategories } from 'src/app/services/remote/utils/config-metadata.utils';
import { ConfigResourceState } from 'src/app/services/remote/utils/config-resource-state';
import { ConfigEditorTools } from 'src/app/shared/remote-config/config-editor-tools';
import { FlagConfigService } from 'src/app/services/remote/flag-config.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { QuickRunEditorModalOptions } from 'src/app/services/ui/modal.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { PathInspectionService } from 'src/app/services/infrastructure/platform/path-inspection.service';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import { EscapeCloseDirective } from 'src/app/shared/directives/escape-close.directive';
import { syncResponsiveSidebar } from 'src/app/shared/utils';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  mapConfigToFormProfile,
  mapFormToConfigProfile,
} from 'src/app/services/remote/utils/profile-mapper.utils';

import {
  createConfigFormGroup,
  reconcileDynamicControls,
  patchConfigOptions,
  patchConfigPaths,
} from 'src/app/services/remote/utils/config-form.utils';
import {
  mergeImportedFlags,
  mergeImportedProfile,
} from 'src/app/services/remote/utils/profile-import.utils';

import { ConfigFormSkeletonComponent } from 'src/app/shared/remote-config/config-form-skeleton/config-form-skeleton.component';

@Component({
  selector: 'app-quick-run-editor',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    ConfigFormSkeletonComponent,
    ReactiveFormsModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatListModule,
    MatSidenavModule,
    TranslatePipe,
    OperationConfigComponent,
    FlagConfigStepComponent,
    RemoteConfigStepComponent,
    AlertBannerComponent,
    SearchContainerComponent,
    CliImportComponent,
    ObscureToolComponent,
    PresetTemplateBarComponent,
  ],
  templateUrl: './quick-run-editor.component.html',
  styleUrls: ['./quick-run-editor.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickRunEditorComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly hostEl = inject(ElementRef<HTMLElement>);
  private readonly quickRunService = inject(QuickRunService);
  private readonly flagConfigService = inject(FlagConfigService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly notificationService = inject(NotificationService);
  private readonly pathService = inject(PathService);
  private readonly pathInspectionService = inject(PathInspectionService);
  private readonly translate = inject(TranslateService);
  private readonly valueMapper = inject(RcloneValueMapperService);
  readonly iconService = inject(IconService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly workflowStateService = inject(WorkflowStateService);
  private readonly dialogRef = inject(MatDialogRef<QuickRunEditorComponent>, { optional: true });
  private readonly dialogData = inject<QuickRunEditorModalOptions | null>(MAT_DIALOG_DATA, {
    optional: true,
  });

  /** When set, the editor loads this workflow node for editing. */
  readonly workflowNode = input<WorkflowNode | null>(null);
  /** When set, the editor loads this quick run for editing. */
  readonly editTarget = input<QuickRun | null>(null);
  /** Resolved target QuickRun whether passed via dialog data or input property. */
  readonly targetQuickRun = computed(() => this.dialogData?.quickRun ?? this.editTarget());
  /** Resolved target WorkflowNode whether passed via dialog data or input property. */
  readonly targetNode = computed(() => this.dialogData?.workflowNode ?? this.workflowNode());
  /** True when editing a WorkflowNode instead of a standalone QuickRun. */
  readonly isWorkflowMode = computed(() => !!this.targetNode());
  /** Emitted when the user cancels or after a successful save. */
  readonly closed = output<void>();

  // ── Form ──────────────────────────────────────────────────────────────────

  readonly runtimeRemoteFields = signal<RcConfigOption[]>([]);
  private readonly metadata = new ConfigResourceState(this.destroyRef, error =>
    this.notificationService.showError(error)
  );
  readonly isLoadingRuntimeRemoteFields = computed(() => this.metadata.isLoading('runtimeRemote'));
  readonly runtimeRemoteForm = signal<FormGroup>(
    this.fb.group({
      type: [''],
    })
  );
  readonly mountTypes = this.flagConfigService.mountTypes;
  readonly availableServeTypes = this.flagConfigService.availableServeTypes;
  readonly selectedServeType = signal('http');
  readonly dynamicServeFields = signal<RcConfigOption[]>([]);
  readonly isLoadingServeFields = computed(() => this.metadata.isLoading('serve'));
  private seedRcloneConfig?: Record<string, unknown>;
  private fieldsReady: Promise<void> = Promise.resolve();
  private seedRemoteName = '';
  private readonly runtimeDrafts = new Map<
    string,
    { type: string; fields: RcConfigOption[]; form: FormGroup }
  >();
  readonly runtimeRemoteIdentity = signal('');
  readonly flagLoadFailed = computed(
    () => this.metadata.hasFailed('flags') || this.metadata.hasFailed('serve')
  );
  readonly runtimeLoadFailed = computed(() => this.metadata.hasFailed('runtimeRemote'));
  private readonly isSubmitting = signal(false);

  // ── UI state ──────────────────────────────────────────────────────────────

  readonly isSaving = computed(
    () => this.isSubmitting() || (!this.isWorkflowMode() && this.quickRunService.isSaving())
  );
  readonly tools = new ConfigEditorTools();
  readonly showSearch = this.tools.searchVisible;
  readonly showCliImport = this.tools.cliImportVisible;
  readonly showObscureTool = this.tools.obscureVisible;
  readonly activeTab = signal<FlagType | 'runtimeRemote'>('sync');
  readonly isSidebarOpen = signal(true);
  readonly sidebarMode = signal<MatDrawerMode>('side');
  readonly isLoadingFlags = computed(() => this.metadata.isLoading('flags'));
  readonly searchQuery = this.tools.searchQuery;
  readonly currentOpType = signal<PrimaryActionType>('sync');
  readonly currentRemoteName = signal<string>('');

  readonly activeSensitiveFields = computed(() => {
    const tab = this.activeTab();
    const fields: RcConfigOption[] =
      tab === 'runtimeRemote' ? this.runtimeRemoteFields() : this.getFlagFields(tab);

    return this.valueMapper.extractSensitiveFields(fields);
  });

  readonly remotes = computed(() => this.remoteFacade.remoteSummaries());
  readonly existingRemoteNames = computed(() => this.remotes().map(r => r.name));

  /**
   * Top-level form built with static sub-groups for all flag types, matching
   * `RemoteConfigStateService.createRemoteConfigForm()` structure.
   */
  readonly form: FormGroup = this.createForm();

  readonly selectedRemoteType = computed(() => {
    const rName = (this.currentRemoteName() || '').replace(/:+$/, '').trim();
    if (!rName) return '';
    const match = this.remotes().find(r => r.name.replace(/:+$/, '').trim() === rName);
    return match?.type ?? '';
  });
  readonly operations: readonly OperationDefinition[] = OPERATION_REGISTRY.filter(
    op => op.isPrimary
  ) as readonly OperationDefinition[];

  /** Dynamic flag fields per FlagType (operation + vfs + filter + backend). */
  readonly dynamicFlagFields = signal<Record<string, RcConfigOption[]>>({});

  readonly highlightedFields = signal<Set<string>>(new Set());

  /**
   * Tab definitions. The operation tab is always shown; VFS/Filter/Backend
   * are "shared profile" tabs that any operation can optionally configure.
   */
  readonly flagTabs = computed<{ key: FlagType | 'runtimeRemote'; label: string; icon: string }[]>(
    () => {
      const op = this.currentOpType();
      const labels: Partial<Record<FlagType, string>> = {
        vfs: 'flow.quickRun.editor.tabVfs',
        filter: 'flow.quickRun.editor.tabFilter',
        backend: 'flow.quickRun.editor.tabBackend',
      };
      const tabs: { key: FlagType | 'runtimeRemote'; label: string; icon: string }[] =
        getConfigCategories(op).map(category => ({
          key: category as FlagType,
          label: labels[category as FlagType] ?? this.getOperationLabel(category),
          icon: PROFILE_ICONS[category as FlagType],
        }));
      tabs.push({
        key: 'runtimeRemote',
        label: 'flow.quickRun.editor.tabRuntimeRemote',
        icon: 'gear',
      });

      return tabs;
    }
  );

  constructor() {
    syncResponsiveSidebar(
      768,
      this.sidebarMode,
      this.isSidebarOpen,
      this.destroyRef,
      this.hostEl.nativeElement
    );

    effect(() => {
      const remote = this.currentRemoteName();
      const type = this.selectedRemoteType();
      untracked(() => {
        void this.loadRuntimeRemoteFields(type, remote);
      });
    });

    effect(onCleanup => {
      const form = this.runtimeRemoteForm();
      const sub = form.statusChanges.subscribe(() => this.formVersion.update(value => value + 1));
      onCleanup(() => sub.unsubscribe());
    });

    this.form.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.formVersion.update(v => v + 1));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    const node = this.targetNode();
    const target = this.targetQuickRun() ?? this.dialogData?.cloneData;
    const cfg = node?.config ?? {};
    const opType = node
      ? (node.type as PrimaryActionType)
      : (target?.operationType ?? this.dialogData?.initialOpType ?? 'sync');
    const remote = node
      ? String(cfg['remoteName'] ?? cfg['remote'] ?? this.dialogData?.initialRemoteName ?? '')
      : (target?.remoteName ?? this.dialogData?.initialRemoteName ?? '');
    this.form.patchValue(
      {
        name: node?.title ?? target?.name ?? '',
        description: node?.subtitle ?? target?.description ?? '',
        operationType: opType,
        remoteName: remote,
      },
      { emitEvent: false }
    );
    this.currentOpType.set(opType);
    this.activeTab.set(opType);
    this.currentRemoteName.set(remote);
    const seed = node
      ? ((cfg['config'] as QuickRunConfig | undefined) ?? (cfg as unknown as QuickRunConfig))
      : target?.config;
    this.populateFormFromSeed(seed);
    this.fieldsReady = this.loadAllFlagFields();

    this.form.controls['operationType'].valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value: PrimaryActionType) => {
        const previous = this.currentOpType();
        if (previous === value) return;
        this.currentOpType.set(value);
        if (
          this.activeTab() === previous ||
          !this.flagTabs().some(tab => tab.key === this.activeTab())
        )
          this.activeTab.set(value);
      });
    this.form.controls['remoteName'].valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((name: string) => {
        this.currentRemoteName.set(name ?? '');
      });
  }

  // ── Form creation ─────────────────────────────────────────────────────────

  private createForm(): FormGroup {
    return this.fb.group({
      name: ['', [Validators.required, Validators.pattern(/\S/)]],
      description: [''],
      operationType: ['sync' as PrimaryActionType, Validators.required],
      remoteName: ['', Validators.required],
      ...Object.fromEntries(
        FLAG_TYPES.map(type => [
          `${type}Config`,
          createConfigFormGroup(this.fb, type, this.destroyRef),
        ])
      ),
    });
  }

  getOpFormGroup(opType: string): FormGroup {
    const group = this.form.get(`${opType}Config`);
    if (!(group instanceof FormGroup)) throw new Error(`Unsupported operation: ${opType}`);
    return group;
  }

  private createOpConfigGroup(opType: PrimaryActionType, seed?: QuickRunConfig): FormGroup {
    const values = mapConfigToFormProfile(
      opType,
      seed ? { app: seed.app, rclone: seed.rclone } : {},
      {
        remoteName: this.currentRemoteName(),
        existingRemotes: this.existingRemoteNames(),
        pathService: this.pathService,
      }
    );
    return createConfigFormGroup(this.fb, opType, this.destroyRef, values);
  }

  private async loadRuntimeRemoteFields(
    type: string,
    remote = this.currentRemoteName()
  ): Promise<void> {
    this.runtimeRemoteIdentity.set('');
    if (!remote || !type) {
      this.metadata.clear('runtimeRemote');
      this.runtimeRemoteFields.set([]);
      this.runtimeRemoteForm.set(this.fb.group({ type: [''] }));
      return;
    }
    const draft = this.runtimeDrafts.get(remote);
    await this.metadata.load(
      'runtimeRemote',
      () =>
        draft?.type === type
          ? Promise.resolve(draft.fields)
          : this.remoteManagementService.getRemoteConfigFields(type),
      definitions => {
        const fields = definitions.map(field => ({ ...field, Required: false }));
        const group = draft?.type === type ? draft.form : this.fb.group({ type: [type] });
        if (draft?.type !== type) {
          const scoped = this.seedRcloneConfig?.['remotes'] as
            Record<string, Record<string, unknown>> | undefined;
          const legacy = this.seedRcloneConfig?.['runtimeRemote'] as
            Record<string, unknown> | undefined;
          const legacyScoped = legacy?.[remote];
          const seed =
            scoped?.[remote] ??
            (legacyScoped && typeof legacyScoped === 'object'
              ? (legacyScoped as Record<string, unknown>)
              : remote === this.seedRemoteName
                ? legacy
                : undefined);
          reconcileDynamicControls(group, fields, { required: false });
          if (seed) patchConfigOptions(group, seed);
        }
        this.runtimeDrafts.set(remote, { type, fields, form: group });
        this.runtimeRemoteFields.set(fields);
        this.runtimeRemoteForm.set(group);
        this.runtimeRemoteIdentity.set(remote);
      }
    );
  }

  private populateFormFromSeed(seed?: QuickRunConfig): void {
    if (!seed || !seed.rclone) return;
    const rawRclone = seed.rclone as Record<string, unknown>;
    this.seedRcloneConfig = rawRclone;
    this.seedRemoteName = this.currentRemoteName();
    this.runtimeDrafts.clear();
    const opType = this.currentOpType();

    const opGroup = this.createOpConfigGroup(opType, seed);
    this.form.setControl(`${opType}Config`, opGroup);

    if (opType === 'serve') {
      const serveType =
        (opGroup.get('options.type')?.value as string) ||
        (rawRclone['type'] as string) ||
        ((rawRclone['serve'] as Record<string, unknown> | undefined)?.['type'] as string) ||
        'http';
      this.selectedServeType.set(serveType);
    }

    for (const shared of ['vfs', 'filter', 'backend'] as const) {
      const sharedObj = rawRclone[shared] as Record<string, unknown> | undefined;
      if (!sharedObj || typeof sharedObj !== 'object') continue;
      const optsGroup = this.form.get(`${shared}Config.options`) as FormGroup | null;
      if (!optsGroup) continue;

      patchConfigOptions(optsGroup, sharedObj);
    }
  }

  private async loadServeFields(): Promise<void> {
    const type = this.selectedServeType() || 'http';
    await this.metadata.load(
      'serve',
      () => this.flagConfigService.loadServeFlagFields(type),
      fields => {
        this.dynamicServeFields.set(fields);
        this.rebuildServeOptionsGroup();
      }
    );
  }

  async onServeTypeChange(type: string): Promise<void> {
    const normalized = type || 'http';
    if (this.selectedServeType() === normalized) return;
    this.selectedServeType.set(normalized);
    this.form.get('serveConfig.options.type')?.setValue(normalized, { emitEvent: false });
    await this.loadServeFields();
  }

  rebuildServeOptionsGroup(): void {
    reconcileDynamicControls(
      this.getOpFormGroup('serve').get('options') as FormGroup,
      this.dynamicServeFields(),
      {
        preserveKeys: new Set(['type']),
        prune: true,
      }
    );
  }

  private async loadAllFlagFields(): Promise<void> {
    const operation = this.currentOpType();
    const types = this.applicableCategories().filter(
      (type): type is FlagType => type !== 'remote' && type !== 'serve'
    );
    if (operation !== 'serve') this.metadata.clear('serve');
    await Promise.all([
      this.metadata.load(
        'flags',
        () => this.flagConfigService.loadConfigFields(types),
        fields => {
          for (const [type, definitions] of Object.entries(fields)) {
            if (this.dynamicFlagFields()[type] === definitions) continue;
            reconcileDynamicControls(
              this.getOpFormGroup(type).get('options') as FormGroup,
              definitions
            );
          }
          this.dynamicFlagFields.update(current => ({ ...current, ...fields }));
        }
      ),
      operation === 'serve' ? this.loadServeFields() : Promise.resolve(),
    ]);
  }

  async retryLoading(): Promise<void> {
    this.fieldsReady = this.metadata.retryFailed();
    await this.fieldsReady;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  toggleSidebar(): void {
    this.isSidebarOpen.update(v => !v);
  }

  selectTab(tabKey: FlagType | 'runtimeRemote'): void {
    this.activeTab.set(tabKey);
    if (this.sidebarMode() === 'over') {
      this.isSidebarOpen.set(false);
    }
  }

  selectOperation(opKey: PrimaryActionType | string): void {
    const newOp = opKey as PrimaryActionType;
    const prevOp = this.currentOpType();
    if (prevOp === newOp) return;

    this.form.get('operationType')?.setValue(newOp);
    this.fieldsReady = this.loadAllFlagFields();
  }

  close(): void {
    this.closed.emit();
    this.dialogRef?.close();
  }

  readonly isActiveTabInvalid = computed(() => {
    this.formVersion();
    const tab = this.activeTab();
    return tab === 'runtimeRemote'
      ? this.runtimeRemoteForm().invalid
      : this.getOpFormGroup(tab).invalid;
  });

  readonly isSubmitDisabled = computed(() => {
    this.formVersion();
    if (
      this.isSaving() ||
      this.isLoadingFlags() ||
      this.isLoadingServeFields() ||
      this.isLoadingRuntimeRemoteFields() ||
      this.flagLoadFailed() ||
      this.runtimeLoadFailed() ||
      !this.selectedRemoteType() ||
      this.runtimeRemoteIdentity() !== this.currentRemoteName()
    )
      return true;
    return (
      this.form.controls['name'].invalid ||
      this.form.controls['remoteName'].invalid ||
      this.applicableCategories().some(type => this.getOpFormGroup(type).invalid) ||
      [...this.runtimeDrafts.values()].some(draft => draft.form.invalid)
    );
  });

  async submit(): Promise<void> {
    if (this.isSubmitDisabled()) {
      this.form.markAllAsTouched();
      this.runtimeRemoteForm().markAllAsTouched();
      return;
    }
    this.isSubmitting.set(true);
    try {
      const input = this.buildInput();
      this.form.disable({ emitEvent: false });
      this.runtimeRemoteForm().disable({ emitEvent: false });
      await this.pathInspectionService.createRequiredDirectoriesForOperation(
        input.operationType,
        input.config.rclone as Record<string, unknown>
      );
      const node = this.targetNode();
      if (this.isWorkflowMode() && node) {
        this.workflowStateService.updateNode(node.id, {
          title: input.name,
          subtitle: input.description,
          config: { remoteName: input.remoteName, config: input.config },
        });
        this.notificationService.showSuccess(
          this.translate.instant('flow.workflow.editor.nodeSaved')
        );
      } else if (!(await this.quickRunService.save(input))) return;
      this.closed.emit();
      this.dialogRef?.close(true);
    } catch (error) {
      this.notificationService.showError(error);
    } finally {
      this.isSubmitting.set(false);
      if (!this.destroyRef.destroyed) {
        this.form.enable();
        this.runtimeRemoteForm().enable();
      }
    }
  }

  toggleSearch(): void {
    this.tools.toggle('search');
    this.closeSidebarIfOver();
  }

  toggleCliImport(): void {
    this.tools.toggle('cliImport');
    this.closeSidebarIfOver();
  }

  toggleObscureTool(): void {
    this.tools.toggle('obscure');
    this.closeSidebarIfOver();
  }

  private closeSidebarIfOver(): void {
    if (this.sidebarMode() === 'over') this.isSidebarOpen.set(false);
  }

  applyObscuredValue(key: string, value: string): void {
    const tab = this.activeTab();
    if (tab === 'runtimeRemote') {
      const ctrl = this.runtimeRemoteForm().get(key);
      if (ctrl) {
        ctrl.setValue(value);
        ctrl.markAsDirty();
        ctrl.markAsTouched();
      }
    } else {
      const groupKey = `${tab}Config`;
      const configGroup = this.form.get(groupKey) as FormGroup | null;
      const optsGroup = configGroup?.get('options') as FormGroup | null;
      const ctrl = optsGroup?.get(key);
      if (ctrl) {
        ctrl.setValue(value);
        ctrl.markAsDirty();
        ctrl.markAsTouched();
      }
    }
  }

  async onCliImportApply(event: {
    result: ImportResult;
    importSourcePath: boolean;
    importDestPath: boolean;
  }): Promise<void> {
    const { result, importSourcePath, importDestPath } = event;
    if (result.verb && ALL_PRIMARY_ACTIONS.includes(result.verb as PrimaryActionType))
      this.selectOperation(result.verb);
    const op = this.currentOpType();
    await this.fieldsReady;
    if (this.flagLoadFailed() || this.currentOpType() !== op) return;
    const group = this.getOpFormGroup(op);
    const existing = mapFormToConfigProfile(op, group.getRawValue(), {
      remoteName: this.currentRemoteName(),
      pathService: this.pathService,
    });
    const merged = mergeImportedProfile(
      op,
      existing,
      result,
      importSourcePath,
      importDestPath,
      this.currentRemoteName()
    );
    await this.applyOperationConfig(op, merged);
    for (const type of this.applicableCategories()) {
      if (type === op) continue;
      patchConfigOptions(
        this.getOpFormGroup(type).get('options') as FormGroup,
        mergeImportedFlags({}, result, type as FlagType),
        this.getFlagFields(type)
      );
    }
    if (this.runtimeRemoteIdentity() === this.currentRemoteName()) {
      patchConfigOptions(this.runtimeRemoteForm(), mergeImportedFlags({}, result, 'runtimeRemote'));
    }
    const imported = result.classified.flatMap(flag =>
      flag.status === 'mapped' && flag.fieldName ? [flag.fieldName] : []
    );
    this.highlightedFields.set(new Set(imported));
    this.tools.close();
    this.notificationService.showSuccess(
      this.translate.instant('wizards.cliImport.appliedToast', { count: imported.length })
    );
  }

  private async applyOperationConfig(
    type: PrimaryActionType,
    config: Record<string, unknown>
  ): Promise<void> {
    const values = mapConfigToFormProfile(type, config, {
      remoteName: this.currentRemoteName(),
      existingRemotes: this.existingRemoteNames(),
      pathService: this.pathService,
    });
    if (type === 'serve') {
      await this.onServeTypeChange(
        String((values['options'] as Record<string, unknown>)['type'] ?? 'http')
      );
      if (this.flagLoadFailed()) return;
    }
    const group = this.getOpFormGroup(type);
    patchConfigPaths(group, values);
    patchConfigOptions(
      group.get('options') as FormGroup,
      values['options'] as Record<string, unknown>,
      this.getFlagFields(type)
    );
    group.markAsDirty();
  }

  /**
   * Build a {@link QuickRunInput} from the current form state.
   */
  private buildInput(): QuickRunInput {
    const opType = this.currentOpType();
    const remoteName = this.currentRemoteName();
    const name = (this.form.get('name')?.value as string).trim();
    const description = (this.form.get('description')?.value as string)?.trim() || undefined;
    const inner = this.getOpFormGroup(opType);

    const rawValue = inner.getRawValue() as Record<string, unknown>;

    const fields = this.dynamicFlagFields();
    const mapped = mapFormToConfigProfile(opType, rawValue, {
      remoteName,
      pathService: this.pathService,
      cleanData: (options, definitions) => this.valueMapper.cleanData(options, definitions),
      dynamicFields: this.getFlagFields(opType),
    });
    const app = mapped['app'] as AppConfig;
    const rclone = mapped['rclone'] as Record<string, unknown>;

    const sharedTypes = this.applicableCategories().filter(
      (type): type is FlagType => type !== 'remote' && type !== opType
    );

    for (const flagType of sharedTypes) {
      const groupKey = `${flagType}Config`;
      const configGroup = this.form.get(groupKey) as FormGroup | null;
      if (!configGroup) continue;

      const optsGroup = configGroup.get('options') as FormGroup | null;
      if (!optsGroup) continue;

      const optsValue = optsGroup.getRawValue() as Record<string, unknown>;
      const typeFields = fields[flagType as FlagType] ?? [];
      const cleaned = this.valueMapper.cleanData(optsValue, typeFields);
      if (Object.keys(cleaned).length > 0) {
        rclone[flagType] = cleaned;
      }
    }

    const remotes = {
      ...((this.seedRcloneConfig?.['remotes'] as Record<string, unknown> | undefined) ?? {}),
    };
    const currentRaw = this.runtimeRemoteForm().getRawValue() as Record<string, unknown>;
    delete currentRaw['type'];
    const currentCleaned = this.valueMapper.cleanData(currentRaw, this.runtimeRemoteFields());
    if (Object.keys(currentCleaned).length) remotes[remoteName] = currentCleaned;
    else delete remotes[remoteName];
    for (const [name, draft] of this.runtimeDrafts) {
      const raw = draft.form.getRawValue() as Record<string, unknown>;
      delete raw['type'];
      const cleaned = this.valueMapper.cleanData(raw, draft.fields);
      if (Object.keys(cleaned).length) remotes[name] = cleaned;
      else delete remotes[name];
    }
    if (Object.keys(remotes).length) rclone['remotes'] = remotes;

    return {
      id: this.targetQuickRun()?.id,
      name,
      description,
      operationType: opType,
      remoteName,
      config: { app, rclone },
    };
  }

  // ── Template helpers ─────────────────────────────────────────────────────

  getOperationLabel(opKey: string): string {
    const def = this.operations.find(o => o.key === opKey);
    return def?.typeLabel ?? def?.actionLabel ?? opKey;
  }

  getFlagFields(type: FlagType | string): RcConfigOption[] {
    if (type === 'serve') {
      return this.dynamicServeFields();
    }
    return this.dynamicFlagFields()[type] ?? [];
  }

  private readonly formVersion = signal(0);

  readonly applicableCategories = computed(() => getConfigCategories(this.currentOpType()));

  readonly currentValues = (): Partial<Record<TemplateCategory, Record<string, unknown>>> => {
    const fields = this.dynamicFlagFields();
    const applicable = new Set(this.applicableCategories());

    const getCleanOptions = (flagType: string): Record<string, unknown> => {
      const opts = this.getOpFormGroup(flagType).get('options')?.getRawValue() ?? {};
      const typeFields =
        flagType === 'serve' ? this.dynamicServeFields() : (fields[flagType as FlagType] ?? []);
      return this.valueMapper.cleanData(opts, typeFields);
    };

    const res: Partial<Record<TemplateCategory, Record<string, unknown>>> = {};
    for (const cat of applicable) {
      res[cat] = getCleanOptions(cat);
    }

    return res;
  };

  async onApplyTemplate(event: ApplyTemplateEvent): Promise<void> {
    const operation = this.currentOpType();
    await this.fieldsReady;
    if (this.flagLoadFailed() || operation !== this.currentOpType()) return;
    for (const category of this.applicableCategories()) {
      const values = event.values[category];
      if (!values) continue;
      const group = this.getOpFormGroup(category);
      if (category === operation) {
        const current = mapFormToConfigProfile(operation, group.getRawValue(), {
          remoteName: this.currentRemoteName(),
          pathService: this.pathService,
        });
        await this.applyOperationConfig(operation, {
          ...current,
          rclone: { ...(current['rclone'] as Record<string, unknown>), ...values },
        });
      } else {
        patchConfigOptions(group.get('options') as FormGroup, values, this.getFlagFields(category));
        group.markAsDirty();
      }
    }
    if (!this.flagLoadFailed())
      this.notificationService.showSuccess(
        this.translate.instant('templates.applySuccess', { name: event.sourceName })
      );
  }
}
