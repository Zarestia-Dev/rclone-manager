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
import { MatMenuModule } from '@angular/material/menu';
import { Subject, takeUntil } from 'rxjs';
import { FlagType, Entry } from '@app/types';
import { PathSelectionService } from '@app/services';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

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
    MatMenuModule,
    TitleCasePipe,
    MatProgressSpinnerModule,
  ],
  templateUrl: './app-operation-config.component.html',
  styles: [
    `
      .operation-config {
        display: flex;
        flex-direction: column;
        gap: var(--space-xxs);
        padding: var(--space-md);

        .header-section {
          display: flex;
          flex-direction: column;
          gap: var(--space-xxs);
          padding: var(--space-md);
          margin-bottom: var(--space-sm);
          border: 2px solid var(--primary-color);
          border-radius: var(--panel-radius);
          background: rgba(var(--primary-color-rgb), 0.1);

          .operation-enable {
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
            font-weight: 500;
          }
          .section-description {
            font-size: var(--font-size-sm);
            color: var(--app-text-color-secondary);
            margin: 0;
          }
        }

        .message {
          display: flex;
          align-items: center;
          gap: var(--space-xxs);
          font-size: var(--font-size-md);
          margin-top: var(--space-sm);
          border-radius: var(--border-radius);

          &.warning {
            color: var(--orange);
            background: rgba(var(--orange-rgb), 0.1);
            padding: var(--space-xxs) var(--space-sm);
            border: 1px solid var(--orange);
          }
        }
      }

      .path-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-xxs);
      }

      .path-prefix {
        cursor: pointer;

        &.mount-local,
        &.mount-remote,
        ::ng-deep .mat-mdc-select-trigger {
          display: flex;
          align-items: center;
          gap: var(--space-xxs);
        }

        &.mount-local,
        &.mount-remote {
          display: flex;
          align-items: center;
          gap: var(--space-xxs);
          padding: 19.4px;
        }

        ::ng-deep .ng-star-inserted {
          display: flex;
          align-items: center;
          gap: var(--space-xxs);
        }

        ::ng-deep .mat-mdc-select-value {
          padding: 19.4px;
        }

        ::ng-deep .mat-mdc-select-arrow-wrapper {
          display: none;
        }

        /* Apply styles to the trigger */
        ::ng-deep .mat-mdc-select-trigger {
          transition: all 150ms ease-in-out;
          min-width: 0;
        }

        &.mount-local,
        &.local ::ng-deep .mat-mdc-select-trigger {
          background: rgba(var(--purple-rgb), 0.1);
          color: var(--purple);
        }

        &.mount-remote,
        &.remote ::ng-deep .mat-mdc-select-trigger {
          background: rgba(var(--primary-color-rgb), 0.1);
          color: var(--primary-color);
        }

        &.other ::ng-deep .mat-mdc-select-trigger {
          background: rgba(var(--accent-color-rgb), 0.1);
          color: var(--accent-color);
        }

        &.locked {
          cursor: default;
        }

        mat-icon {
          font-size: 1.1rem;
          height: 1.1rem;
          width: 1.1rem;
        }
      }

      .path-input-wrapper {
        position: relative;
      }
      ::ng-deep .mat-mdc-menu-content {
        max-height: 260px;
        overflow-y: auto;
      }
      .loading-spinner,
      .no-results {
        display: flex;
        align-items: center;
        flex-direction: row;
        gap: var(--space-sm);
        padding: var(--space-sm) var(--space-md);
        color: var(--app-text-color-secondary);
        font-style: italic;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationConfigComponent implements OnInit, OnDestroy, OnChanges {
  @Input({ required: true }) opFormGroup!: FormGroup;
  @Input({ required: true }) operationType: FlagType = 'mount';
  @Input({ required: true }) currentRemoteName = 'remote';
  @Input() existingRemotes: string[] = [];
  @Input() description = '';
  @Input() isNewRemote = true;

  @Output() sourceFolderSelected = new EventEmitter<void>();
  @Output() destFolderSelected = new EventEmitter<void>();

  readonly pathSelectionService = inject(PathSelectionService);
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly destroy$ = new Subject<void>();

  isMount = false;
  otherRemotes: string[] = [];
  sourcePathType: PathType = 'currentRemote';
  destPathType: PathType = 'local';

  get sourceFormPath(): string {
    return this.buildFormPath('source');
  }

  get destFormPath(): string {
    return this.buildFormPath('dest');
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['operationType']) {
      this.isMount = this.operationType === 'mount';
    }

    if (changes['existingRemotes'] || changes['currentRemoteName']) {
      this.otherRemotes = this.existingRemotes.filter(r => r !== this.currentRemoteName);
    }
  }

  ngOnInit(): void {
    this.isMount = this.operationType === 'mount';
    this.otherRemotes = this.existingRemotes.filter(r => r !== this.currentRemoteName);
    this.initializePathListeners();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.pathSelectionService.resetPathSelection(this.sourceFormPath);
    this.pathSelectionService.resetPathSelection(this.destFormPath);
  }

  // ============================================================================
  // PATH TYPE MANAGEMENT
  // ============================================================================

  private initializePathListeners(): void {
    this.watchPathType('source');

    // Only watch dest if it's a FormGroup (non-mount)
    if (!this.isMount) {
      this.watchPathType('dest');
    }
  }

  private watchPathType(group: PathGroup): void {
    const formGroup = this.getFormGroup(group);
    const pathTypeControl = formGroup?.get('pathType');

    if (!pathTypeControl) return;

    // Set initial state
    this.updatePathTypeState(group, pathTypeControl.value);

    // Watch for changes
    pathTypeControl.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(value => this.handlePathTypeChange(group, value));
  }

  private handlePathTypeChange(group: PathGroup, value: string): void {
    const formPath = this.buildFormPath(group);

    // Clean up old state
    this.pathSelectionService.resetPathSelection(formPath);

    // *** FIX: Path clearing is now handled by a user-interaction event in the template ***
    // const formGroup = this.getFormGroup(group);
    // formGroup?.get('path')?.setValue('', { emitEvent: false }); // REMOVED

    // Update state
    this.updatePathTypeState(group, value);

    // Initialize remote browsing if needed
    const remoteName = this.getRemoteNameFromValue(value);
    if (remoteName && !this.isNewRemoteCurrentPath(group, value)) {
      // *** FIX: Pass the current path value to properly initialize browsing in edit mode ***
      const formGroup = this.getFormGroup(group);
      const currentPath = formGroup?.get('path')?.value || '';
      this.initializeRemoteBrowsing(formPath, remoteName, currentPath);
    }

    this.cdRef.markForCheck();
  }

  /**
   * Clears the path input when the user manually changes the path type.
   * This is triggered by (selectionChange) in the template to avoid clearing
   * the path during programmatic form patching in edit mode.
   */
  public clearPathOnTypeChange(group: PathGroup): void {
    const formGroup = this.getFormGroup(group);
    formGroup?.get('path')?.setValue('');
  }

  private updatePathTypeState(group: PathGroup, value: string): void {
    const pathType = this.parsePathType(value);
    const remoteName = this.getRemoteNameFromValue(value);

    // Update visual state
    if (group === 'source') {
      this.sourcePathType = pathType;
    } else {
      this.destPathType = pathType;
    }

    // Update otherRemoteName control
    const formGroup = this.getFormGroup(group);
    const otherRemoteControl = formGroup?.get('otherRemoteName');

    if (otherRemoteControl) {
      const newValue = pathType === 'otherRemote' ? remoteName : '';
      otherRemoteControl.patchValue(newValue || '', { emitEvent: false });
    }
  }

  // ============================================================================
  // PATH PARSING & BUILDING
  // ============================================================================

  private parsePathType(value: string): PathType {
    if (value === 'local') return 'local';
    if (value === 'currentRemote') return 'currentRemote';
    if (value?.startsWith('otherRemote:')) return 'otherRemote';
    return 'local';
  }

  private getRemoteNameFromValue(value: string): string | null {
    if (value === 'currentRemote') return this.currentRemoteName;
    if (value?.startsWith('otherRemote:')) return value.split(':')[1] || null;
    return null;
  }

  private buildFormPath(group: PathGroup): string {
    const formGroup = this.getFormGroup(group);
    if (!formGroup) return `${this.operationType}.${group}.local`;

    const pathTypeValue = formGroup.get('pathType')?.value || 'local';
    const remoteName = this.getRemoteNameFromValue(pathTypeValue) || 'local';

    return `${this.operationType}.${group}.${remoteName}`;
  }

  // ============================================================================
  // REMOTE BROWSING
  // ============================================================================

  // *** FIX: Accept a path parameter to initialize the state correctly ***
  private async initializeRemoteBrowsing(
    formPath: string,
    remoteName: string,
    path = ''
  ): Promise<void> {
    this.pathSelectionService.pathState[formPath] = {
      remoteName,
      // *** FIX: Use the provided path for the initial state ***
      currentPath: path,
      options: [],
    };

    this.cdRef.markForCheck();

    try {
      // *** FIX: Fetch entries for the provided path ***
      await this.pathSelectionService.fetchEntriesForField(formPath, remoteName, path);
    } catch (error) {
      console.error(`Error fetching directory for ${formPath}:`, error);
      if (this.pathSelectionService.pathState[formPath]) {
        this.pathSelectionService.pathState[formPath].options = [];
      }
    } finally {
      this.cdRef.markForCheck();
    }
  }

  // ============================================================================
  // USER INTERACTIONS
  // ============================================================================

  onPathSelected(formPath: string, entryName: string): void {
    const control = this.getPathControl(formPath);
    if (control) {
      this.pathSelectionService.onPathSelected(formPath, entryName, control);
    }
  }

  onInputChanged(event: Event, formPath: string): void {
    const value = (event.target as HTMLInputElement).value;
    const group = formPath.includes('.source.') ? 'source' : 'dest';
    const formGroup = this.getFormGroup(group);

    // Don't trigger search for new remote's current remote path
    if (this.isNewRemote && formGroup?.get('pathType')?.value === 'currentRemote') {
      return;
    }

    this.pathSelectionService.onInputChanged(formPath, value);
  }

  goUp(formPath: string): void {
    const state = this.pathSelectionService.pathState[formPath];
    const control = this.getPathControl(formPath);

    if (!state || !control) return;

    const currentPath = state.currentPath || '';
    const parentPath = this.getParentPath(currentPath);

    control.setValue(parentPath);
    this.pathSelectionService.fetchEntriesForField(formPath, state.remoteName, parentPath);
  }

  onSelectFolder(pathType: PathGroup): void {
    if (pathType === 'source') {
      this.sourceFolderSelected.emit();
    } else {
      this.destFolderSelected.emit();
    }
  }

  trackByEntry(_index: number, entry: Entry): string {
    return entry.ID || entry.Path;
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private isNewRemoteCurrentPath(group: PathGroup, pathTypeValue: string): boolean {
    return this.isNewRemote && pathTypeValue === 'currentRemote';
  }

  private getParentPath(path: string): string {
    if (!path || path === '/') return '';
    const parts = path.split('/').filter(p => p);
    parts.pop();
    return parts.join('/');
  }

  getFormGroup(group: PathGroup): FormGroup | null {
    if (group === 'source') {
      const control = this.opFormGroup.get('source');
      return control instanceof FormGroup ? control : null;
    }

    // Mount operations have dest as FormControl, not FormGroup
    if (this.isMount) return null;

    const control = this.opFormGroup.get('dest');
    return control instanceof FormGroup ? control : null;
  }

  private getPathControl(formPath: string): AbstractControl | null {
    const isSource = formPath.includes('.source.');

    if (isSource) {
      return this.opFormGroup.get('source.path');
    }

    // Mount dest is a direct FormControl
    if (this.isMount) {
      return this.opFormGroup.get('dest');
    }

    // Non-mount dest is nested in FormGroup
    return this.opFormGroup.get('dest.path');
  }
}
