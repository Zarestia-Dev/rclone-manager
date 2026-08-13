import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  afterNextRender,
  OnInit,
} from '@angular/core';
import {
  FormBuilder,
  FormGroup,
  FormArray,
  FormControl,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDividerModule } from '@angular/material/divider';
import { MatTabsModule } from '@angular/material/tabs';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSidenavModule, MatDrawerMode } from '@angular/material/sidenav';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  AppConfig,
  FlagType,
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
} from '@app/types';
import { OperationConfigComponent } from 'src/app/shared/remote-config/app-operation-config/app-operation-config.component';
import { FlagConfigStepComponent } from 'src/app/shared/remote-config/flag-config-step/flag-config-step.component';
import { RemoteConfigStepComponent } from 'src/app/shared/remote-config/remote-config-step/remote-config-step.component';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { SearchContainerComponent } from 'src/app/shared/components/search-container/search-container.component';
import { CliImportComponent } from 'src/app/shared/remote-config/cli-import/cli-import.component';
import { ObscureToolComponent } from 'src/app/shared/remote-config/obscure-tool/obscure-tool.component';
import {
  PresetTemplateBarComponent,
  ApplyTemplateEvent,
} from 'src/app/shared/remote-config/preset-template-bar/preset-template-bar.component';
import { FlagConfigService } from 'src/app/services/remote/flag-config.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { RemotePresetsService } from 'src/app/services/remote/remote-presets';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService, DefaultPathOp } from 'src/app/services/infrastructure/platform/path.service';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import { EscapeCloseDirective } from 'src/app/shared/directives/escape-close.directive';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

const ALL_FLAG_TYPES = [
  'sync',
  'copy',
  'move',
  'bisync',
  'mount',
  'serve',
  'check',
  'delete',
  'copyurl',
  'vfs',
  'filter',
  'backend',
] as const;

/**
 * Inline editor panel for the Flow workspace's Quick Run feature.
 */
