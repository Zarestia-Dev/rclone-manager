import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  computed,
  effect,
  DestroyRef,
  WritableSignal,
} from '@angular/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { startWith, switchMap } from 'rxjs';
import { NgTemplateOutlet } from '@angular/common';
import { FormGroup, ReactiveFormsModule, FormArray, FormControl, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  CronValidationResponse,
  EditTarget,
  FileBrowserItem,
  FilePickerSelection,
} from '@app/types';
import {
  FileSystemService,
  NotificationService,
  PathSelectionService,
  PathSelectionState,
  PathService,
} from '@app/services';
import { CronInputComponent } from '@app/shared/components';

type PathType = 'local' | 'currentRemote' | 'otherRemote';
type PathGroup = 'source' | 'dest';

interface PathItem {
  control: FormGroup;
  index: number;
  group: PathGroup;
  type: PathType;
  remoteName: string;
  pathControl: FormControl;
  typeControl: FormControl;
}

@Component({
  selector: 'app-operation-config',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    NgTemplateOutlet,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatExpansionModule,
    MatDividerModule,
    CdkMenuModule,
    CronInputComponent,
    MatProgressSpinner,
    MatTooltipModule,
    TranslateModule,
  ],
  templateUrl: './app-operation-config.component.html',
  styleUrls: ['./app-operation-config.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationConfigComponent {
  // Signal Inputs
  readonly opFormGroup = input.required<FormGroup>();
  readonly operationType = input.required<EditTarget>();
  readonly currentRemoteName = input.required<string>();
  readonly existingRemotes = input<string[]>([]);
  readonly description = input('');
  readonly isNewRemote = input(true);
  readonly searchQuery = input('');

  private readonly fileSystemService = inject(FileSystemService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly pathService = inject(PathService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  // Computed State
  readonly isMount = computed(() => this.operationType() === 'mount');
  readonly isServe = computed(() => this.operationType() === 'serve');
  readonly otherRemotes = computed(() =>
    this.existingRemotes().filter(r => r !== this.currentRemoteName())
  );

  // Form State Signals
  private readonly formValue = toSignal(
    toObservable(this.opFormGroup).pipe(
      switchMap(form => form.valueChanges.pipe(startWith(form.value)))
    )
  );

  readonly cronExpression = computed(() => this.formValue()?.cronExpression);
  readonly isCronEnabled = computed(() => !!this.formValue()?.cronEnabled);

  // Path Item Lists (Computed from Form State)
  readonly sourceItems = computed(() => {
    this.formValue(); // Track changes
    return this.getPathItems('source');
  });
  readonly destItem = computed(() => {
    this.formValue(); // Track changes
    return this.getPathItems('dest')[0] || null;
  });

  // Autocomplete state
  pathStates = new Map<string, WritableSignal<PathSelectionState>>();

  // Visibility logic
  private readonly searchTerms = computed(() => this.searchQuery().toLowerCase().split(' '));
  private readonly showSection = (keywords: string[]) => {
    const terms = this.searchTerms();
    if (terms.length === 1 && !terms[0]) return true;
    return keywords.some(k => terms.some(t => k.includes(t)));
  };

  readonly showAutoStart = computed(() => this.showSection(['auto', 'start', 'enable']));
  readonly showCronSection = computed(() => this.showSection(['cron', 'schedule', 'task']));
  readonly showSourcePath = computed(() => this.showSection(['source', 'path', 'origin']));
  readonly showDestPath = computed(() =>
    this.isServe() ? false : this.showSection(['dest', 'output', 'target'])
  );

  readonly canAddSource = computed(() =>
    ['sync', 'copy', 'move'].includes(this.operationType() as string)
  );
  readonly supportsFileSource = computed(() =>
    ['copy', 'move'].includes(this.operationType() as string)
  );

  readonly isSourcePickerDisabled = computed(
    () =>
      this.isNewRemote() &&
      this.sourceItems().some(i => i.type === 'currentRemote' && !i.pathControl.value)
  );
  readonly isDestPickerDisabled = computed(
    () =>
      this.isNewRemote() &&
      this.destItem()?.type === 'currentRemote' &&
      !this.destItem()?.pathControl.value
  );

  constructor() {
    effect(() => {
      if (this.isNewRemote()) {
        this.clearAutocomplete();
        return;
      }

      const items = [...this.sourceItems(), ...(this.destItem() ? [this.destItem()!] : [])];
      this.syncAutocomplete(items);
    });

    this.destroyRef.onDestroy(() => this.clearAutocomplete());
  }

  private getPathItems(group: PathGroup): PathItem[] {
    const ctrl = this.opFormGroup().get(group);
    const controls = ctrl instanceof FormArray ? ctrl.controls : [ctrl];

    return (controls as FormGroup[])
      .filter(c => !!c)
      .map((control, index) => {
        const typeValue = control.get('type')?.value || 'local';
        const type = this.pathService.parsePathType(typeValue);
        const remoteName =
          this.pathService.getRemoteNameFromValue(typeValue, this.currentRemoteName()) || '';

        return {
          control,
          index,
          group,
          type,
          remoteName,
          pathControl: control.get('path') as FormControl,
          typeControl: control.get('type') as FormControl,
        };
      });
  }

  // ===================================
  // Path Actions
  // ===================================

  setType(item: PathItem, typeValue: string): void {
    if (item.typeControl.value === typeValue) return;

    item.typeControl.setValue(typeValue);
    item.pathControl.setValue('', { emitEvent: false });

    const remoteName = this.pathService.getRemoteNameFromValue(typeValue, this.currentRemoteName());
    if (typeValue.startsWith('otherRemote:')) {
      item.control.get('remote')?.setValue(remoteName, { emitEvent: false });
    }

    this.pathSelectionService.resetPath(`${item.group}-${item.index}`);
  }

  addPath(group: PathGroup, initial?: { type: string; path: string; remote?: string }): void {
    if (group === 'dest') return;
    const array = this.opFormGroup().get(group) as FormArray;
    if (!array) return;

    array.push(
      new FormGroup({
        type: new FormControl(initial?.type || 'currentRemote'),
        path: new FormControl(initial?.path || '', Validators.required),
        remote: new FormControl(initial?.remote || ''),
      })
    );
  }

  removePath(group: PathGroup, index: number): void {
    const array = this.opFormGroup().get(group) as FormArray;
    if (!array || (group === 'source' && array.length <= 1)) return;

    array.removeAt(index);
    this.pathSelectionService.unregisterField(`${group}-${index}`);
    this.pathStates.delete(`${group}-${index}`);
  }

  // ===================================
  // Path Selection
  // ===================================

  async selectPath(item: PathItem): Promise<void> {
    const isSource = item.group === 'source';
    const isDisabled = isSource ? this.isSourcePickerDisabled() : this.isDestPickerDisabled();
    if (isDisabled) return;

    const target: FilePickerSelection = isSource && this.supportsFileSource() ? 'both' : 'folders';
    const isMountDest = this.isMount() && item.group === 'dest';

    if (isSource || (!isMountDest && item.type !== 'local')) {
      await this.selectNautilus(item, target);
    } else {
      await this.selectLocal(item, target);
    }
  }

  private async selectLocal(item: PathItem, target: FilePickerSelection): Promise<void> {
    const allowNonEmpty = this.opFormGroup().get('options.mount---allow_non_empty')?.value;
    const requireEmpty = this.isMount() && item.group === 'dest' && !allowNonEmpty;

    try {
      const selected =
        target === 'files'
          ? await this.fileSystemService.selectFile(item.pathControl.value)
          : await this.fileSystemService.selectFolder(requireEmpty, item.pathControl.value);

      if (selected) {
        item.pathControl.setValue(selected);
        item.typeControl.setValue('local');
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

  private getPathData(item: FileBrowserItem, group: PathGroup) {
    const remote = this.pathService.normalizeRemoteName(item.meta.remote || '');
    const isLocal = item.meta.isLocal;
    const path = item.entry.Path;

    if (this.isMount() && group === 'dest' && !isLocal) {
      this.notificationService.showError(
        this.translate.instant('wizards.appOperation.mountDestMustBeLocal')
      );
      return null;
    }

    const type = isLocal
      ? 'local'
      : remote === this.pathService.normalizeRemoteName(this.currentRemoteName())
        ? 'currentRemote'
        : `otherRemote:${remote}`;
    return { path, type, remote: isLocal ? '' : remote };
  }

  // ===================================
  // Autocomplete & Cron
  // ===================================

  private syncAutocomplete(items: PathItem[]): void {
    const currentIds = new Set(items.map(i => `${i.group}-${i.index}`));

    // Unregister removed
    for (const id of this.pathStates.keys()) {
      if (!currentIds.has(id)) {
        this.pathSelectionService.unregisterField(id);
        this.pathStates.delete(id);
      }
    }

    // Register/Update new
    items.forEach(item => {
      const id = `${item.group}-${item.index}`;
      const existing = this.pathStates.get(id);

      if (!existing || existing().remoteName !== item.remoteName) {
        if (existing) this.pathSelectionService.unregisterField(id);
        this.pathStates.set(
          id,
          this.pathSelectionService.registerField(id, item.remoteName, item.pathControl.value)
        );
      }
    });
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
}
