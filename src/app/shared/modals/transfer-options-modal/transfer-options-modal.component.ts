import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatSidenavModule, MatDrawerMode } from '@angular/material/sidenav';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import { PROFILE_ICONS, RcConfigOption, getOperationDef } from '@app/types';
import { FlagConfigService } from 'src/app/services/remote/flag-config.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { ConfigResourceState } from 'src/app/services/remote/utils/config-resource-state';
import {
  patchConfigOptions,
  reconcileDynamicControls,
} from 'src/app/services/remote/utils/config-form.utils';
import { syncResponsiveSidebar } from 'src/app/shared/utils';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import { SearchContainerComponent } from '../../components/search-container/search-container.component';
import { ConfigFormSkeletonComponent } from '../../remote-config/config-form-skeleton/config-form-skeleton.component';
import { FlagConfigStepComponent } from '../../remote-config/flag-config-step/flag-config-step.component';
import { RemoteConfigStepComponent } from '../../remote-config/remote-config-step/remote-config-step.component';
import {
  ApplyTemplateEvent,
  PresetTemplateBarComponent,
} from '../../remote-config/preset-template-bar/preset-template-bar.component';
import { EscapeCloseDirective } from '../../directives/escape-close.directive';

type OptionBlock = Record<string, unknown>;

/** What a file browser transfer runs with: each block a map of rclone options. */
export interface TransferOptionValues {
  copy?: OptionBlock;
  move?: OptionBlock;
  filter?: OptionBlock;
  backend?: OptionBlock;
  /** The options of single remotes, keyed by remote name without its colon. */
  remotes?: Record<string, OptionBlock>;
}

export interface TransferOptionsModalData {
  /** `transfer` asks before one transfer starts; `default` edits the file browser's default. */
  mode: 'transfer' | 'default';
  /** Upload, copy or move; for the default both copy and move are edited. */
  operation?: 'upload' | 'copy' | 'move';
  count?: number;
  /** Where the items go, as the user sees it (`drive:folder`). */
  destination?: string;
  /** The remotes the transfer reads or writes, each with a step of its own options. */
  remotes?: string[];
  /** The options the dialog starts with: the file browser's default. */
  values: TransferOptionValues;
}

type FlagStep = 'copy' | 'move' | 'filter' | 'backend';

interface Step {
  key: string;
  label: string;
  icon: string;
  /** A flag section, or the remote whose own options the step sets. */
  flag?: FlagStep;
  remote?: string;
}

interface RemoteStep {
  fields: RcConfigOption[];
  form: FormGroup;
}

/**
 * The options of a file browser transfer, set like a quick run's: the copy or move options,
 * filters, backend options and the options of each remote it touches. A template can fill them
 * in. In `default` mode it edits the options every transfer starts from. Closes with the
 * options, or with nothing when cancelled.
 */