@Component({
  selector: 'app-quick-run-editor',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    ReactiveFormsModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatDividerModule,
    MatTabsModule,
    MatListModule,
    MatProgressBarModule,
    MatSidenavModule,
    CdkMenuModule,
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
  private readonly quickRunService = inject(QuickRunService);
  private readonly flagConfigService = inject(FlagConfigService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly remotePresetsService = inject(RemotePresetsService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly pathService = inject(PathService);
  private readonly valueMapper = inject(RcloneValueMapperService);
  readonly iconService = inject(IconService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogRef = inject(MatDialogRef<QuickRunEditorComponent>, { optional: true });
  private readonly dialogData = inject<{ quickRun?: QuickRun }>(MAT_DIALOG_DATA, {
    optional: true,
  });

  /** When set, the editor loads this quick run for editing. */
  readonly editTarget = input<QuickRun | null>(null);
  /** Resolved target QuickRun whether passed via dialog data or input property. */
  readonly targetQuickRun = computed(() => this.dialogData?.quickRun ?? this.editTarget());
  /** Emitted when the user cancels or after a successful save. */
  readonly closed = output<void>();

  // ── Form ──────────────────────────────────────────────────────────────────

  /**
   * Top-level form built with static sub-groups for all flag types, matching
   * `RemoteConfigStateService.createRemoteConfigForm()` structure.
   */
  readonly form: FormGroup = this.createForm();

  readonly runtimeRemoteFields = signal<RcConfigOption[]>([]);
  readonly isLoadingRuntimeRemoteFields = signal(false);
  readonly runtimeRemoteForm = signal<FormGroup>(
    this.fb.group({
      type: [''],
    })
  );
  private seedRcloneConfig?: Record<string, unknown>;
  private destPathGeneration = 0;

  // ── UI state ──────────────────────────────────────────────────────────────

  readonly isSaving = this.quickRunService.isSaving;
  readonly showSearch = signal(false);
  readonly showCliImport = signal(false);
  readonly showObscureTool = signal(false);
  readonly activeTab = signal<FlagType | 'runtimeRemote'>('sync');
  readonly isSidebarOpen = signal(true);
  readonly sidebarMode = signal<MatDrawerMode>('side');
  readonly isLoadingFlags = signal(false);
  readonly searchQuery = signal('');
  readonly currentOpType = signal<PrimaryActionType>('sync');
  readonly currentRemoteName = signal<string>('');

  readonly activeSensitiveFields = computed(() => {
    const tab = this.activeTab();
    const fields: RcConfigOption[] =
      tab === 'runtimeRemote' ? this.runtimeRemoteFields() : this.getFlagFields(tab);

    return this.valueMapper.extractSensitiveFields(fields);
  });

  readonly remotes = computed(() => this.remoteFacade.orderedVisibleRemotes());
  readonly existingRemoteNames = computed(() => this.remotes().map(r => r.name));
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

  readonly existingProfiles = signal<Record<string, string[]>>({});

  /**
   * Tab definitions. The operation tab is always shown; VFS/Filter/Backend
   * are "shared profile" tabs that any operation can optionally configure.
   */
  readonly flagTabs = computed<{ key: FlagType | 'runtimeRemote'; label: string; icon: string }[]>(
    () => {
      const op = this.currentOpType() as FlagType;
      const tabs: { key: FlagType | 'runtimeRemote'; label: string; icon: string }[] = [
        { key: op, label: this.getOperationLabel(op), icon: PROFILE_ICONS[op] ?? 'operations' },
      ];

      if (op === 'mount' || op === 'serve') {
        tabs.push({
          key: 'vfs',
          label: 'flow.quickRun.editor.tabVfs',
          icon: PROFILE_ICONS['vfs'] ?? 'vfs',
        });
      }

      tabs.push(
        {
          key: 'filter',
          label: 'flow.quickRun.editor.tabFilter',
          icon: PROFILE_ICONS['filter'] ?? 'filter',
        },
        {
          key: 'backend',
          label: 'flow.quickRun.editor.tabBackend',
          icon: PROFILE_ICONS['backend'] ?? 'database',
        },
        {
          key: 'runtimeRemote',
          label: 'flow.quickRun.editor.tabRuntimeRemote',
          icon: PROFILE_ICONS['runtimeRemote'] ?? 'gear',
        }
      );

      return tabs;
    }
  );

  constructor() {
    afterNextRender(() => this.setupResponsiveLayout());

    effect(() => {
      const all = this.flagConfigService.allFlagFields();
      if (all) {
        this.dynamicFlagFields.set(all as Record<string, RcConfigOption[]>);
        untracked(() => this.syncAllDynamicControls());
      }
    });

    effect(() => {
      const type = this.selectedRemoteType();
      if (!type) {
        this.runtimeRemoteFields.set([]);
        this.runtimeRemoteForm.set(this.fb.group({ type: [''] }));
      } else {
        untracked(() => {
          void this.loadRuntimeRemoteFields(type);
        });
      }
    });

    this.form.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.formVersion.update(v => v + 1));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    const target = this.targetQuickRun();
    const initOp = (this.dialogData as { initialOpType?: PrimaryActionType } | null)?.initialOpType;
    if (target) {
      this.form.patchValue({
        name: target.name,
        description: target.description ?? '',
        operationType: target.operationType,
        remoteName: target.remoteName,
      });
      this.currentOpType.set(target.operationType);
      this.activeTab.set(target.operationType as FlagType);
      this.currentRemoteName.set(target.remoteName);
      this.populateFormFromSeed(target.config);
    } else if (initOp) {
      this.selectOperation(initOp);
    }

    void this.loadAllFlagFields();

    const opCtrl = this.form.get('operationType');
    if (opCtrl) {
      opCtrl.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((op: unknown) => {
        const opType = op as PrimaryActionType;
        const prevOp = this.currentOpType();
        this.currentOpType.set(opType);
        if (prevOp !== opType) {
          this.rebuildOpConfigGroup(prevOp, opType);
        }
        this.syncAllDynamicControls();
        this.checkAndSetDefaultDestPath();
        if (this.activeTab() === (prevOp as FlagType)) {
          this.activeTab.set(opType as FlagType);
        }
      });
    }

    const remoteCtrl = this.form.get('remoteName');
    if (remoteCtrl) {
      remoteCtrl.valueChanges
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((name: unknown) => {
          const rName = (name as string) ?? '';
          this.currentRemoteName.set(rName);
          this.checkAndSetDefaultDestPath();
        });
    }
  }

  // ── Form creation ─────────────────────────────────────────────────────────

  private createForm(): FormGroup {
    const configControls: Record<string, FormGroup> = {};
    for (const flag of ALL_FLAG_TYPES) {
      const isShared = flag === 'vfs' || flag === 'filter' || flag === 'backend';
      configControls[`${flag}Config`] = isShared
        ? this.createSharedConfigGroup()
        : this.createOpConfigGroup(flag as PrimaryActionType);
    }

    return this.fb.group({
      name: ['', [Validators.required, Validators.minLength(1)]],
      description: [''],
      operationType: ['sync' as PrimaryActionType, Validators.required],
      remoteName: ['', Validators.required],
      ...configControls,
    });
  }

  getOpFormGroup(opType: string): FormGroup {
    return (this.form.get(`${opType}Config`) as FormGroup) ?? this.fb.group({});
  }

  private rebuildOpConfigGroup(prevOp: PrimaryActionType, newOp: PrimaryActionType): void {
    const prevGroup = this.form.get(`${prevOp}Config`) as FormGroup | null;
    const prevRaw = prevGroup?.getRawValue() as Record<string, unknown> | undefined;

    // Build a seed from the shared app-config fields so they carry over.
    const seed: QuickRunConfig | undefined = prevRaw
      ? {
          app: {
            autoStart: !!prevRaw['autoStart'],
            cronEnabled: !!prevRaw['cronEnabled'],
            cronExpression: (prevRaw['cronExpression'] as string | null) ?? null,
            watchEnabled: !!prevRaw['watchEnabled'],
            watchDelay: (prevRaw['watchDelay'] as number) ?? 5,
            vfsProfile: (prevRaw['vfsProfile'] as string) ?? 'Default',
            filterProfile: (prevRaw['filterProfile'] as string) ?? 'Default',
            backendProfile: (prevRaw['backendProfile'] as string) ?? 'Default',
          },
          rclone: {},
        }
      : undefined;

    const newGroup = this.createOpConfigGroup(newOp, seed);
    this.form.setControl(`${newOp}Config`, newGroup);
  }

  private createSharedConfigGroup(): FormGroup {
    return this.fb.group({
      options: this.fb.group({}),
    });
  }

  private createOpConfigGroup(opType: PrimaryActionType, seed?: QuickRunConfig): FormGroup {
    const app = seed?.app;
    const rclone = seed?.rclone as Record<string, unknown> | undefined;

    const isSingleSource =
      opType === 'mount' || opType === 'serve' || opType === 'bisync' || opType === 'archivecreate';
    const seedSourcePath = this.extractSourcePath(rclone);
    const seedDestPath = this.extractDestPath(rclone);

    const source = isSingleSource
      ? this.createPathGroup(seedSourcePath)
      : this.fb.array([this.createPathGroup(seedSourcePath)]);

    const hasDest = opType !== 'serve' && opType !== 'delete';
    const dest = hasDest ? this.createDestGroup(seedDestPath) : null;

    const optionsGroup = this.fb.group({});
    if (rclone && typeof rclone === 'object') {
      for (const [k, v] of Object.entries(rclone)) {
        if (['srcFs', 'dstFs', 'path1', 'path2', 'fs', 'mountPoint'].includes(k)) continue;
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) continue;
        optionsGroup.addControl(k, new FormControl(v));
      }
      const opSubObj = rclone[opType] as Record<string, unknown> | undefined;
      if (opSubObj && typeof opSubObj === 'object') {
        for (const [k, v] of Object.entries(opSubObj)) {
          if (['srcFs', 'dstFs', 'path1', 'path2', 'fs', 'mountPoint'].includes(k)) continue;
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) continue;
          if (!optionsGroup.contains(k)) {
            optionsGroup.addControl(k, new FormControl(v));
          }
        }
      }
    }

    const group: Record<string, unknown> = {
      autoStart: [app?.autoStart ?? false],
      cronEnabled: [app?.cronEnabled ?? false],
      cronExpression: [app?.cronExpression ?? null],
      watchEnabled: [app?.watchEnabled ?? false],
      watchDelay: [app?.watchDelay ?? 5],
      source,
      vfsProfile: ['Default'],
      filterProfile: ['Default'],
      backendProfile: ['Default'],
      options: optionsGroup,
    };
    if (dest) group['dest'] = dest;

    return this.fb.group(group);
  }

  private async loadRuntimeRemoteFields(type: string): Promise<void> {
    this.isLoadingRuntimeRemoteFields.set(true);
    try {
      const fields = await this.remoteManagementService.getRemoteConfigFields(type);
      this.runtimeRemoteFields.set(fields);

      const group: FormGroup = this.fb.group({
        type: [type],
      });
      const runtimeSeed =
        (this.seedRcloneConfig?.['runtimeRemote'] as Record<string, unknown> | undefined) ??
        this.seedRcloneConfig;
      for (const f of fields) {
        const key = f.Name || f.FieldName;
        if (!key || key === 'type') continue;
        const seedVal = runtimeSeed?.[key];
        const val = seedVal !== undefined ? seedVal : (f.Value ?? f.Default ?? null);
        group.addControl(key, new FormControl(val, f.Required ? [Validators.required] : []));
      }
      this.runtimeRemoteForm.set(group);
    } catch (err) {
      console.warn('[QuickRunEditor] loadRuntimeRemoteFields failed:', err);
    } finally {
      this.isLoadingRuntimeRemoteFields.set(false);
    }
  }

  private populateFormFromSeed(seed?: QuickRunConfig): void {
    if (!seed || !seed.rclone) return;
    const rawRclone = seed.rclone as Record<string, unknown>;
    this.seedRcloneConfig = rawRclone;
    const opType = this.currentOpType();

    const opGroup = this.createOpConfigGroup(opType, seed);
    this.form.setControl(`${opType}Config`, opGroup);

    for (const shared of ['vfs', 'filter', 'backend'] as const) {
      const sharedObj = rawRclone[shared] as Record<string, unknown> | undefined;
      if (!sharedObj || typeof sharedObj !== 'object') continue;
      const optsGroup = this.form.get(`${shared}Config.options`) as FormGroup | null;
      if (!optsGroup) continue;

      for (const [k, v] of Object.entries(sharedObj)) {
        if (!optsGroup.contains(k)) {
          optsGroup.addControl(k, new FormControl(v));
        } else {
          optsGroup.get(k)?.setValue(v);
        }
      }
    }
  }

  private createPathGroup(initialPath?: string): FormGroup {
    let type = 'currentRemote';
    let path = initialPath ?? '';
    let remote = '';

    if (path) {
      if (path.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(path)) {
        type = 'local';
      } else if (path.includes(':')) {
        const colonIdx = path.indexOf(':');
        const rName = path.slice(0, colonIdx);
        const relPath = path.slice(colonIdx + 1);
        const curRemote = (this.currentRemoteName() || '').replace(/:+$/, '');
        if (rName === curRemote) {
          type = 'currentRemote';
          path = relPath;
        } else {
          type = `otherRemote:${rName}`;
          path = relPath;
          remote = rName;
        }
      }
    }

    return this.fb.group({
      type: [type],
      path: [path],
      remote: [remote],
      filename: [''],
    });
  }

  private createDestGroup(initialPath: string | undefined): FormGroup {
    let type = 'local';
    let path = initialPath ?? '';
    let remote = '';

    if (path) {
      if (path.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(path)) {
        type = 'local';
      } else if (path.includes(':')) {
        const colonIdx = path.indexOf(':');
        const rName = path.slice(0, colonIdx);
        const relPath = path.slice(colonIdx + 1);
        const curRemote = (this.currentRemoteName() || '').replace(/:+$/, '');
        if (rName === curRemote) {
          type = 'currentRemote';
          path = relPath;
        } else {
          type = `otherRemote:${rName}`;
          path = relPath;
          remote = rName;
        }
      }
    }

    return this.fb.group({
      type: [type],
      path: [path],
      remote: [remote],
    });
  }

  private extractSourcePath(rclone?: Record<string, unknown>): string {
    if (!rclone) return '';
    const opType = this.currentOpType();
    const subObj = rclone[opType] as Record<string, unknown> | undefined;
    const src =
      rclone['srcFs'] ??
      rclone['path1'] ??
      rclone['fs'] ??
      rclone['source'] ??
      subObj?.['srcFs'] ??
      subObj?.['path1'] ??
      subObj?.['fs'] ??
      subObj?.['source'];
    if (Array.isArray(src)) {
      return src[0] != null ? String(src[0]) : '';
    }
    return src != null ? String(src) : '';
  }

  private extractDestPath(rclone?: Record<string, unknown>): string {
    if (!rclone) return '';
    const opType = this.currentOpType();
    const subObj = rclone[opType] as Record<string, unknown> | undefined;
    const dst =
      rclone['mountPoint'] ??
      rclone['dstFs'] ??
      rclone['path2'] ??
      rclone['dest'] ??
      subObj?.['mountPoint'] ??
      subObj?.['dstFs'] ??
      subObj?.['path2'] ??
      subObj?.['dest'];
    if (Array.isArray(dst)) {
      return dst[0] != null ? String(dst[0]) : '';
    }
    return dst != null ? String(dst) : '';
  }

  private async loadAllFlagFields(): Promise<void> {
    this.isLoadingFlags.set(true);
    try {
      let all = this.flagConfigService.allFlagFields();
      if (!all) {
        await this.flagConfigService.loadAllFlagFields();
        all = this.flagConfigService.allFlagFields();
      }
      if (all) {
        this.dynamicFlagFields.set(all as Record<string, RcConfigOption[]>);
        this.syncAllDynamicControls();
      }
    } catch (err) {
      console.warn('[QuickRunEditor] loadAllFlagFields failed:', err);
    } finally {
      this.isLoadingFlags.set(false);
    }
  }

  /**
   * Sync dynamic flag controls into the `options` FormGroup of EVERY flag
   * type (operation + vfs + filter + backend). This is the equivalent of
   * `RemoteConfigStateService.addDynamicFieldsToForm()`.
   */
  private syncAllDynamicControls(): void {
    const fields = this.dynamicFlagFields();
    if (!fields) return;

    for (const type of ALL_FLAG_TYPES) {
      const configKey = `${type}Config`;
      const configGroup = this.form.get(configKey) as FormGroup | null;
      if (!configGroup) continue;
      const optionsGroup = configGroup.get('options') as FormGroup | null;
      if (!optionsGroup) continue;
      const typeFields = fields[type] ?? [];
      this.syncDynamicControls(optionsGroup, typeFields);
    }
  }

  /**
   * Add FormControl instances for each field that doesn't already exist on
   * the group. Existing controls are preserved.
   */
  private syncDynamicControls(group: FormGroup, fields: RcConfigOption[]): void {
    for (const f of fields) {
      const key = f.Name || f.FieldName;
      if (!key || group.contains(key)) continue;
      group.addControl(
        key,
        new FormControl(f.Value ?? f.Default ?? null, f.Required ? [Validators.required] : [])
      );
    }
  }

  private checkAndSetDefaultDestPath(): void {
    if (this.targetQuickRun()) return;
    const opType = this.currentOpType();
    const remoteName = this.currentRemoteName();
    if (!remoteName || (opType !== 'mount' && opType !== 'bisync')) return;

    const opKey = `${opType}Config`;
    const opGroup = this.form.get(opKey) as FormGroup | null;
    const destGroup = opGroup?.get('dest') as FormGroup | null;
    const pathCtrl = destGroup?.get('path');

    if (destGroup && pathCtrl && (!pathCtrl.value || pathCtrl.pristine)) {
      const gen = ++this.destPathGeneration;
      void this.pathService
        .resolveDefaultPath(remoteName, opType as DefaultPathOp)
        .then(defaultPath => {
          if (gen !== this.destPathGeneration) return;
          if (destGroup && pathCtrl && (!pathCtrl.value || pathCtrl.pristine)) {
            destGroup.patchValue({ type: 'local', path: defaultPath });
          }
        });
    }
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
  }

  close(): void {
    this.closed.emit();
    this.dialogRef?.close();
  }

  async submit(): Promise<void> {
    const opGroup = this.getOpFormGroup(this.currentOpType());
    if (this.form.get('name')?.invalid || this.form.get('remoteName')?.invalid || opGroup.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const input = this.buildInput();
    await this.quickRunService.save(input);
    this.closed.emit();
    this.dialogRef?.close(true);
  }

  toggleSearch(): void {
    this.showSearch.update(v => !v);
    if (!this.showSearch()) {
      this.searchQuery.set('');
    } else {
      this.showCliImport.set(false);
      this.showObscureTool.set(false);
    }
    if (this.sidebarMode() === 'over') {
      this.isSidebarOpen.set(false);
    }
  }

  toggleCliImport(): void {
    this.showCliImport.update(v => !v);
    if (this.showCliImport()) {
      this.showSearch.set(false);
      this.showObscureTool.set(false);
      if (this.sidebarMode() === 'over') this.isSidebarOpen.set(false);
    }
  }

  toggleObscureTool(): void {
    this.showObscureTool.update(v => !v);
    if (this.showObscureTool()) {
      this.showSearch.set(false);
      this.showCliImport.set(false);
      if (this.sidebarMode() === 'over') this.isSidebarOpen.set(false);
    }
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

  applyDefaultPresets(): void {
    const remoteType = this.selectedRemoteType();
    if (!remoteType) {
      const warningMsg = this.translate.instant('wizards.presets.noRemoteSelected');
      this.notificationService.showWarning(
        warningMsg !== 'wizards.presets.noRemoteSelected'
          ? warningMsg
          : 'Please select a remote first'
      );
      return;
    }

    const preset = this.remotePresetsService.resolvePresets(remoteType);

    this.patchGroupOptions('vfsConfig', preset.vfs);
    this.patchGroupOptions('backendConfig', preset.backend);

    const currentOp = this.currentOpType();
    if (currentOp === 'mount' && preset.mount) {
      this.patchGroupOptions('mountConfig', preset.mount);
    }

    if (preset.remote) {
      const rtGroup = this.runtimeRemoteForm();
      for (const [k, v] of Object.entries(preset.remote)) {
        if (rtGroup.contains(k)) {
          rtGroup.get(k)?.setValue(v);
        }
      }
    }

    const msg = this.translate.instant('wizards.presets.applied');
    this.notificationService.showSuccess(
      msg !== 'wizards.presets.applied' ? msg : 'Default presets applied successfully'
    );
  }

  onCliImportApply(event: {
    result: {
      verb?: string;
      sourcePath?: string;
      destPath?: string;
      classified: { status: string; flag: { key: string; value: unknown } }[];
    };
    importSourcePath: boolean;
    importDestPath: boolean;
  }): void {
    const { result, importSourcePath, importDestPath } = event;

    if (result.verb && result.verb !== this.currentOpType()) {
      if (ALL_PRIMARY_ACTIONS.includes(result.verb as PrimaryActionType)) {
        this.form.get('operationType')?.setValue(result.verb as PrimaryActionType);
      }
    }

    const innerGroup = this.getOpFormGroup(this.currentOpType());
    if (!innerGroup) return;

    if (importSourcePath && result.sourcePath) {
      const sourceCtrl = innerGroup.get('source');
      if (sourceCtrl instanceof FormArray) {
        const first = sourceCtrl.at(0) as FormGroup;
        first.get('path')?.setValue(result.sourcePath);
      } else if (sourceCtrl instanceof FormGroup) {
        sourceCtrl.get('path')?.setValue(result.sourcePath);
      }
    }

    if (importDestPath && result.destPath) {
      const destCtrl = innerGroup.get('dest') as FormGroup | null;
      destCtrl?.get('path')?.setValue(result.destPath);
    }

    const optionsGroup = innerGroup.get('options') as FormGroup | null;
    if (optionsGroup) {
      for (const cls of result.classified) {
        if (cls.status !== 'mapped') continue;
        const ctrl = optionsGroup.get(cls.flag.key) as FormControl | null;
        if (ctrl) ctrl.setValue(cls.flag.value);
      }
    }

    this.showCliImport.set(false);
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

    const app: AppConfig = {
      autoStart: !!rawValue['autoStart'],
      cronEnabled: !!rawValue['cronEnabled'],
      cronExpression: (rawValue['cronExpression'] as string | null) ?? null,
      watchEnabled: !!rawValue['watchEnabled'],
      watchDelay: (rawValue['watchDelay'] as number) ?? 5,
      vfsProfile: (rawValue['vfsProfile'] as string) ?? 'Default',
      filterProfile: (rawValue['filterProfile'] as string) ?? 'Default',
      backendProfile: (rawValue['backendProfile'] as string) ?? 'Default',
    };

    const opConfig: Record<string, unknown> = {};

    const sourceValue = rawValue['source'];
    if (sourceValue) {
      if (Array.isArray(sourceValue)) {
        const paths = (sourceValue as Record<string, unknown>[])
          .map(item => this.resolvePath(item, remoteName))
          .filter(Boolean);
        if (opType === 'bisync') opConfig['path1'] = paths[0] ?? '';
        else opConfig['srcFs'] = paths.length === 1 ? (paths[0] ?? '') : paths;
      } else if (typeof sourceValue === 'object') {
        const path = this.resolvePath(sourceValue as Record<string, unknown>, remoteName);
        if (opType === 'mount') opConfig['srcFs'] = path;
        else if (opType === 'serve') opConfig['fs'] = path;
        else if (opType === 'bisync') opConfig['path1'] = path;
        else opConfig['srcFs'] = path;
      }
    }

    const destValue = rawValue['dest'] as Record<string, unknown> | undefined;
    if (destValue) {
      const destPath = this.resolvePath(destValue, remoteName);
      if (opType === 'mount') opConfig['mountPoint'] = destPath;
      else if (opType === 'bisync') opConfig['path2'] = destPath;
      else opConfig['dstFs'] = destPath;
    }

    const fields = this.dynamicFlagFields();

    const opOptsGroup = inner.get('options') as FormGroup | null;
    if (opOptsGroup) {
      const cleanedOp = this.valueMapper.cleanData(
        opOptsGroup.getRawValue() as Record<string, unknown>,
        fields[opType as FlagType] ?? []
      );
      Object.assign(opConfig, cleanedOp);
    }

    const rclone: Record<string, unknown> = {
      ...opConfig,
    };

    const sharedTypes =
      opType === 'mount' || opType === 'serve'
        ? (['vfs', 'filter', 'backend'] as const)
        : (['filter', 'backend'] as const);

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

    const runtimeRaw = this.runtimeRemoteForm().getRawValue() as Record<string, unknown>;
    delete runtimeRaw['type'];
    const cleanedRuntime = this.valueMapper.cleanData(runtimeRaw, this.runtimeRemoteFields());
    if (Object.keys(cleanedRuntime).length > 0) {
      rclone['runtimeRemote'] = cleanedRuntime;
    }

    return {
      id: this.targetQuickRun()?.id,
      name,
      description,
      operationType: opType,
      remoteName,
      config: { app, rclone },
    };
  }

  private resolvePath(item: Record<string, unknown>, currentRemote: string): string {
    const type = String(item['type'] ?? 'currentRemote');
    const rawPath = String(item['path'] ?? '').trim();
    const cleanCurrent = (currentRemote || '').replace(/:+$/, '');

    if (type === 'currentRemote') {
      if (!cleanCurrent) return rawPath;
      if (rawPath.startsWith(`${cleanCurrent}:`)) return rawPath;
      return rawPath ? `${cleanCurrent}:${rawPath}` : `${cleanCurrent}:`;
    }

    if (type.startsWith('otherRemote:')) {
      const otherRemote = type.slice('otherRemote:'.length).replace(/:+$/, '');
      if (!otherRemote) return rawPath;
      if (rawPath.startsWith(`${otherRemote}:`)) return rawPath;
      return rawPath ? `${otherRemote}:${rawPath}` : `${otherRemote}:`;
    }

    if (type === 'local' || rawPath.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(rawPath)) {
      return rawPath;
    }

    return rawPath;
  }

  // ── Template helpers ─────────────────────────────────────────────────────

  getOperationLabel(opKey: string): string {
    const def = this.operations.find(o => o.key === opKey);
    return def?.typeLabel ?? def?.actionLabel ?? opKey;
  }

  getFlagFields(type: FlagType | string): RcConfigOption[] {
    return this.dynamicFlagFields()[type] ?? [];
  }

  private readonly formVersion = signal(0);

  readonly currentValues = computed(() => {
    this.formVersion();
    const raw = this.form.getRawValue();
    const fields = this.dynamicFlagFields();
    const opType = this.currentOpType();

    const getCleanOptions = (flagType: string): Record<string, unknown> => {
      const opts =
        (raw[`${flagType}Config`] as { options?: Record<string, unknown> } | undefined)?.options ??
        {};
      const typeFields = fields[flagType as FlagType] ?? [];
      return this.valueMapper.cleanData(opts, typeFields);
    };

    const isVfsApplicable = opType === 'mount' || opType === 'serve';

    const res: Partial<Record<TemplateCategory, Record<string, unknown>>> = {
      vfs: isVfsApplicable ? getCleanOptions('vfs') : {},
      mount: getCleanOptions('mount'),
      backend: getCleanOptions('backend'),
      filter: getCleanOptions('filter'),
      sync: getCleanOptions('sync'),
      copy: getCleanOptions('copy'),
    };

    if (opType) {
      const cleanedOp = getCleanOptions(opType);
      (res as Record<string, unknown>)[opType] = cleanedOp;
    }

    return res;
  });

  private patchGroupOptions(
    configKey: string,
    opts?: Record<string, unknown>,
    ignoredKeys?: string[]
  ): void {
    if (!opts) return;
    const groupKey = configKey.endsWith('Config') ? configKey : `${configKey}Config`;
    const configGroup = this.form.get(groupKey) as FormGroup | null;
    if (!configGroup) return;

    const optsGroup = configGroup.get('options') as FormGroup | null;
    if (optsGroup) {
      for (const [k, v] of Object.entries(opts)) {
        if (ignoredKeys && ignoredKeys.includes(k)) continue;
        if (!optsGroup.contains(k)) {
          optsGroup.addControl(k, new FormControl(v));
        } else {
          optsGroup.get(k)?.setValue(v);
        }
      }
    }
  }

  onApplyTemplate(event: ApplyTemplateEvent): void {
    const { values } = event;
    const PATH_KEYS = ['srcFs', 'dstFs', 'path1', 'path2', 'fs', 'mountPoint', 'source', 'dest'];

    if (values.vfs) this.patchGroupOptions('vfsConfig', values.vfs, PATH_KEYS);
    if (values.mount) this.patchGroupOptions('mountConfig', values.mount, PATH_KEYS);
    if (values.backend) this.patchGroupOptions('backendConfig', values.backend, PATH_KEYS);
    if (values.filter) this.patchGroupOptions('filterConfig', values.filter, PATH_KEYS);
    if (values.sync) this.patchGroupOptions('syncConfig', values.sync, PATH_KEYS);
    if (values.copy) this.patchGroupOptions('copyConfig', values.copy, PATH_KEYS);

    const currentOp = this.currentOpType();
    if (currentOp) {
      const opGroup = this.getOpFormGroup(currentOp);
      const opOpts = (values as Record<string, Record<string, unknown> | undefined>)[currentOp];
      if (opOpts && typeof opOpts === 'object') {
        this.patchGroupOptions(`${currentOp}Config`, opOpts, PATH_KEYS);

        const srcPath = (opOpts['srcFs'] ?? opOpts['path1'] ?? opOpts['fs'] ?? opOpts['source']) as
          string | undefined;
        if (srcPath && typeof srcPath === 'string') {
          const sourceCtrl = opGroup.get('source');
          if (sourceCtrl instanceof FormArray && sourceCtrl.length > 0) {
            (sourceCtrl.at(0) as FormGroup).get('path')?.setValue(srcPath);
          } else if (sourceCtrl instanceof FormGroup) {
            sourceCtrl.get('path')?.setValue(srcPath);
          }
        }
        const dstPath = (opOpts['mountPoint'] ??
          opOpts['dstFs'] ??
          opOpts['path2'] ??
          opOpts['dest']) as string | undefined;
        if (dstPath && typeof dstPath === 'string') {
          const destCtrl = opGroup.get('dest') as FormGroup | null;
          destCtrl?.get('path')?.setValue(dstPath);
        }
      }
    }

    const msg = this.translate.instant('templates.applySuccess', { name: event.sourceName });
    this.notificationService.showSuccess(msg);
  }
}
