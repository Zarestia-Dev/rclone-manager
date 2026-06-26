import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  computed,
  effect,
  DestroyRef,
  WritableSignal,
  signal,
  linkedSignal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormGroup, ReactiveFormsModule, FormArray, FormControl } from '@angular/forms';

import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

import {
  CronValidationResponse,
  EditTarget,
  FileBrowserItem,
  FilePickerSelection,
  CORE_COMMAND_OPS,
  WATCH_SUPPORTED_OPS,
  CORE_SYNC_OPS,
  MULTI_SOURCE_OPS,
  FILE_SOURCE_OPS,
} from '@app/types';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import {
  PathSelectionService,
  PathSelectionState,
} from 'src/app/services/remote/path-selection.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { CronInputComponent } from 'src/app/shared/remote-config/cron-input/cron-input.component';
import { NumberInputComponent } from 'src/app/shared/components/number-input/number-input.component';

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
    MatSlideToggleModule,
    MatButtonModule,
    MatIconModule,
    MatDividerModule,
    MatExpansionModule,
    CdkMenuModule,
    CronInputComponent,
    NumberInputComponent,
    MatProgressSpinner,
    MatTooltipModule,
    TranslateModule,
  ],
  templateUrl: './app-operation-config.component.html',
  styleUrl: './app-operation-config.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationConfigComponent {
  readonly opFormGroup = input.required<FormGroup>();
  readonly operationType = input.required<EditTarget>();
  readonly currentRemoteName = input.required<string>();
  readonly existingRemotes = input<string[]>([]);
  readonly description = input('');
  readonly isNewRemote = input(true);
  readonly searchQuery = input('');

  // Services
  private readonly fileSystemService = inject(FileSystemService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly pathService = inject(PathService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly backendService = inject(BackendService);

  readonly cronPanelExpanded = linkedSignal<boolean>(() => {
    this.formVersion();
    return !!this.opFormGroup().get('cronEnabled')?.value;
  });
  readonly watchPanelExpanded = linkedSignal<boolean>(() => {
    this.formVersion();
    return !!this.opFormGroup().get('watchEnabled')?.value;
  });
  readonly cronExpression = computed(() => {
    this.formVersion();
    return this.opFormGroup().get('cronExpression')?.value;
  });
  readonly isWatchEnabled = computed(() => {
    this.formVersion();
    return !!this.opFormGroup().get('watchEnabled')?.value;
  });

  readonly isMount = computed(() => this.operationType() === 'mount');
  readonly isServe = computed(() => this.operationType() === 'serve');
  readonly isCoreCommandOp = computed(() =>
    (CORE_COMMAND_OPS as readonly string[]).includes(this.operationType() as string)
  );
  readonly otherRemotes = computed(() =>
    this.existingRemotes().filter(r => r !== this.currentRemoteName())
  );

  private readonly formVersion = signal<number>(0);
  private readonly pathStructureVersion = signal<number>(0);

  readonly isWatchSupported = computed(
    () =>
      this.backendService.isLocalBackend() &&
      (WATCH_SUPPORTED_OPS as readonly string[]).includes(this.operationType() as string)
  );

  readonly sourceItems = computed(() => {
    this.formVersion();
    this.pathStructureVersion();
    this.opFormGroup();
    return this.getPathItems('source');
  });

  readonly destItem = computed(() => {
    this.formVersion();
    this.pathStructureVersion();
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
    () =>
      (CORE_SYNC_OPS as readonly string[]).includes(this.operationType() as string) &&
      this.hasLocalSource() &&
      this.hasRemoteSource()
  );

  pathStates = new Map<string, WritableSignal<PathSelectionState>>();
  private readonly searchTerms = computed(() => this.searchQuery().toLowerCase().split(' '));

  private matchesSearch(keywords: string[]): boolean {
    const terms = this.searchTerms();
    return (terms.length === 1 && !terms[0]) || keywords.some(k => terms.some(t => k.includes(t)));
  }

  readonly showAutoStart = computed(() => this.matchesSearch(['auto', 'start', 'enable']));
  readonly showCronSection = computed(() =>
    this.matchesSearch([
      'cron',
      'schedule',
      'automation',
      'watch',
      'real-time',
      'realtime',
      'monitor',
      'filesystem',
    ])
  );
  readonly showWatchSection = computed(() => this.isWatchSupported() && this.showCronSection());
  readonly showSourcePath = computed(() => this.matchesSearch(['source', 'path', 'origin']));
  readonly showDestPath = computed(
    () =>
      !['serve', 'delete'].includes(this.operationType() as string) &&
      this.matchesSearch(['dest', 'output', 'target'])
  );

  readonly canAddSource = computed(() =>
    (MULTI_SOURCE_OPS as readonly string[]).includes(this.operationType() as string)
  );
  readonly supportsFileSource = computed(() =>
    (FILE_SOURCE_OPS as readonly string[]).includes(this.operationType() as string)
  );

  readonly isSourcePickerDisabled = computed(() => {
    if (!this.isNewRemote()) return false;
    return this.sourceItems().some(i => i.type === 'currentRemote' && !i.pathControl.value);
  });

  readonly isDestPickerDisabled = computed(() => {
    if (!this.isNewRemote()) return false;
    return this.destItem()?.type === 'currentRemote' && !this.destItem()?.pathControl.value;
  });

  readonly autoFilenameControl = computed(() => {
    return this.opFormGroup().get('options.autoFilename') as FormControl | null;
  });

  constructor() {
    effect(onCleanup => {
      const form = this.opFormGroup();
      const sub = form.valueChanges.subscribe(() => this.formVersion.update((v: number) => v + 1));
      onCleanup(() => sub.unsubscribe());
    });

    effect(() => {
      if (this.isNewRemote()) {
        this.clearAutocomplete();
        return;
      }
      const items = [...this.sourceItems(), ...(this.destItem() ? [this.destItem()!] : [])];
      this.syncAutocomplete(items);
    });

    effect(() => {
      const watchEnabledCtrl = this.opFormGroup().get('watchEnabled');
      if (!watchEnabledCtrl) return;

      if (this.isWatchPossible()) {
        watchEnabledCtrl.enable({ emitEvent: false });
      } else {
        if (watchEnabledCtrl.value) watchEnabledCtrl.setValue(false);
        watchEnabledCtrl.disable({ emitEvent: false });
      }
    });

    effect(onCleanup => {
      const type = this.operationType();
      if (type !== 'copyurl') return;

      const form = this.opFormGroup();
      const autoCtrl = this.autoFilenameControl();
      if (!form || !autoCtrl) return;

      // Sync filename -> autoFilename
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
          this.notificationService.showInfo(
            this.translate.instant('wizards.appOperation.multiSourceOneWayInfo')
          );
        }
      }
    });

    this.destroyRef.onDestroy(() => this.clearAutocomplete());
  }

  private getPathItems(group: PathDirection): PathItem[] {
    const ctrl = this.opFormGroup().get(group);
    const controls = ctrl instanceof FormArray ? ctrl.controls : [ctrl];

    return (controls as FormGroup[]).filter(Boolean).map((control, index) => {
      const typeValue =
        control.get('type')?.value || (group === 'source' ? 'currentRemote' : 'local');
      return {
        control,
        index,
        group,
        type: this.pathService.parsePathType(typeValue),
        remoteName:
          this.pathService.getRemoteNameFromValue(typeValue, this.currentRemoteName()) || '',
        pathControl: control.get('path') as FormControl,
        typeControl: control.get('type') as FormControl,
      };
    });
  }

  setType(item: PathItem, typeValue: string): void {
    if (item.typeControl.value === typeValue) return;

    item.typeControl.setValue(typeValue);
    item.pathControl.setValue('', { emitEvent: false });
    item.pathControl.updateValueAndValidity();

    if (typeValue.startsWith('otherRemote:')) {
      const remoteName = this.pathService.getRemoteNameFromValue(
        typeValue,
        this.currentRemoteName()
      );
      item.control.get('remote')?.setValue(remoteName, { emitEvent: false });
    } else {
      item.control.get('remote')?.setValue('', { emitEvent: false });
    }

    this.pathSelectionService.resetPath(`${item.group}-${item.index}`);
    this.pathStructureVersion.update((v: number) => v + 1);
  }

  addPath(
    group: PathDirection,
    initial?: { type: string; path: string; remote?: string; filename?: string }
  ): void {
    if (group === 'dest') return;
    const array = this.opFormGroup().get(group) as FormArray;
    if (!array) return;

    const controls: Record<string, any> = {
      type: new FormControl(initial?.type ?? 'currentRemote'),
      path: new FormControl(initial?.path ?? ''),
      remote: new FormControl(initial?.remote ?? ''),
    };

    if (this.operationType() === 'copyurl') {
      controls['filename'] = new FormControl(initial?.filename ?? '');
    }

    array.push(new FormGroup(controls));
    this.pathStructureVersion.update((v: number) => v + 1);
  }

  removePath(group: PathDirection, index: number): void {
    const array = this.opFormGroup().get(group) as FormArray;
    if (!array || (group === 'source' && array.length <= 1)) return;

    array.removeAt(index);
    this.pathSelectionService.unregisterField(`${group}-${index}`);
    this.pathStates.delete(`${group}-${index}`);
    this.pathStructureVersion.update((v: number) => v + 1);
  }

  async selectPath(item: PathItem): Promise<void> {
    const isSource = item.group === 'source';
    if (isSource ? this.isSourcePickerDisabled() : this.isDestPickerDisabled()) return;

    const target: FilePickerSelection = isSource && this.supportsFileSource() ? 'both' : 'folders';
    const isMountDest = this.isMount() && item.group === 'dest';

    if (isSource || (!isMountDest && item.type !== 'local')) {
      await this.selectNautilus(item, target);
    } else {
      await this.selectLocal(item, target);
    }
  }

  private async selectLocal(item: PathItem, target: FilePickerSelection): Promise<void> {
    const allowNonEmpty = this.opFormGroup().get('options.AllowNonEmpty')?.value;
    const requireEmpty = this.isMount() && item.group === 'dest' && !allowNonEmpty;

    try {
      const selected =
        target === 'files'
          ? await this.fileSystemService.selectFile(item.pathControl.value)
          : await this.fileSystemService.selectFolder(requireEmpty, item.pathControl.value);

      if (selected) {
        item.pathControl.setValue(selected);
        item.typeControl.setValue('local');
        item.control.get('remote')?.setValue('');
        this.pathStructureVersion.update((v: number) => v + 1);
      }
    } catch (e) {
      console.error('Local picker error:', e);
    }
  }

  private async selectNautilus(item: PathItem, target: FilePickerSelection): Promise<void> {
    const restrict = (this.isMount() || this.isServe()) && item.group === 'source';
    const initialLocation = this.buildInitialLocation(item, restrict);

    const result = await this.fileSystemService.selectPathWithNautilus({
      mode: restrict ? 'remote' : 'both',
      selection: target,
      multi: item.group === 'source' && this.canAddSource(),
      allowedRemotes: restrict ? [this.currentRemoteName()] : undefined,
      initialLocation,
    });

    if (!result.cancelled && result.items.length > 0) {
      result.items.forEach((res, i) => {
        const data = this.getPathData(res, item.group);
        if (!data) return;

        if (i === 0) {
          item.pathControl.setValue(data.path);
          item.typeControl.setValue(data.type);
          item.control.get('remote')?.setValue(data.remote || '');
          this.pathStructureVersion.update((v: number) => v + 1);
        } else {
          this.addPath(item.group, data);
        }
      });
    }
  }

  private buildInitialLocation(item: PathItem, restrict: boolean): string | undefined {
    if (item.type === 'local') return item.pathControl.value || undefined;
    const remote = restrict ? this.currentRemoteName() : item.remoteName;
    if (!remote) return undefined;
    return item.pathControl.value
      ? this.pathService.joinPath(`${remote}:`, item.pathControl.value)
      : `${remote}:`;
  }

  private getPathData(item: FileBrowserItem, group: PathDirection) {
    const data = this.pathService.resolvePathGroup(item, this.currentRemoteName());

    if (this.isMount() && group === 'dest' && data.type !== 'local') {
      this.notificationService.showError(
        this.translate.instant('wizards.appOperation.mountDestMustBeLocal')
      );
      return null;
    }
    return data;
  }

  private syncAutocomplete(items: PathItem[]): void {
    const currentIds = new Set(items.map(i => `${i.group}-${i.index}`));

    for (const id of this.pathStates.keys()) {
      if (!currentIds.has(id)) {
        this.pathSelectionService.unregisterField(id);
        this.pathStates.delete(id);
      }
    }

    for (const item of items) {
      const id = `${item.group}-${item.index}`;
      const existing = this.pathStates.get(id);

      if (!existing || existing().remoteName !== item.remoteName) {
        if (existing) this.pathSelectionService.unregisterField(id);
        this.pathStates.set(
          id,
          this.pathSelectionService.registerField(id, item.remoteName, item.pathControl.value)
        );
      }
    }
  }

  private clearAutocomplete(): void {
    this.pathStates.forEach((_, id) => this.pathSelectionService.unregisterField(id));
    this.pathStates.clear();
  }

  onInputChanged(event: Event, item: PathItem): void {
    this.pathSelectionService.updateInput(
      `${item.group}-${item.index}`,
      (event.target as HTMLInputElement).value
    );
  }

  onPathSelected(entryName: string, item: PathItem): void {
    this.pathSelectionService.selectEntry(
      `${item.group}-${item.index}`,
      entryName,
      item.pathControl
    );
  }

  goUp(item: PathItem): void {
    this.pathSelectionService.navigateUp(`${item.group}-${item.index}`, item.pathControl);
  }

  onCronChange(cron: string | null): void {
    this.opFormGroup().get('cronExpression')?.setValue(cron);
  }

  onCronValidationChange(result: CronValidationResponse): void {
    this.opFormGroup().get('cronValidation')?.setValue(result, { emitEvent: false });
  }

  clearSchedule(event: Event): void {
    event.stopPropagation();
    this.opFormGroup().get('cronExpression')?.setValue(null);
    this.opFormGroup().get('cronValidation')?.setValue({ isValid: false }, { emitEvent: false });
  }

  onMenuOpened(item: PathItem): void {
    const id = `${item.group}-${item.index}`;
    this.pathSelectionService.triggerLoad(id, item.remoteName, item.pathControl.value);
  }
}