@Component({
  selector: 'app-transfer-options-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    MatButtonModule,
    MatCheckboxModule,
    MatIconModule,
    MatListModule,
    MatSidenavModule,
    TranslatePipe,
    AlertBannerComponent,
    SearchContainerComponent,
    ConfigFormSkeletonComponent,
    FlagConfigStepComponent,
    RemoteConfigStepComponent,
    PresetTemplateBarComponent,
  ],
  templateUrl: './transfer-options-modal.component.html',
  styleUrls: ['./transfer-options-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransferOptionsModalComponent {
  private readonly dialogRef = inject(
    MatDialogRef<TransferOptionsModalComponent, TransferOptionValues>
  );
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly flagConfig = inject(FlagConfigService);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly valueMapper = inject(RcloneValueMapperService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly backend = inject(BackendService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  readonly iconService = inject(IconService);
  readonly data = inject<TransferOptionsModalData>(MAT_DIALOG_DATA);

  readonly isDefault = this.data.mode === 'default';
  /**
   * An upload to an rclone on another computer sends each file on its own as it streams
   * (`operations/uploadfile`), which reads no copy options or filters and hardly any backend
   * options; only the destination's own options apply, so only they are offered.
   */
  readonly streamsFiles = this.data.operation === 'upload' && !this.backend.isLocalBackend();
  readonly flagSteps: readonly FlagStep[] = this.isDefault
    ? ['copy', 'move', 'filter', 'backend']
    : this.streamsFiles
      ? []
      : [this.data.operation === 'move' ? 'move' : 'copy', 'filter', 'backend'];
  /** Remotes the transfer touches that have a configuration, by name without the colon. */
  private readonly remoteTypes = computed(() => {
    const names = new Set((this.data.remotes ?? []).map(name => name.replace(/:+$/, '')));
    return new Map(
      this.remoteFacade
        .remoteSummaries()
        .filter(remote => names.has(remote.name))
        .map(remote => [remote.name, remote.type])
    );
  });

  readonly steps = computed<Step[]>(() => [
    ...this.flagSteps.map(flag => ({
      key: flag,
      flag,
      icon: PROFILE_ICONS[flag],
      label:
        flag === 'filter'
          ? 'flow.quickRun.editor.tabFilter'
          : flag === 'backend'
            ? 'flow.quickRun.editor.tabBackend'
            : (getOperationDef(flag)?.typeLabel ?? flag),
    })),
    ...[...this.remoteTypes()].map(([remote, type]) => ({
      key: `remote:${remote}`,
      remote,
      icon: this.iconService.getIconName(type),
      label: remote,
    })),
  ]);
  readonly activeStep = signal('');
  readonly active = computed(
    () => this.steps().find(step => step.key === this.activeStep()) ?? this.steps()[0]
  );

  readonly form: FormGroup = this.fb.group(
    Object.fromEntries(
      this.flagSteps.map(flag => [`${flag}Config`, this.fb.group({ options: this.fb.group({}) })])
    )
  );
  readonly flagFields = signal<Partial<Record<FlagStep, RcConfigOption[]>>>({});
  readonly remoteSteps = signal<ReadonlyMap<string, RemoteStep>>(new Map());
  private readonly resources = new ConfigResourceState(this.destroyRef, error =>
    this.notifications.showError(error)
  );
  readonly isLoading = this.resources.loading;
  readonly loadFailed = this.resources.failed;

  readonly searchVisible = signal(false);
  readonly searchQuery = signal('');
  readonly isSidebarOpen = signal(true);
  readonly sidebarMode = signal<MatDrawerMode>('side');
  readonly useAsDefault = signal(false);
  readonly dontAskAgain = signal(false);

  /** The engine that runs the transfer, named the way the user knows it. */
  readonly engine = computed(() => ({
    name: this.backend.activeBackend(),
    local: this.backend.isLocalBackend(),
  }));

  readonly currentValues = (): Partial<Record<FlagStep, OptionBlock>> =>
    Object.fromEntries(this.flagSteps.map(flag => [flag, this.cleanFlags(flag)]));

  constructor() {
    syncResponsiveSidebar(
      768,
      this.sidebarMode,
      this.isSidebarOpen,
      this.destroyRef,
      inject(ElementRef<HTMLElement>).nativeElement
    );
    if (this.flagSteps.length) void this.loadFlags();
    for (const [remote, type] of this.remoteTypes()) void this.loadRemote(remote, type);
  }

  private async loadFlags(): Promise<void> {
    await this.resources.load(
      'flags',
      () => this.flagConfig.loadConfigFields([...this.flagSteps]),
      fields => {
        for (const flag of this.flagSteps) {
          const definitions = fields[flag] ?? [];
          const options = this.optionsGroup(flag);
          reconcileDynamicControls(options, definitions);
          patchConfigOptions(options, this.data.values[flag] ?? {}, definitions);
        }
        this.flagFields.set(fields);
      }
    );
  }

  private async loadRemote(remote: string, type: string): Promise<void> {
    await this.resources.load(
      `remote:${remote}`,
      () => this.remoteManagement.getRemoteConfigFields(type),
      definitions => {
        const fields = definitions.map(field => ({ ...field, Required: false }));
        const form = this.fb.group({ type: [type] });
        reconcileDynamicControls(form, fields, { required: false });
        patchConfigOptions(form, this.data.values.remotes?.[remote] ?? {}, fields);
        this.remoteSteps.update(steps => new Map(steps).set(remote, { fields, form }));
      }
    );
  }

  retry(): Promise<void> {
    return this.resources.retryFailed();
  }

  private optionsGroup(flag: FlagStep): FormGroup {
    return this.form.get(`${flag}Config.options`) as FormGroup;
  }

  /** A section's options as rclone takes them: typed, without the empty ones. */
  private cleanFlags(flag: FlagStep): OptionBlock {
    return this.valueMapper.cleanData(
      this.optionsGroup(flag).getRawValue(),
      this.flagFields()[flag] ?? []
    );
  }

  selectStep(key: string): void {
    this.activeStep.set(key);
    if (this.sidebarMode() === 'over') this.isSidebarOpen.set(false);
  }

  toggleSearch(): void {
    this.searchVisible.update(visible => !visible);
    if (!this.searchVisible()) this.searchQuery.set('');
  }

  onApplyTemplate(event: ApplyTemplateEvent): void {
    for (const flag of this.flagSteps) {
      const values = event.values[flag];
      if (values) patchConfigOptions(this.optionsGroup(flag), values, this.flagFields()[flag]);
    }
    this.form.markAsDirty();
    this.notifications.showSuccess(
      this.translate.instant('templates.applySuccess', { name: event.sourceName })
    );
  }

  /** The options as set: only the sections and remotes that have some. */
  values(): TransferOptionValues {
    const values: TransferOptionValues = {};
    for (const flag of this.flagSteps) {
      const options = this.cleanFlags(flag);
      if (Object.keys(options).length) values[flag] = options;
    }
    const remotes: Record<string, OptionBlock> = {};
    for (const [remote, step] of this.remoteSteps()) {
      const raw = step.form.getRawValue() as OptionBlock;
      delete raw['type'];
      const options = this.valueMapper.cleanData(raw, step.fields);
      if (Object.keys(options).length) remotes[remote] = options;
    }
    if (Object.keys(remotes).length) values.remotes = remotes;
    return values;
  }

  async confirm(): Promise<void> {
    const values = this.values();
    const saves: Promise<void>[] = [];
    if (this.isDefault || this.useAsDefault()) {
      saves.push(
        this.appSettings.saveSetting('nautilus', 'transfer_options', this.asDefault(values))
      );
    }
    if (this.dontAskAgain()) {
      saves.push(this.appSettings.saveSetting('nautilus', 'ask_transfer_options', false));
    }
    try {
      await Promise.all(saves);
    } catch (error) {
      // A transfer starts either way; the default could not be kept.
      this.notifications.showError(error);
      if (this.isDefault) return;
    }
    this.dialogRef.close(values);
  }

  /**
   * The default with the sections this dialog shows replaced: a transfer's dialog shows only
   * its own operation, and a remote's options stay with the transfer, which may be the only
   * one to touch that remote.
   */
  private asDefault(values: TransferOptionValues): TransferOptionValues {
    const defaults: TransferOptionValues = { ...this.data.values };
    delete defaults.remotes;
    for (const flag of this.flagSteps) {
      if (values[flag]) defaults[flag] = values[flag];
      else delete defaults[flag];
    }
    return defaults;
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
