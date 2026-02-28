import { CommonModule, TitleCasePipe } from '@angular/common';
import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  computed,
  signal,
  effect,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormGroup, ReactiveFormsModule, AbstractControl } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDividerModule } from '@angular/material/divider';
import { CronValidationResponse, EditTarget, Entry, FileBrowserItem } from '@app/types';
import { FileSystemService, PathSelectionService, PathSelectionState } from '@app/services';
import { MatExpansionModule } from '@angular/material/expansion';
import { CdkMenuModule } from '@angular/cdk/menu';
import { CronInputComponent } from '@app/shared/components';
import { NotificationService } from '@app/services';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatTooltipModule } from '@angular/material/tooltip';

type PathType = 'local' | 'currentRemote' | 'otherRemote';
type PathGroup = 'source' | 'dest';

@Component({
  selector: 'app-operation-config',
  standalone: true,
  imports: [
    CommonModule,
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
    TitleCasePipe,
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
  opFormGroup = input.required<FormGroup>();
  operationType = input.required<EditTarget>();
  currentRemoteName = input.required<string>();
  existingRemotes = input<string[]>([]);
  description = input('');
  isNewRemote = input(true);
  searchQuery = input('');

  private readonly fileSystemService = inject(FileSystemService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  // Computed State
  isMount = computed(() => this.operationType() === 'mount');
  isServe = computed(() => this.operationType() === 'serve');
  otherRemotes = computed(() => this.existingRemotes().filter(r => r !== this.currentRemoteName()));

  // Writable State Signals
  sourcePathType = signal<PathType>('currentRemote');
  destPathType = signal<PathType>('local');

  // Inline autocomplete state
  sourcePathState: ReturnType<typeof signal<PathSelectionState>> | null = null;
  destPathState: ReturnType<typeof signal<PathSelectionState>> | null = null;

  // Search helper
  private matchesSearch = computed(() => {
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
  showAutoStart = computed(() => this.matchesSearch()('auto start enable automatic'));
  showCronSection = computed(() => this.matchesSearch()('cron schedule task scheduled timing'));
  showSourcePath = computed(() => this.matchesSearch()('source path input from origin'));
  showDestPath = computed(() => this.matchesSearch()('destination dest output target'));

  // Writable signals that are synced with form controls
  cronExpression = signal<string | null>(null);
  isCronEnabled = signal<boolean>(false);

  constructor() {
    // Initialize things that depend on inputs
    effect(() => {
      if (!this.isNewRemote()) {
        this.initializeInlineAutocomplete();
      }
    });

    // Simplify form syncing using a single effect for the stable form group
    effect(() => {
      const formGroup = this.opFormGroup();
      if (!formGroup) return;

      this.syncControlToSignal(formGroup.get('cronExpression'), this.cronExpression);
      this.syncControlToSignal(formGroup.get('cronEnabled'), this.isCronEnabled);

      // Initialize path type listeners
      this.watchPathType('source');
      if (!this.isMount() && !this.isServe()) {
        this.watchPathType('dest');
      }
    });

    // Cleanup
    this.destroyRef.onDestroy(() => {
      this.pathSelectionService.unregisterField('source');
      this.pathSelectionService.unregisterField('dest');
    });
  }

  private syncControlToSignal<T>(
    control: AbstractControl | null,
    signalToUpdate: ReturnType<typeof signal<T>>
  ): void {
    if (!control) return;

    // Set initial value
    signalToUpdate.set(control.value);

    // Subscribe to changes
    control.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(val => {
      signalToUpdate.set(val);
    });
  }

  private initializeInlineAutocomplete(): void {
    if (this.isNewRemote()) return;

    // Register source field
    this.sourcePathState = this.registerAutocomplete('source');

    // Register dest field if needed
    if (!this.isMount() && !this.isServe()) {
      this.destPathState = this.registerAutocomplete('dest');
    } else if (this.isMount()) {
      // Local mount destination
      this.destPathState = this.pathSelectionService.registerField(
        'dest',
        '',
        this.getPathControl('dest')?.value || ''
      );
    }
  }

  private registerAutocomplete(group: PathGroup): ReturnType<typeof signal<PathSelectionState>> {
    return this.pathSelectionService.registerField(
      group,
      this.currentRemoteName(),
      this.getPathControl(group)?.value || ''
    );
  }

  // ===================================
  // Path Type Handling
  // ===================================

  private watchPathType(group: PathGroup): void {
    const control = this.getFormGroup(group)?.get('pathType');
    if (!control) return;

    // Handle initial value
    this.handlePathTypeChange(group, control.value);

    // Watch for changes
    control.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(value => this.handlePathTypeChange(group, value));
  }

  private handlePathTypeChange(group: PathGroup, value: string): void {
    const pathType = this.parsePathType(value);
    const remoteName = this.getRemoteNameFromValue(value);

    // Update local signal state
    if (group === 'source') {
      this.sourcePathType.set(pathType);
    } else {
      this.destPathType.set(pathType);
    }

    // Update 'otherRemoteName' control if needed
    if (pathType === 'otherRemote') {
      this.getFormGroup(group)
        ?.get('otherRemoteName')
        ?.patchValue(remoteName || '', { emitEvent: false });
    }

    // Update autocomplete if active
    if (!this.isNewRemote()) {
      this.updateAutocompleteRegistration(group, pathType, remoteName);
    }
  }

  private updateAutocompleteRegistration(
    group: PathGroup,
    pathType: PathType,
    explicitRemoteName: string | null
  ): void {
    const currentPath = this.getPathControl(group)?.value || '';
    let effectiveRemoteName = '';

    if (pathType === 'currentRemote') {
      effectiveRemoteName = this.currentRemoteName();
    } else if (pathType === 'otherRemote' && explicitRemoteName) {
      effectiveRemoteName = explicitRemoteName;
    }
    // else local -> empty string

    this.pathSelectionService.unregisterField(group);

    const state = this.pathSelectionService.registerField(group, effectiveRemoteName, currentPath);

    if (group === 'source') this.sourcePathState = state;
    else this.destPathState = state;
  }

  clearPathOnTypeChange(group: PathGroup): void {
    this.getFormGroup(group)?.get('path')?.setValue('', { emitEvent: false });
    this.pathSelectionService.resetPath(group);
  }

  // ===================================
  // Inline Autocomplete Handlers
  // ===================================

  onInputChanged(event: Event, group: PathGroup): void {
    const value = (event.target as HTMLInputElement).value;
    this.pathSelectionService.updateInput(group, value);
  }

  onPathSelected(entryName: string, group: PathGroup): void {
    this.pathSelectionService.selectEntry(group, entryName, this.getPathControl(group));
  }

  goUp(group: PathGroup): void {
    this.pathSelectionService.navigateUp(group, this.getPathControl(group));
  }

  trackByEntry(_: number, entry: Entry): string {
    return entry.Path;
  }

  // ===================================
  // Path Selection (Dialogs)
  // ===================================

  async selectRemotePath(group: PathGroup): Promise<void> {
    const formGroup = this.getFormGroup(group);
    const pathType = formGroup?.get('pathType')?.value;
    const isMountDest = this.isMount() && group === 'dest';

    if (isMountDest || pathType === 'local') {
      await this.selectLocalPath(group);
    } else {
      await this.selectNautilusPath(group);
    }
  }

  private async selectLocalPath(group: PathGroup): Promise<void> {
    const allowNonEmpty = this.opFormGroup().get('options.mount---allow_non_empty')?.value;
    // Require empty only if it's a mount dest and not explicitly allowed non-empty
    const requireEmpty = this.isMount() && group === 'dest' && !allowNonEmpty;

    const currentPath = this.getPathControl(group)?.value || '';

    try {
      const selectedPath = await this.fileSystemService.selectFolder(requireEmpty, currentPath);
      if (selectedPath) {
        this.updatePathForm(group, selectedPath, 'local');
      }
    } catch (error) {
      console.error('Error selecting local folder:', error);
    }
  }

  private async selectNautilusPath(group: PathGroup): Promise<void> {
    const restrictToCurrent = (this.isMount() || this.isServe()) && group === 'source';
    const formGroup = this.getFormGroup(group);
    const currentPathType = formGroup?.get('pathType')?.value;
    const currentPath = this.getPathControl(group)?.value || '';

    const initialLocation = this.buildInitialLocation(
      currentPathType,
      currentPath,
      restrictToCurrent
    );

    const result = await this.fileSystemService.selectPathWithNautilus({
      mode: restrictToCurrent ? 'remote' : 'both',
      selection: 'folders',
      multi: false,
      allowedRemotes: restrictToCurrent ? [this.currentRemoteName()] : undefined,
      minSelection: 1,
      initialLocation,
    });

    if (!result.cancelled && result.items.length > 0) {
      this.handleFilePickerResult(group, result.items[0]);
    }
  }

  private handleFilePickerResult(group: PathGroup, item: FileBrowserItem): void {
    const remoteName = this.pathSelectionService.normalizeRemoteName(item.meta.remote || '');
    const isLocal = item.meta.isLocal;
    const path = item.entry.Path;

    if (this.isMount() && group === 'dest' && !isLocal) {
      this.notificationService.showError(
        this.translate.instant('wizards.appOperation.mountDestMustBeLocal')
      );
      return;
    }

    let pathTypeValue = 'local';
    if (isLocal) {
      pathTypeValue = 'local';
    } else if (
      remoteName === this.pathSelectionService.normalizeRemoteName(this.currentRemoteName())
    ) {
      pathTypeValue = 'currentRemote';
    } else if (remoteName !== '') {
      pathTypeValue = `otherRemote:${remoteName}`;
    }

    this.updatePathForm(group, path, pathTypeValue);
  }

  private buildInitialLocation(
    pathType: string | null,
    path: string,
    restrictToCurrent: boolean
  ): string | undefined {
    // If strict local
    if (pathType === 'local') return path || undefined;

    // Determine remote prefix
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

  private updatePathForm(group: PathGroup, path: string, pathTypeValue: string): void {
    this.getPathControl(group)?.setValue(path);
    this.getPathControl(group)?.markAsDirty();
    this.getFormGroup(group)?.get('pathType')?.setValue(pathTypeValue);
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
  }

  private updateControlAndSignal<T>(
    controlName: string,
    value: T,
    signalToUpdate: ReturnType<typeof signal<T | null>>
  ): void {
    const control = this.opFormGroup().get(controlName);
    if (!control) return;

    if (control.value !== value) {
      control.setValue(value, { emitEvent: false });
    }
    // Always sync signal manually when bypassing events
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

  private getFormGroup(group: PathGroup): FormGroup | null {
    return this.opFormGroup().get(group) as FormGroup | null;
  }

  private getPathControl(group: PathGroup): AbstractControl | null {
    const basePath = group === 'source' ? 'source.path' : this.isMount() ? 'dest' : 'dest.path';
    return this.opFormGroup().get(basePath);
  }
}
