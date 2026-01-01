import { CommonModule, TitleCasePipe } from '@angular/common';
import {
  Component,
  Input,
  ChangeDetectionStrategy,
  Output,
  EventEmitter,
  OnInit,
  ChangeDetectorRef,
  inject,
  OnDestroy,
  SimpleChanges,
  OnChanges,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule, AbstractControl } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDividerModule } from '@angular/material/divider';
import { Observable, Subject, takeUntil } from 'rxjs';
import { CronValidationResponse, EditTarget, Entry } from '@app/types';
import { FileSystemService, PathSelectionService, PathSelectionState } from '@app/services';
import { FilePickerConfig } from '@app/types';
import { MatExpansionModule } from '@angular/material/expansion';
import { CdkMenuModule } from '@angular/cdk/menu';
import { CronInputComponent } from '@app/shared/components';
import { NotificationService } from '@app/services';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

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
  ],
  templateUrl: './app-operation-config.component.html',
  styleUrls: ['./app-operation-config.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationConfigComponent implements OnInit, OnDestroy, OnChanges {
  @Input({ required: true }) opFormGroup!: FormGroup;
  @Input({ required: true }) operationType: EditTarget = 'mount';
  @Input({ required: true }) currentRemoteName = 'remote';
  @Input() existingRemotes: string[] = [];
  @Input() description = '';
  @Input() isNewRemote = true;

  // These outputs might be less relevant now that we handle selection internally,
  // but keeping them for compatibility.
  @Output() sourceFolderSelected = new EventEmitter<void>();
  @Output() destFolderSelected = new EventEmitter<void>();

  private readonly fileSystemService = inject(FileSystemService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly notificationService = inject(NotificationService);
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly destroy$ = new Subject<void>();

  // Component state
  isMount = false;
  isServe = false;
  otherRemotes: string[] = [];
  sourcePathType: PathType = 'currentRemote';
  destPathType: PathType = 'local';

  // Inline autocomplete state
  sourcePathState$!: Observable<PathSelectionState>;
  destPathState$!: Observable<PathSelectionState>;

  get cronExpression(): string | null {
    return this.opFormGroup.get('cronExpression')?.value || null;
  }

  get isCronEnabled(): boolean {
    return this.opFormGroup.get('cronEnabled')?.value || false;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['operationType']) {
      this.isMount = this.operationType === 'mount';
      this.isServe = this.operationType === 'serve';
    }
    if (changes['existingRemotes'] || changes['currentRemoteName']) {
      this.updateOtherRemotes();
    }
  }

  ngOnInit(): void {
    this.isMount = this.operationType === 'mount';
    this.isServe = this.operationType === 'serve';
    this.updateOtherRemotes();
    this.initializePathTypeListeners();
    this.initializeInlineAutocomplete();
    if (!this.isServe) {
      this.initializeCronListener();
    }
  }

  ngOnDestroy(): void {
    this.pathSelectionService.unregisterField('source');
    this.pathSelectionService.unregisterField('dest');
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  private updateOtherRemotes(): void {
    this.otherRemotes = this.existingRemotes.filter(r => r !== this.currentRemoteName);
  }

  private initializePathTypeListeners(): void {
    this.watchPathType('source');
    if (!this.isMount && !this.isServe) {
      this.watchPathType('dest');
    }
  }

  private initializeInlineAutocomplete(): void {
    if (this.isNewRemote) return; // Skip for new remotes

    // Register source field
    this.sourcePathState$ = this.pathSelectionService.registerField(
      'source',
      this.currentRemoteName,
      this.getPathControl('source')?.value || ''
    );

    // Register dest field for sync/copy/move operations (remote paths)
    if (!this.isMount && !this.isServe) {
      this.destPathState$ = this.pathSelectionService.registerField(
        'dest',
        this.currentRemoteName,
        this.getPathControl('dest')?.value || ''
      );
    }

    // Register dest field for mount operations (local paths - empty remoteName)
    if (this.isMount) {
      this.destPathState$ = this.pathSelectionService.registerField(
        'dest',
        '', // Empty remoteName for local filesystem
        this.getPathControl('dest')?.value || ''
      );
    }
  }

  private initializeCronListener(): void {
    const cronControl = this.opFormGroup.get('cronExpression');
    const cronEnabledControl = this.opFormGroup.get('cronEnabled');

    if (cronControl) {
      cronControl.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(value => {
        if (value) {
          this.cdRef.markForCheck();
        }
      });
    }

    if (cronEnabledControl) {
      cronEnabledControl.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(enabled => {
        if (enabled) {
          this.cdRef.markForCheck();
        }
      });
    }
  }

  // ============================================================================
  // PATH TYPE MANAGEMENT
  // ============================================================================

  private watchPathType(group: PathGroup): void {
    const formGroup = this.getFormGroup(group);
    const pathTypeControl = formGroup?.get('pathType');
    if (!pathTypeControl) return;

    this.handlePathTypeChange(group, pathTypeControl.value);

    pathTypeControl.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(value => this.handlePathTypeChange(group, value));
  }

  private handlePathTypeChange(group: PathGroup, value: string): void {
    const pathType = this.parsePathType(value);
    const remoteName = this.getRemoteNameFromValue(value);

    if (group === 'source') {
      this.sourcePathType = pathType;
    } else {
      this.destPathType = pathType;
    }

    const otherRemoteControl = this.getFormGroup(group)?.get('otherRemoteName');
    if (otherRemoteControl && pathType === 'otherRemote') {
      otherRemoteControl.patchValue(remoteName || '', { emitEvent: false });
    }

    this.cdRef.markForCheck();
  }

  clearPathOnTypeChange(group: PathGroup): void {
    const formGroup = this.getFormGroup(group);
    formGroup?.get('path')?.setValue('', { emitEvent: false });
    // Reset the autocomplete state for this group
    this.pathSelectionService.resetPath(group);
  }

  // ============================================================================
  // INLINE AUTOCOMPLETE EVENT HANDLERS
  // ============================================================================

  /**
   * Called when user types in the path input field.
   */
  onInputChanged(event: Event, group: PathGroup): void {
    const value = (event.target as HTMLInputElement).value;
    this.pathSelectionService.updateInput(group, value);
  }

  /**
   * Called when user selects an entry from the autocomplete dropdown.
   */
  onPathSelected(entryName: string, group: PathGroup): void {
    const control = this.getPathControl(group);
    this.pathSelectionService.selectEntry(group, entryName, control);
  }

  /**
   * Called when user clicks the "go up" button in autocomplete.
   */
  goUp(group: PathGroup): void {
    const control = this.getPathControl(group);
    this.pathSelectionService.navigateUp(group, control);
  }

  /**
   * TrackBy function for autocomplete entries.
   */
  trackByEntry(_index: number, entry: Entry): string {
    return entry.Path;
  }

  // ============================================================================
  // PATH SELECTION EVENT HANDLERS
  // ============================================================================

  /**
   * Opens either the Native file picker (for local paths) or Nautilus (for remote paths).
   */
  async selectRemotePath(group: PathGroup): Promise<void> {
    const formGroup = this.getFormGroup(group);
    const pathType = formGroup?.get('pathType')?.value;

    // Use native picker if:
    // 1. It's a Mount Destination (always local)
    // 2. The path type is explicitly set to 'local'
    const isMountDest = this.isMount && group === 'dest';
    const isLocalSelected = pathType === 'local';

    if (isMountDest || isLocalSelected) {
      await this.selectLocalPath(group);
    } else {
      await this.selectNautilusPath(group);
    }
  }

  private async selectLocalPath(group: PathGroup): Promise<void> {
    const requireEmpty = this.isMount && group === 'dest';
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
    const restrictToCurrentRemote = (this.isMount || this.isServe) && group === 'source';
    const formGroup = this.getFormGroup(group);
    const currentPathType = formGroup?.get('pathType')?.value;
    const currentPath = this.getPathControl(group)?.value || '';

    // Build the full initial location including existing path
    const initialLocation = this.buildInitialLocation(
      currentPathType,
      currentPath,
      restrictToCurrentRemote
    );

    const cfg: FilePickerConfig = {
      mode: restrictToCurrentRemote ? 'remote' : 'both',
      selection: 'folders',
      multi: false,
      allowedRemotes: restrictToCurrentRemote ? [this.currentRemoteName] : undefined,
      minSelection: 1,
      initialLocation,
    };

    const result = await this.fileSystemService.selectPathWithNautilus(cfg);

    if (!result.cancelled && result.paths.length > 0) {
      const { remoteName, path } = this.parsePickerResultPath(result.paths[0]);

      // Validate mount destination must be local
      if (this.isMount && group === 'dest' && remoteName !== '') {
        this.notificationService.showError('Mount destination must be a local folder.');
        return;
      }

      // Determine pathType value for form
      let pathTypeValue = 'local';
      if (remoteName === this.currentRemoteName) {
        pathTypeValue = 'currentRemote';
      } else if (remoteName !== '') {
        pathTypeValue = `otherRemote:${remoteName}`;
      }

      this.updatePathForm(group, path, pathTypeValue);
    }
  }

  /**
   * Builds the initialLocation string for the file picker based on current form state.
   */
  private buildInitialLocation(
    pathType: string | null,
    currentPath: string,
    restrictToCurrentRemote: boolean
  ): string | undefined {
    if (pathType === 'local') {
      return currentPath || undefined;
    }
    if (pathType === 'currentRemote') {
      return currentPath
        ? `${this.currentRemoteName}:${currentPath}`
        : `${this.currentRemoteName}:`;
    }
    if (pathType?.startsWith('otherRemote:')) {
      const remoteName = pathType.substring('otherRemote:'.length);
      return remoteName
        ? currentPath
          ? `${remoteName}:${currentPath}`
          : `${remoteName}:`
        : undefined;
    }
    if (restrictToCurrentRemote) {
      return currentPath
        ? `${this.currentRemoteName}:${currentPath}`
        : `${this.currentRemoteName}:`;
    }
    return undefined;
  }

  /**
   * Parses a file picker result path into remote name and path components.
   */
  private parsePickerResultPath(fullPath: string): { remoteName: string; path: string } {
    const colonIdx = fullPath.indexOf(':');

    // No colon = local path (e.g., /home/user)
    if (colonIdx === -1) {
      return { remoteName: '', path: fullPath };
    }

    const potentialRemote = fullPath.substring(0, colonIdx);

    // Single char before colon = Windows drive letter (C:)
    if (potentialRemote.length === 1) {
      return { remoteName: '', path: fullPath };
    }

    // Check if it's a known remote
    const isKnownRemote =
      potentialRemote === this.currentRemoteName || this.otherRemotes.includes(potentialRemote);

    if (isKnownRemote) {
      return {
        remoteName: potentialRemote,
        path: fullPath.substring(colonIdx + 1),
      };
    }

    // Unknown remote pattern - treat as local
    return { remoteName: '', path: fullPath };
  }

  private updatePathForm(group: PathGroup, path: string, pathTypeValue: string): void {
    const formGroup = this.getFormGroup(group);
    const pathControl = this.getPathControl(group);
    const pathTypeControl = formGroup?.get('pathType');

    pathControl?.setValue(path);
    pathControl?.markAsDirty();

    if (pathTypeControl) {
      pathTypeControl.setValue(pathTypeValue);
    }

    this.cdRef.markForCheck();
  }

  // ============================================================================
  // CRON SCHEDULING
  // ============================================================================

  onCronChange(cron: string | null): void {
    const cronControl = this.opFormGroup.get('cronExpression');
    if (cronControl && cronControl.value !== cron) {
      cronControl.setValue(cron, { emitEvent: false });
    }
  }

  onCronValidationChange(result: CronValidationResponse): void {
    const validationControl = this.opFormGroup.get('cronValidation');
    if (validationControl) {
      validationControl.setValue(result, { emitEvent: false });
    }
  }

  clearSchedule(event: Event): void {
    event.stopPropagation();
    const cronControl = this.opFormGroup.get('cronExpression');
    if (cronControl) {
      cronControl.setValue(null, { emitEvent: false });
    }
    this.cdRef.markForCheck();
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private parsePathType(value: string): PathType {
    if (value === 'local') return 'local';
    if (value === 'currentRemote') return 'currentRemote';
    if (value?.startsWith('otherRemote:')) return 'otherRemote';
    return 'local';
  }

  private getRemoteNameFromValue(value: string): string | null {
    if (value === 'local') return '';
    if (value === 'currentRemote') return this.currentRemoteName;
    if (value?.startsWith('otherRemote:')) {
      return value.substring('otherRemote:'.length) || null;
    }
    return null;
  }

  private getFormGroup(group: PathGroup): FormGroup | null {
    const control = this.opFormGroup.get(group);
    return control instanceof FormGroup ? control : null;
  }

  private getPathControl(group: PathGroup): AbstractControl | null {
    if (group === 'source') {
      return this.opFormGroup.get('source.path');
    }
    return this.isMount ? this.opFormGroup.get('dest') : this.opFormGroup.get('dest.path');
  }
}
