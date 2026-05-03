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
  AbstractControl,
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
import { MatMenuModule } from '@angular/material/menu';
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
type PathGroup = 'sources' | 'dests';

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
    MatMenuModule,
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

  readonly isDataOperation = computed(() => {
    const type = this.operationType();
    return !!(type && ['sync', 'copy', 'move'].includes(type as string));
  });

  allowFiles(group: PathGroup): boolean {
    return group === 'sources' && this.isDataOperation();
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
    return this.getPathItems('sources');
  });
  readonly destItems = computed(() => {
    this.refreshTrigger();
    return this.getPathItems('dests');
  });

  // Keep subscriptions idempotent across effect re-runs
  private readonly controlSyncSubs = new Map<string, Subscription>();
  private readonly pathTypeSubs = new Map<PathGroup, Subscription>();

  constructor() {
    effect(() => {
      if (!this.isNewRemote()) {
        this.initializeInlineAutocomplete();
      } else {
        this.pathSelectionService.unregisterField('sources');
        this.pathSelectionService.unregisterField('dests');
        this.pathStates.clear();
      }
    });

    effect(() => {
      const formGroup = this.opFormGroup();
      if (!formGroup) return;

      this.syncControlToSignal('cronExpression', this.cronExpression);
      this.syncControlToSignal('cronEnabled', this.isCronEnabled);

      this.watchPathGroup('sources');
      if (!this.isMount() && !this.isServe()) {
        this.watchPathGroup('dests');
      }
    });

    this.destroyRef.onDestroy(() => {
      this.controlSyncSubs.forEach(sub => sub.unsubscribe());
      this.pathTypeSubs.forEach(sub => sub.unsubscribe());
      this.pathSelectionService.unregisterField('sources');
      this.pathSelectionService.unregisterField('dests');
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

    // Consistently register all sources and destinations
    this.sourceItems().forEach(item => this.registerAutocomplete('sources', item.index));
    if (!this.isServe()) {
      this.destItems().forEach(item => this.registerAutocomplete('dests', item.index));
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

  clearPathOnTypeChange(group: PathGroup, index: number): void {
    this.getPathControl(group, index)?.setValue('', { emitEvent: false });
    this.pathSelectionService.resetPath(`${group}-${index}`);
  }

  addPath(group: PathGroup): void {
    if (group === 'dests') return; // Enforce singular destination

    const array = this.getFormArray(group);
    if (!array) return;

    array.push(
      new FormGroup({
        type: new FormControl('currentRemote'),
        path: new FormControl('', Validators.required),
        remote: new FormControl(''),
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
    if (array.length <= 1 && group === 'sources') return; // Keep at least one source

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
    const isSource = group === 'sources';
    const isPickerDisabled = isSource ? this.isSourcePickerDisabled() : this.isDestPickerDisabled();
    if (isPickerDisabled) return;

    // Default target based on operation and group
    const defaultTarget: FilePickerSelection =
      isSource && this.isDataOperation() ? 'both' : 'folders';
    const finalTarget = target || defaultTarget;

    const pathType = this.getPathTypeControl(group, index)?.value;
    const isMountDest = this.isMount() && group === 'dests';

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
    const requireEmpty = this.isMount() && group === 'dests' && !allowNonEmpty;
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
    const restrictToCurrent = (this.isMount() || this.isServe()) && group === 'sources';
    const currentPathType = this.getPathTypeControl(group, index)?.value;
    const currentPath = this.getPathControl(group, index)?.value || '';

    const initialLocation = this.buildInitialLocation(
      currentPathType,
      currentPath,
      restrictToCurrent
    );

    const selection: FilePickerSelection =
      target ||
      (['sync', 'copy', 'move'].includes(this.operationType() as string) ? 'both' : 'folders');

    const result = await this.fileSystemService.selectPathWithNautilus({
      mode: restrictToCurrent ? 'remote' : 'both',
      selection,
      multi: false,
      allowedRemotes: restrictToCurrent ? [this.currentRemoteName()] : undefined,
      minSelection: 1,
      initialLocation,
    });

    if (!result.cancelled && result.items.length > 0) {
      this.handleFilePickerResult(group, index, result.items[0]);
    }
  }

  private handleFilePickerResult(group: PathGroup, index: number, item: FileBrowserItem): void {
    const remoteName = this.pathSelectionService.normalizeRemoteName(item.meta.remote || '');
    const isLocal = item.meta.isLocal;
    const path = item.entry.Path;

    if (this.isMount() && group === 'dests' && !isLocal) {
      this.notificationService.showError(
        this.translate.instant('wizards.appOperation.mountDestMustBeLocal')
      );
      return;
    }

    let pathTypeValue: string;
    if (isLocal) {
      pathTypeValue = 'local';
    } else if (
      remoteName === this.pathSelectionService.normalizeRemoteName(this.currentRemoteName())
    ) {
      pathTypeValue = 'currentRemote';
    } else if (remoteName !== '') {
      pathTypeValue = `otherRemote:${remoteName}`;
    } else {
      pathTypeValue = 'local';
    }

    this.updatePathForm(group, index, path, pathTypeValue);
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
  ): { control: AbstractControl; index: number; groupName: string | number }[] {
    const array = this.getFormArray(group);
    if (array && array.length > 0) {
      return array.controls.map((ctrl, i) => {
        if (ctrl instanceof FormGroup) {
          return { control: ctrl, index: i, groupName: i };
        } else {
          // Wrap legacy FormControl in a synthetic group
          const synthetic = this.fb.group({
            type: ['local'],
            path: ctrl,
            remote: [''],
          });
          return { control: synthetic, index: i, groupName: i };
        }
      });
    }
    const singularName = group === 'sources' ? 'source' : 'dest';
    const singular = this.opFormGroup()?.get(singularName);
    if (singular) {
      if (singular instanceof FormGroup) {
        return [{ control: singular, index: 0, groupName: singularName }];
      } else {
        // Fallback for legacy FormControl structures (e.g. old mount configs)
        // We wrap it in a synthetic group so the template's formControlName="path" works.
        const synthetic = this.fb.group({
          type: ['local'],
          path: singular,
          remote: [''],
        });
        return [{ control: synthetic, index: 0, groupName: singularName }];
      }
    }
    return [];
  }

  private getGroupAtIndex(group: PathGroup, index: number): FormGroup | null {
    const array = this.getFormArray(group);
    if (array) return array.at(index) as FormGroup | null;

    const items = this.getPathItems(group);
    const item = items.find(it => it.index === index);
    return item?.control instanceof FormGroup ? item.control : null;
  }

  getPathControl(group: PathGroup, index: number): AbstractControl | null {
    const items = this.getPathItems(group);
    const item = items.find(it => it.index === index);
    if (!item || !item.control) return null;

    if (item.control instanceof FormControl) return item.control;
    return item.control.get('path') as FormControl | null;
  }

  getPathTypeControl(group: PathGroup, index: number): AbstractControl | null {
    return this.getGroupAtIndex(group, index)?.get('type') || null;
  }

  isControl(ctrl: any): boolean {
    return ctrl instanceof FormControl;
  }
}
