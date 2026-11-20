import * as pathUtils from 'src/app/shared/utils/path.utils';
import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  computed,
  effect,
  DestroyRef,
  signal,
  linkedSignal,
  untracked,
} from '@angular/core';

import { NgTemplateOutlet } from '@angular/common';
import { merge } from 'rxjs';
import { FormGroup, ReactiveFormsModule, FormArray, FormControl } from '@angular/forms';

import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  CronValidationResponse,
  EditTarget,
  CORE_SYNC_OPS,
  MOUNT_NETWORK_MODE_KEYS,
  MOUNT_VOLUME_NAME_KEYS,
  type PathGroup,
  type DefaultPathOp,
  isSourceOnlyOperation,
  operationHas,
  type OperationFlag,
} from '@app/types';
import { isMobile } from 'src/app/services/infrastructure/platform/api-client.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { PathInspectionService } from 'src/app/services/infrastructure/platform/path-inspection.service';
import { CronInputComponent } from 'src/app/shared/remote-config/cron-input/cron-input.component';
import { NumberInputComponent } from 'src/app/shared/components/number-input/number-input.component';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { PathFieldComponent } from 'src/app/shared/components/path-field/path-field.component';
import { formatCronHumanReadable } from 'src/app/services/i18n/cron-locale.mapper';
import { UrlPreviewComponent } from 'src/app/shared/components/url-preview/url-preview.component';
import { ConfigSearchService } from 'src/app/services/remote/config-search.service';

import { WindowsMountTargetComponent } from '../windows-mount-target/windows-mount-target.component';
import { PillDirective } from '../../directives/pill.directive';
type PathType = 'local' | 'currentRemote' | 'otherRemote';
type PathDirection = 'source' | 'dest';

interface PathItem {
  control: FormGroup;
  index: number;
  group: PathDirection;
  type: PathType;
  remoteName: string;
  pathControl: FormControl;
  typeControl: FormControl;
}

