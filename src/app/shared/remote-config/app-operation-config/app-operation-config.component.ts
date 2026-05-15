import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  computed,
  signal,
  effect,
  DestroyRef,
  WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormGroup,
  FormBuilder,
  ReactiveFormsModule,
  FormArray,
  FormControl,
  Validators,
} from '@angular/forms';
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
import { Subscription } from 'rxjs';
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
} from '@app/services';
import { CronInputComponent } from '@app/shared/components';

type PathType = 'local' | 'currentRemote' | 'otherRemote';
type PathGroup = 'source' | 'dest';

@Component({
  selector: 'app-operation-config',
  standalone: true,
  imports: [
    ReactiveFormsModule,
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
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fb = inject(FormBuilder);

  // Computed State
  readonly isMount = computed(() => this.operationType() === 'mount');
  readonly isServe = computed(() => this.operationType() === 'serve');
  readonly otherRemotes = computed(() =>
    this.existingRemotes().filter(r => r !== this.currentRemoteName())
  );

  // Writable State Signals
  readonly sourcePathType = signal<PathType>('currentRemote');
  readonly destPathType = signal<PathType>('local');
  private readonly refreshTrigger = signal(0);

  // Inline autocomplete state (indexed by "group-index")
  pathStates = new Map<string, WritableSignal<PathSelectionState>>();

  // Search helper
  private readonly matchesSearch = computed(() => {
    const query = this.searchQuery().toLowerCase();
    if (!query) return (_: string) => true;
    return (keywords: string) => {
      const keywordList = keywords.toLowerCase();
      return (
        keywordList.includes(query) || query.split(' ').some(term => keywordList.includes(term))
      );
    };
  });

  // Computed Visibility flags
  readonly showAutoStart = computed(() => this.matchesSearch()('auto start enable automatic'));
  readonly showCronSection = computed(() =>
    this.matchesSearch()('cron schedule task scheduled timing')
  );
  readonly showSourcePath = computed(() => this.matchesSearch()('source path input from origin'));
  readonly showDestPath = computed(() => {
    if (this.isServe()) return false;
    return this.matchesSearch()('destination dest output target');
  });

  readonly canAddSource = computed(() => {
    const type = this.operationType();
    return !!(type && ['sync', 'copy', 'move'].includes(type as string));
  });

  readonly canAddDest = computed(() => {
    // rclone sync/copy/move/bisync/mount typically target a single destination per operation.
    return false;
  });

  readonly supportsFileSource = computed(() => {
    const type = this.operationType();
    return !!(type && ['copy', 'move'].includes(type as string));
  });

  allowFiles(group: PathGroup): boolean {
    return group === 'source' && this.supportsFileSource();
  }

  // Writable signals synced with form controls
  readonly cronExpression = signal<string | null>(null);
  readonly isCronEnabled = signal<boolean>(false);

  readonly isSourcePickerDisabled = computed(
    () => this.isNewRemote() && this.sourcePathType() === 'currentRemote'
  );
  readonly isDestPickerDisabled = computed(
    () => this.isNewRemote() && this.destPathType() === 'currentRemote'
  );

  // Unified access to path items for template iteration
  readonly sourceItems = computed(() => {
    this.refreshTrigger();
    return this.getPathItems('source');
  });
  readonly destItem = computed(() => {
    this.refreshTrigger();
    return this.getPathItem('dest');
  });

  // Keep subscriptions idempotent across effect re-runs
  private readonly controlSyncSubs = new Map<string, Subscription>();
  private readonly pathTypeSubs = new Map<PathGroup, Subscription>();

  constructor() {
    effect(() => {
      if (!this.isNewRemote()) {
        this.initializeInlineAutocomplete();
      } else {
        this.pathSelectionService.unregisterField('source');
        this.pathSelectionService.unregisterField('dest');
        this.pathStates.clear();
      }
    });

    effect(() => {
      const formGroup = this.opFormGroup();
      if (!formGroup) return;

      this.syncControlToSignal('cronExpression', this.cronExpression);
      this.syncControlToSignal('cronEnabled', this.isCronEnabled);

      this.watchPathGroup('source');
      if (!this.isMount() && !this.isServe()) {
        this.watchPathGroup('dest');
      }
    });

    this.destroyRef.onDestroy(() => {
      this.controlSyncSubs.forEach(sub => sub.unsubscribe());
      this.pathTypeSubs.forEach(sub => sub.unsubscribe());
      this.pathSelectionService.unregisterField('source');
      this.pathSelectionService.unregisterField('dest');
      this.pathStates.clear();
    });
  }

  private syncControlToSignal<T>(controlName: string, signalToUpdate: WritableSignal<T>): void {
    const control = this.opFormGroup().get(controlName);
    if (!control) return;

    signalToUpdate.set(control.value);

    this.controlSyncSubs.get(controlName)?.unsubscribe();
    const sub = control.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(val => {
      signalToUpdate.set(val);
    });
    this.controlSyncSubs.set(controlName, sub);
  }

  private initializeInlineAutocomplete(): void {
    this.pathStates.clear();

    // Consistently register all source and destinations
    this.sourceItems().forEach(item => this.registerAutocomplete('source', item.index));
    const dest = this.destItem();
    if (!this.isServe() && dest) {
      this.registerAutocomplete('dest', dest.index);
    }
  }

  private registerAutocomplete(group: PathGroup, index: number): void {
    const fieldId = `${group}-${index}`;
    this.pathSelectionService.unregisterField(fieldId);

    const control = this.getPathControl(group, index);
    if (!control) return;

    const state = this.pathSelectionService.registerField(
      fieldId,
      this.currentRemoteName(),
      control.value || ''
    );
    this.pathStates.set(fieldId, state);
  }

  // ===================================
  // Path Type Handling
  // ===================================

  private watchPathGroup(group: PathGroup): void {
    const array = this.getFormArray(group);
    if (array) {
      // Watch all controls in the array
      array.controls.forEach((_, i) => this.watchPathAtIndex(group, i));

      this.pathTypeSubs.get(group)?.unsubscribe();
      const sub = array.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        array.controls.forEach((_, i) => this.watchPathAtIndex(group, i));
      });
      this.pathTypeSubs.set(group, sub);
    } else {
      // Watch singular control (at index 0 for consistency)
      this.watchPathAtIndex(group, 0);
    }
  }

  private watchPathAtIndex(group: PathGroup, index: number): void {
    const subKey = `${group}-${index}`;
    if (this.controlSyncSubs.has(subKey)) return;

    const control = this.getPathTypeControl(group, index);
    if (!control) return;

    this.handlePathTypeChange(group, index, control.value);

    const sub = control.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(value => this.handlePathTypeChange(group, index, value));
    this.controlSyncSubs.set(subKey, sub);
  }

  private handlePathTypeChange(group: PathGroup, index: number, value: string): void {
    const pathType = this.parsePathType(value);
    const remoteName = this.getRemoteNameFromValue(value);

    if (pathType === 'otherRemote') {
      this.getGroupAtIndex(group, index)
        ?.get('remote')
        ?.patchValue(remoteName || '', { emitEvent: false });
    }

    if (!this.isNewRemote()) {
      this.updateAutocompleteRegistration(group, index, pathType, remoteName);
    }
  }

  setType(group: PathGroup, index: number, typeValue: string): void {
    const typeCtrl = this.getPathTypeControl(group, index);
    if (typeCtrl && typeCtrl.value !== typeValue) {
      typeCtrl.setValue(typeValue);
      this.clearPathOnTypeChange(group, index);
    }
  }

  private updateAutocompleteRegistration(
    group: PathGroup,
    index: number,
    pathType: PathType,
    explicitRemoteName: string | null
  ): void {
    const fieldId = `${group}-${index}`;
    const currentPath = this.getPathControl(group, index)?.value || '';
    let effectiveRemoteName = '';

    if (pathType === 'currentRemote') {
      effectiveRemoteName = this.currentRemoteName();
    } else if (pathType === 'otherRemote' && explicitRemoteName) {
      effectiveRemoteName = explicitRemoteName;
    }

    this.pathSelectionService.unregisterField(fieldId);
    const state = this.pathSelectionService.registerField(
      fieldId,
      effectiveRemoteName,
      currentPath
    );
    this.pathStates.set(fieldId, state);
  }

  setPathType(group: PathGroup, index: number, value: string): void {
    const control = this.getPathTypeControl(group, index);
    if (control && control.value !== value) {
      control.setValue(value);
      this.clearPathOnTypeChange(group, index);
    }
  }

  clearPathOnTypeChange(group: PathGroup, index: number): void {
    this.getPathControl(group, index)?.setValue('', { emitEvent: false });
    this.pathSelectionService.resetPath(`${group}-${index}`);
  }

  addPath(group: PathGroup, initialValues?: { type: string; path: string; remote?: string }): void {
    if (group === 'dest') return; // Enforce singular destination

    const array = this.getFormArray(group);
    if (!array) return;

    const typeValue = initialValues?.type || 'currentRemote';
    const pathValue = initialValues?.path || '';
    const remoteValue = initialValues?.remote || this.getRemoteNameFromValue(typeValue) || '';

    array.push(
      new FormGroup({
        type: new FormControl(typeValue),
        path: new FormControl(pathValue, Validators.required),
        remote: new FormControl(remoteValue),
      })
    );

    if (!this.isNewRemote()) {
      this.registerAutocomplete(group, array.length - 1);
    }
    this.refreshTrigger.update(v => v + 1);
  }

  removePath(group: PathGroup, index: number): void {
    const array = this.getFormArray(group);
    if (!array) return;
    if (array.length <= 1 && group === 'source') return; // Keep at least one source

    array.removeAt(index);
    this.refreshTrigger.update(v => v + 1);
    const fieldId = `${group}-${index}`;
    this.pathSelectionService.unregisterField(fieldId);
    this.pathStates.delete(fieldId);

    // Clean up sync subs for removed/shifted indices
    const subKey = `${group}-${index}`;
    this.controlSyncSubs.get(subKey)?.unsubscribe();
    this.controlSyncSubs.delete(subKey);
  }

  // ===================================
  // Inline Autocomplete Handlers
  // ===================================

  onInputChanged(event: Event, group: PathGroup, index: number): void {
    const value = (event.target as HTMLInputElement).value;
    const fieldId = `${group}-${index}`;
    this.pathSelectionService.updateInput(fieldId, value);
  }

  onPathSelected(entryName: string, group: PathGroup, index: number): void {
    const fieldId = `${group}-${index}`;
    this.pathSelectionService.selectEntry(fieldId, entryName, this.getPathControl(group, index));
  }

  goUp(group: PathGroup, index: number): void {
    const fieldId = `${group}-${index}`;
    this.pathSelectionService.navigateUp(fieldId, this.getPathControl(group, index));
  }

  // ===================================
  // Path Selection (Dialogs)
  // ===================================

  async selectRemotePath(
    group: PathGroup,
    index: number,
    target?: FilePickerSelection
  ): Promise<void> {
    const isSource = group === 'source';
    const isPickerDisabled = isSource ? this.isSourcePickerDisabled() : this.isDestPickerDisabled();
    if (isPickerDisabled) return;

    // Default target based on operation and group
    const defaultTarget: FilePickerSelection =
      isSource && this.supportsFileSource() ? 'both' : 'folders';
    const finalTarget = target || defaultTarget;

    const pathType = this.getPathTypeControl(group, index)?.value;
    const isMountDest = this.isMount() && group === 'dest';

    if (isMountDest || pathType === 'local') {
      await this.selectLocalPath(group, index, finalTarget);
    } else {
      await this.selectNautilusPath(group, index, finalTarget);
    }
  }

  private async selectLocalPath(
    group: PathGroup,
    index: number,
    target: FilePickerSelection = 'folders'
  ): Promise<void> {
    const allowNonEmpty = this.opFormGroup().get('options.mount---allow_non_empty')?.value;
    const requireEmpty = this.isMount() && group === 'dest' && !allowNonEmpty;
    const currentPath = this.getPathControl(group, index)?.value || '';

    try {
      let selectedPath: string | undefined;

      if (target === 'files') {
        selectedPath = await this.fileSystemService.selectFile(currentPath);
      } else {
        // Default to folder
        selectedPath = await this.fileSystemService.selectFolder(requireEmpty, currentPath);
      }

      if (selectedPath) {
        this.updatePathForm(group, index, selectedPath, 'local');
      }
    } catch (error) {
      console.error(`Error selecting local ${target}:`, error);
    }
  }

  private async selectNautilusPath(
    group: PathGroup,
    index: number,
    target?: FilePickerSelection
  ): Promise<void> {
    const restrictToCurrent = (this.isMount() || this.isServe()) && group === 'source';
    const currentPathType = this.getPathTypeControl(group, index)?.value;
    const currentPath = this.getPathControl(group, index)?.value || '';

    const initialLocation = this.buildInitialLocation(
      currentPathType,
      currentPath,
      restrictToCurrent
    );

    const selection: FilePickerSelection =
      target || (this.supportsFileSource() ? 'both' : 'folders');

    const canMulti = group === 'source' && this.canAddSource();

    const result = await this.fileSystemService.selectPathWithNautilus({
      mode: restrictToCurrent ? 'remote' : 'both',
      selection,
      multi: canMulti,
      allowedRemotes: restrictToCurrent ? [this.currentRemoteName()] : undefined,
      minSelection: 1,
      initialLocation,
    });

    if (!result.cancelled && result.items.length > 0) {
      result.items.forEach((item, i) => {
        const data = this.getPathDataFromItem(group, item);
        if (!data) return;

        if (i === 0) {
          this.updatePathForm(group, index, data.path, data.type);
        } else {
          this.addPath(group, data);
        }
      });
    }
  }

  private getPathDataFromItem(
    group: PathGroup,
    item: FileBrowserItem
  ): { path: string; type: string; remote: string } | null {
    const remoteName = this.pathSelectionService.normalizeRemoteName(item.meta.remote || '');
    const isLocal = item.meta.isLocal;
    const path = item.entry.Path;

    if (this.isMount() && group === 'dest' && !isLocal) {
      this.notificationService.showError(
        this.translate.instant('wizards.appOperation.mountDestMustBeLocal')
      );
      return null;
    }

    let pathTypeValue: string;
    let actualRemote = '';

    if (isLocal) {
      pathTypeValue = 'local';
    } else if (
      remoteName === this.pathSelectionService.normalizeRemoteName(this.currentRemoteName())
    ) {
      pathTypeValue = 'currentRemote';
      actualRemote = this.currentRemoteName();
    } else if (remoteName !== '') {
      pathTypeValue = `otherRemote:${remoteName}`;
      actualRemote = remoteName;
    } else {
      pathTypeValue = 'local';
    }

    return { path, type: pathTypeValue, remote: actualRemote };
  }

  private handleFilePickerResult(group: PathGroup, index: number, item: FileBrowserItem): void {
    const data = this.getPathDataFromItem(group, item);
    if (data) {
      this.updatePathForm(group, index, data.path, data.type);
    }
  }

  private buildInitialLocation(
    pathType: string | null,
    path: string,
    restrictToCurrent: boolean
  ): string | undefined {
    if (pathType === 'local') return path || undefined;

    let prefix = '';
    if (pathType === 'currentRemote' || restrictToCurrent) {
      prefix = `${this.currentRemoteName()}:`;
    } else if (pathType?.startsWith('otherRemote:')) {
      const remote = pathType.substring('otherRemote:'.length);
      if (remote) prefix = `${remote}:`;
    }

    if (!prefix) return undefined;
    return path ? `${prefix}${path}` : prefix;
  }

  private updatePathForm(
    group: PathGroup,
    index: number,
    path: string,
    pathTypeValue: string
  ): void {
    this.getPathControl(group, index)?.setValue(path);
    this.getPathControl(group, index)?.markAsDirty();
    this.getPathTypeControl(group, index)?.setValue(pathTypeValue);
  }

  // ===================================
  // Cron & UI Helpers
  // ===================================

  onCronChange(cron: string | null): void {
    this.updateControlAndSignal('cronExpression', cron, this.cronExpression);
  }

  onCronValidationChange(result: CronValidationResponse): void {
    this.opFormGroup().get('cronValidation')?.setValue(result, { emitEvent: false });
  }

  clearSchedule(event: Event): void {
    event.stopPropagation();
    this.updateControlAndSignal('cronExpression', null, this.cronExpression);
    this.opFormGroup().get('cronValidation')?.setValue({ isValid: false }, { emitEvent: false });
  }

  private updateControlAndSignal<T>(
    controlName: string,
    value: T,
    signalToUpdate: WritableSignal<T | null>
  ): void {
    const control = this.opFormGroup().get(controlName);
    if (!control) return;

    if (control.value !== value) {
      control.setValue(value, { emitEvent: false });
    }
    signalToUpdate.set(value);
  }

  private parsePathType(value: string): PathType {
    if (value === 'local') return 'local';
    if (value === 'currentRemote') return 'currentRemote';
    if (value?.startsWith('otherRemote:')) return 'otherRemote';
    return 'local';
  }

  private getRemoteNameFromValue(value: string): string | null {
    if (value?.startsWith('otherRemote:')) {
      return value.substring('otherRemote:'.length) || null;
    }
    return value === 'currentRemote' ? this.currentRemoteName() : null;
  }

  getOtherRemoteName(group: PathGroup, index: number): string {
    return this.getGroupAtIndex(group, index)?.get('remote')?.value || '';
  }

  getPathTypeAtIndex(group: PathGroup, index: number): PathType {
    const value = this.getPathTypeControl(group, index)?.value;
    return this.parsePathType(value);
  }

  hasRequiredError(controlPath: string): boolean {
    return this.opFormGroup().get(controlPath)?.hasError('required') === true;
  }

  getFormArray(group: PathGroup): FormArray | null {
    const ctrl = this.opFormGroup()?.get(group);
    return ctrl instanceof FormArray ? ctrl : null;
  }

  isPlural(group: PathGroup): boolean {
    return this.getFormArray(group) !== null;
  }

  getPathItems(
    group: PathGroup
  ): { control: FormGroup; index: number; groupName: string | number }[] {
    const array = this.getFormArray(group);
    if (array && array.length > 0) {
      return array.controls.map((ctrl, i) => ({
        control: ctrl as FormGroup,
        index: i,
        groupName: i,
      }));
    }
    const singular = this.getPathItem(group);
    return singular ? [singular] : [];
  }

  getPathItem(
    group: PathGroup
  ): { control: FormGroup; index: number; groupName: string | number } | null {
    const array = this.getFormArray(group);
    if (array && array.length > 0) {
      return { control: array.at(0) as FormGroup, index: 0, groupName: 0 };
    }
    const singular = this.opFormGroup()?.get(group);
    if (singular instanceof FormGroup) {
      return { control: singular, index: 0, groupName: group };
    }
    return null;
  }

  private getGroupAtIndex(group: PathGroup, index: number): FormGroup | null {
    const array = this.getFormArray(group);
    if (array) return array.at(index) as FormGroup | null;

    const items = this.getPathItems(group);
    const item = items.find(it => it.index === index);
    return item?.control instanceof FormGroup ? item.control : null;
  }

  getPathControl(group: PathGroup, index: number): FormControl | null {
    const items = this.getPathItems(group);
    const item = items.find(it => it.index === index);
    if (!item || !item.control) return null;

    return item.control.get('path') as FormControl | null;
  }

  getPathTypeControl(group: PathGroup, index: number): FormControl | null {
    return this.getGroupAtIndex(group, index)?.get('type') as FormControl | null;
  }

  isControl(ctrl: any): boolean {
    return ctrl instanceof FormControl;
  }
}