@Component({
  selector: 'app-operation-config',
  imports: [
    ReactiveFormsModule,
    NgTemplateOutlet,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatButtonModule,
    MatIconModule,
    MatExpansionModule,
    CronInputComponent,
    NumberInputComponent,
    TranslatePipe,
    AlertBannerComponent,
    PathFieldComponent,
    UrlPreviewComponent,
    PillDirective,
    WindowsMountTargetComponent,
  ],
  providers: [PathSelectionService],
  templateUrl: './app-operation-config.component.html',
  styleUrls: ['./app-operation-config.component.scss', './operation-path-row.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationConfigComponent {
  readonly opFormGroup = input.required<FormGroup>();
  readonly operationType = input.required<EditTarget>();
  readonly currentRemoteName = input.required<string>();
  readonly currentProfileName = input<string | null>(null);
  /** The Quick Run being edited, so that its own folders do not count as taken. */
  readonly currentQuickRunId = input<string | null>(null);
  readonly existingRemotes = input<string[]>([]);
  readonly mountProfiles = input<Record<string, unknown>>();
  readonly description = input('');
  readonly isNewRemote = input(true);
  readonly showAutomations = input(true);
  readonly searchQuery = input('');

  // Services
  private readonly fileSystemService = inject(FileSystemService);
  private readonly pathService = inject(PathService);
  private readonly pathInspectionService = inject(PathInspectionService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly backendService = inject(BackendService);
  private readonly configSearch = inject(ConfigSearchService);

  readonly fullDestPath = computed(() => {
    this.formVersion();
    const dest = this.destItem();
    if (!dest) return '';
    const pathVal = (dest.pathControl?.value || '').trim();
    if (dest.type === 'local') {
      return pathVal;
    }
    const remote = dest.remoteName || this.currentRemoteName();
    return remote ? (pathVal ? `${remote}:${pathVal}` : `${remote}:`) : pathVal;
  });

  readonly cronPanelExpanded = linkedSignal<boolean>(() => {
    this.formVersion();
    return !!this.opFormGroup().get('cronEnabled')?.value;
  });
  readonly autoStartPanelExpanded = linkedSignal<boolean>(() => {
    this.formVersion();
    return !!this.opFormGroup().get('autoStart')?.value;
  });
  readonly isAutoStartEnabled = computed(() => {
    this.formVersion();
    return !!this.opFormGroup().get('autoStart')?.value;
  });
  readonly autoStartDelayValue = computed(() => {
    this.formVersion();
    return Number(this.opFormGroup().get('autoStartDelay')?.value) || 0;
  });
  readonly watchPanelExpanded = linkedSignal<boolean>(() => {
    this.formVersion();
    return !!this.opFormGroup().get('watchEnabled')?.value;
  });
  readonly cronExpression = computed(() => {
    this.formVersion();
    return this.opFormGroup().get('cronExpression')?.value;
  });
  readonly cronHumanDescription = computed(() => {
    const cron = this.cronExpression();
    if (!cron) return null;
    return formatCronHumanReadable(cron, this.translate.currentLang());
  });
  readonly isWatchEnabled = computed(() => {
    this.formVersion();
    return !!this.opFormGroup().get('watchEnabled')?.value;
  });
  readonly isWatchChangedOnly = computed(() => {
    this.formVersion();
    return !!this.opFormGroup().get('watchChangedOnly')?.value;
  });
  readonly watchDelayValue = computed(() => {
    this.formVersion();
    return this.opFormGroup().get('watchDelay')?.value;
  });

  readonly isMount = computed(() => this.operationType() === 'mount');
  protected readonly isWindowsMount = computed(
    () => this.isMount() && this.backendService.isWindows()
  );
  protected readonly canSelectDriveLetter = computed(
    () => this.isMount() && this.fileSystemService.canSelectDriveLetter()
  );
  protected readonly networkModeControl = computed(() =>
    this.mountOptionControl(MOUNT_NETWORK_MODE_KEYS)
  );
  protected readonly volumeNameControl = computed(() =>
    this.mountOptionControl(MOUNT_VOLUME_NAME_KEYS)
  );
  readonly isServe = computed(() => this.operationType() === 'serve');
  readonly isCoreCommandOp = computed(() => this.hasFlag('coreCommand'));
  readonly otherRemotes = computed(() =>
    this.existingRemotes().filter(r => r !== this.currentRemoteName())
  );

  private readonly formVersion = signal<number>(0);

  private mountOptionControl(keys: readonly string[]): FormControl | null {
    this.formVersion();
    const options = this.opFormGroup().get('options');
    const key = keys.find(name => options?.get(name));
    return (key ? options?.get(key) : null) as FormControl | null;
  }
  private readonly pathVersion = signal(0);

  readonly isWatchSupported = computed(
    () => this.backendService.isLocalBackend() && this.hasFlag('watchable')
  );

  readonly sourceItems = computed(() => {
    this.pathVersion();
    this.opFormGroup();
    return this.getPathItems('source');
  });

  readonly destItem = computed(() => {
    this.pathVersion();
    this.opFormGroup();
    return this.getPathItems('dest')[0] ?? null;
  });

  readonly hasLocalSource = computed(() => this.sourceItems().some(i => i.type === 'local'));
  readonly hasLocalDest = computed(() => this.destItem()?.type === 'local');
  readonly hasRemoteSource = computed(() => this.sourceItems().some(i => i.type !== 'local'));

  readonly isWatchPossible = computed(() =>
    this.operationType() === 'bisync'
      ? this.hasLocalSource() || this.hasLocalDest()
      : this.hasLocalSource()
  );

  readonly hasMixedSources = computed(
    () => this.isOperationInList(CORE_SYNC_OPS) && this.hasLocalSource() && this.hasRemoteSource()
  );

  private pathResolveToken = 0;
  private readonly generatedDefaultPaths = new WeakMap<
    FormControl,
    { path: string; context: string }
  >();
  private matchesSearch(keywords: string[], translationKeys: string[] = []): boolean {
    return this.configSearch.matchesText(this.searchQuery(), keywords, translationKeys);
  }

  readonly showAutoStart = computed(
    () =>
      this.showAutomations() &&
      this.matchesSearch(
        ['auto', 'start', 'enable', 'delay'],
        ['wizards.appOperation.enableAutoStart', 'wizards.appOperation.autoStartDelay']
      )
  );
  readonly showCronSection = computed(
    () =>
      this.showAutomations() &&
      this.matchesSearch(
        [
          'cron',
          'schedule',
          'automation',
          'watch',
          'real-time',
          'realtime',
          'monitor',
          'filesystem',
        ],
        [
          'wizards.appOperation.enableScheduled',
          'wizards.appOperation.scheduleSubtitle',
          'wizards.appOperation.scheduleDescription',
          'wizards.appOperation.enableWatch',
          'wizards.appOperation.watchDelay',
          'wizards.appOperation.watchChangedOnly',
        ]
      )
  );
  readonly isMobilePlatform = computed(() => isMobile());
  readonly selectedMountType = computed(() => {
    this.formVersion();
    const fg = this.opFormGroup();
    const val = fg.get('options.mountType')?.value ?? fg.get('mountType')?.value;
    if (val) return String(val).toLowerCase();
    const destPath = String(fg.get('dest.path')?.value ?? '');
    return destPath.startsWith('saf://') ? 'saf' : 'mount';
  });
  readonly isLocalMobileSafMount = computed(
    () =>
      this.isMobilePlatform() &&
      this.backendService.isLocalBackend() &&
      this.selectedMountType() === 'saf'
  );
  readonly isLocalMobileNonSafMount = computed(
    () =>
      this.isMobilePlatform() &&
      this.backendService.isLocalBackend() &&
      this.selectedMountType() !== 'saf'
  );
  readonly showWatchSection = computed(() => this.isWatchSupported() && this.showCronSection());
  readonly showSourcePath = computed(() =>
    this.matchesSearch(
      ['source', 'path', 'origin'],
      ['wizards.appOperation.sourcePaths', 'wizards.appOperation.remotePathServe']
    )
  );
  readonly showDestPath = computed(
    () =>
      this.operationType() !== 'serve' &&
      !isSourceOnlyOperation(this.operationType() as string) &&
      !(this.isMount() && this.isLocalMobileSafMount()) &&
      (this.matchesSearch(
        ['dest', 'destination', 'path', 'output', 'target'],
        ['wizards.appOperation.destinationPath']
      ) ||
        (this.canSelectDriveLetter() &&
          this.matchesSearch(
            [...MOUNT_VOLUME_NAME_KEYS, ...MOUNT_NETWORK_MODE_KEYS, 'network mode'],
            [
              'volname.title',
              'network_mode.title',
              'wizards.appOperation.mountDiskName',
              'wizards.appOperation.mountNetworkName',
              'wizards.appOperation.mountWindowsAppearance',
              'wizards.appOperation.mountLocalDrive',
              'wizards.appOperation.mountNetworkDrive',
            ]
          )))
  );

  readonly canAddSource = computed(() => this.hasFlag('multiSource'));
  readonly supportsFileSource = computed(() => this.hasFlag('fileSource'));

  isItemPickerDisabled(item: PathItem): boolean {
    if (!this.isNewRemote()) return false;
    return item.type === 'currentRemote' && !item.pathControl.value;
  }

  readonly autoFilenameControl = computed(() => {
    return this.opFormGroup().get('options.autoFilename') as FormControl | null;
  });

  readonly warningBanners = computed(() => {
    const banners: string[] = [];
    if (this.isNewRemote()) {
      banners.push('wizards.appOperation.completionNote');
    }
    if (this.isMount() && this.isLocalMobileNonSafMount()) {
      banners.push('mount.androidRootWarning');
    }
    if (this.showWatchSection() && !this.isWatchPossible()) {
      banners.push(
        this.operationType() === 'bisync'
          ? 'wizards.appOperation.watchRequiresLocal'
          : 'wizards.appOperation.watchRequiresLocalSource'
      );
    }
    return banners;
  });

  readonly infoBanners = computed(() => {
    const banners: string[] = [];
    if (this.isMount() && this.isLocalMobileSafMount()) {
      banners.push('wizards.appOperation.mobileSafMountNote');
    }
    if (this.isCoreCommandOp()) {
      banners.push('wizards.appOperation.coreCommandNote');
    }
    if (this.operationType() === 'copyurl') {
      banners.push('wizards.appOperation.copyUrlFileSettingsWarning');
    }
    if (this.showWatchSection() && this.isWatchPossible()) {
      banners.push('wizards.appOperation.watchFilterNote');
      if (this.hasMixedSources()) {
        banners.push('wizards.appOperation.watchMixedSourcesNote');
      }
    }
    const type = this.operationType();
    if ((type === 'check' || type === 'cryptcheck') && this.sourceItems().length > 1) {
      banners.push('wizards.appOperation.multiSourceOneWayInfo');
    }
    return banners;
  });

  constructor() {
    effect(onCleanup => {
      const form = this.opFormGroup();
      const sub = form.valueChanges.subscribe(() => this.formVersion.update((v: number) => v + 1));
      onCleanup(() => sub.unsubscribe());
    });
    effect(onCleanup => {
      const form = this.opFormGroup();
      const paths = ['source', 'dest'].flatMap(key => {
        const control = form.get(key);
        return control ? [control.valueChanges] : [];
      });
      const sub = merge(...paths).subscribe(() => this.pathVersion.update(v => v + 1));
      onCleanup(() => sub.unsubscribe());
    });
    effect(() => {
      if (this.isMount() && this.isLocalMobileSafMount()) {
        const dest = this.destItem();
        if (dest && (!dest.pathControl.value || dest.pathControl.value === '')) {
          dest.pathControl.setValue(`saf://${this.currentRemoteName()}`, { emitEvent: false });
        }
      }
    });

    effect(() => {
      const type = this.operationType();
      const rName = this.currentRemoteName()?.trim();
      const form = this.opFormGroup();
      const dest = this.destItem();
      const token = ++this.pathResolveToken;

      if (
        !rName ||
        form.disabled ||
        dest?.type !== 'local' ||
        (type !== 'mount' && type !== 'bisync')
      ) {
        return;
      }

      const isMobileSaf = type === 'mount' && untracked(() => this.isLocalMobileSafMount());
      if (isMobileSaf) {
        return;
      }

      const dstCtrl = form.get('dest') as FormGroup | null;
      const pathCtrl = dstCtrl?.get('path') as FormControl | null;
      if (
        !dstCtrl ||
        !pathCtrl ||
        !pathCtrl.pristine ||
        (pathCtrl.value && this.generatedDefaultPaths.get(pathCtrl)?.path !== pathCtrl.value)
      ) {
        return;
      }

      const context = `${type}:${rName}`;
      if (pathCtrl.value && this.generatedDefaultPaths.get(pathCtrl)?.context === context) return;
      this.pathInspectionService
        .resolveDefaultPath(rName, type as 'mount' | 'bisync')
        .then(defaultPath => {
          if (token !== this.pathResolveToken) return;
          if (
            !this.destroyRef.destroyed &&
            !form.disabled &&
            pathCtrl.pristine &&
            (!pathCtrl.value || this.generatedDefaultPaths.get(pathCtrl)?.path === pathCtrl.value)
          ) {
            this.generatedDefaultPaths.set(pathCtrl, { path: defaultPath, context });
            if (pathCtrl.value !== defaultPath)
              dstCtrl.patchValue({ type: 'local', path: defaultPath });
          }
        })
        .catch(err => console.warn(`[OperationConfig] resolveDefaultPath(${type}) failed:`, err));
    });

    effect(() => {
      const watchEnabledCtrl = this.opFormGroup().get('watchEnabled');
      const watchChangedOnlyCtrl = this.opFormGroup().get('watchChangedOnly');
      if (!watchEnabledCtrl) return;

      if (this.isWatchPossible()) {
        watchEnabledCtrl.enable({ emitEvent: false });
        watchChangedOnlyCtrl?.enable({ emitEvent: false });
      } else {
        if (watchEnabledCtrl.value) watchEnabledCtrl.setValue(false);
        if (watchChangedOnlyCtrl?.value) watchChangedOnlyCtrl.setValue(false);
        watchEnabledCtrl.disable({ emitEvent: false });
        watchChangedOnlyCtrl?.disable({ emitEvent: false });
      }
    });

    effect(onCleanup => {
      const type = this.operationType();
      if (type !== 'copyurl') return;

      const form = this.opFormGroup();
      const autoCtrl = this.autoFilenameControl();
      if (!form || !autoCtrl) return;

      const sub1 = form.valueChanges.subscribe(() => {
        const sources = this.sourceItems();
        const hasCustomFilename = sources.some(item => {
          const val = item.control.get('filename')?.value;
          return !!(val && String(val).trim());
        });

        if (autoCtrl.value === hasCustomFilename) {
          autoCtrl.setValue(!hasCustomFilename, { emitEvent: false });
        }
      });

      // Sync autoFilename -> filename
      const sub2 = autoCtrl.valueChanges.subscribe(val => {
        if (val === true) {
          this.sourceItems().forEach(item => {
            const fileCtrl = item.control.get('filename');
            if (fileCtrl && fileCtrl.value !== '') {
              fileCtrl.setValue('', { emitEvent: false });
            }
          });
        }
      });

      onCleanup(() => {
        sub1.unsubscribe();
        sub2.unsubscribe();
      });
    });

    effect(() => {
      const type = this.operationType();
      if (type !== 'check' && type !== 'cryptcheck') return;

      const sources = this.sourceItems();
      if (sources.length > 1) {
        const oneWayCtrl =
          this.opFormGroup().get('options.oneWay') || this.opFormGroup().get('options.one-way');
        if (oneWayCtrl && !oneWayCtrl.value) {
          oneWayCtrl.setValue(true);
        }
      }
    });

    this.destroyRef.onDestroy(() => {
      this.pathResolveToken++;
    });
  }

  private isOperationInList(list: readonly string[]): boolean {
    return list.includes(this.operationType() as string);
  }

  private hasFlag(flag: OperationFlag): boolean {
    return operationHas(this.operationType() as string, flag);
  }

  private getPathItems(group: PathDirection): PathItem[] {
    const ctrl = this.opFormGroup().get(group);
    const controls = ctrl instanceof FormArray ? ctrl.controls : [ctrl];

    return (controls as FormGroup[]).filter(Boolean).map((control, index) => {
      const typeValue =
        control.get('type')?.value || (group === 'source' ? 'currentRemote' : 'local');
      const pathType = pathUtils.parsePathType(typeValue);
      const remoteName =
        pathUtils.getRemoteNameFromValue(typeValue, this.currentRemoteName()) || '';
      const pathControl = control.get('path') as FormControl;

      return {
        control,
        index,
        group,
        type: pathType,
        remoteName,
        pathControl,
        typeControl: control.get('type') as FormControl,
      };
    });
  }

  addPath(
    group: PathDirection,
    initial?: { type: string; path: string; remote?: string; filename?: string }
  ): void {
    if (group === 'dest') return;
    const array = this.opFormGroup().get(group) as FormArray;
    if (!array) return;

    const controls: Record<string, FormControl> = {
      type: new FormControl(initial?.type ?? 'currentRemote'),
      path: new FormControl(initial?.path ?? ''),
      remote: new FormControl(initial?.remote ?? ''),
    };

    if (this.operationType() === 'copyurl') {
      controls['filename'] = new FormControl(initial?.filename ?? '');
    }

    array.markAsDirty();
    array.push(new FormGroup(controls));
    this.formVersion.update(v => v + 1);
  }

  removePath(group: PathDirection, index: number): void {
    const array = this.opFormGroup().get(group) as FormArray;
    if (!array || (group === 'source' && array.length <= 1)) return;
    this.opFormGroup().markAsDirty();

    array.removeAt(index);
    this.formVersion.update(v => v + 1);
  }

  /**
   * A Windows mount point is a new folder under a parent the user picks, so the system picker
   * chooses the parent and the folder name comes from the volume name or the remote.
   */
  async selectMountParent(item: PathItem): Promise<void> {
    if (this.isItemPickerDisabled(item)) return;
    const previousPath = item.pathControl.value;
    const initialPath = pathUtils.isWindowsDriveFolder(previousPath)
      ? this.pathService.getParentPath(previousPath)
      : undefined;

    try {
      const selected = await this.fileSystemService.selectFolder(false, initialPath);
      if (!selected) return;
      if (
        this.destroyRef.destroyed ||
        this.destItem()?.pathControl !== item.pathControl ||
        item.pathControl.value !== previousPath
      )
        return;
      const folderTarget = pathUtils.windowsMountFolderTarget(
        selected,
        previousPath ?? '',
        this.currentRemoteName(),
        this.volumeNameControl()?.value
      );
      if (!folderTarget) {
        this.notificationService.showWarning(
          this.translate.instant('wizards.appOperation.mountFolderLocalDrive')
        );
        return;
      }
      this.opFormGroup().markAsDirty();
      item.pathControl.setValue(folderTarget);
      item.typeControl.setValue('local');
      item.control.get('remote')?.setValue('');
    } catch (e) {
      console.error('Local picker error:', e);
    }
  }

  /** The paths a picker returned beyond the first: each becomes a source of its own. */
  addPaths(group: PathDirection, paths: PathGroup[]): void {
    for (const data of paths) this.addPath(group, data);
  }

  /** A fixed type: a mount point is local, and a mount or serve source is the remote itself. */
  pathLock(item: PathItem): 'local' | 'currentRemote' | null {
    if (item.group === 'dest') return this.isMount() ? 'local' : null;
    return this.isMount() || this.isServe() ? 'currentRemote' : null;
  }

  pathPlaceholder(item: PathItem): string {
    if (item.group === 'dest') return 'wizards.appOperation.enterDestPath';
    return this.isServe()
      ? 'wizards.appOperation.rootFolderSpecific'
      : 'wizards.appOperation.enterSourcePath';
  }

  /** The system picker takes only an empty folder for a mount point, unless non-empty is allowed. */
  requiresEmptyDest(item: PathItem): boolean {
    this.formVersion();
    if (!(this.isMount() && item.group === 'dest')) return false;
    return !this.opFormGroup().get('options.allow_non_empty')?.value;
  }

  /** Which check a local folder of this operation gets: a mount point or a two-way folder. */
  inspectOp(): DefaultPathOp | null {
    const type = this.operationType();
    return type === 'mount' || type === 'bisync' ? type : null;
  }

  onCronChange(cron: string | null): void {
    this.opFormGroup().markAsDirty();
    this.opFormGroup().get('cronExpression')?.setValue(cron);
  }

  onCronValidationChange(result: CronValidationResponse): void {
    this.opFormGroup().get('cronValidation')?.setValue(result, { emitEvent: false });
  }

  clearSchedule(): void {
    this.opFormGroup().markAsDirty();
    this.opFormGroup().get('cronExpression')?.setValue(null);
    this.opFormGroup().get('cronValidation')?.setValue({ isValid: false }, { emitEvent: false });
  }
}
