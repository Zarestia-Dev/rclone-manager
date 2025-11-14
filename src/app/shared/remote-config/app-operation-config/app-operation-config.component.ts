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
import { MatDividerModule } from '@angular/material/divider';
import { Subject, takeUntil, Observable, of } from 'rxjs';
import { Entry, CronValidationResponse, EditTarget } from '@app/types';
import { PathSelectionService, PathSelectionState } from '@app/services';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatExpansionModule } from '@angular/material/expansion';
import { CronInputComponent } from '@app/shared/components';

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
    MatExpansionModule,
    MatDividerModule,
    TitleCasePipe,
    MatProgressSpinnerModule,
    CronInputComponent,
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

  @Output() sourceFolderSelected = new EventEmitter<void>();
  @Output() destFolderSelected = new EventEmitter<void>();

  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly destroy$ = new Subject<void>();

  // Path state observables
  sourcePathState$!: Observable<PathSelectionState>;
  destPathState$!: Observable<PathSelectionState>;

  // Component state
  isMount = false;
  isServe = false;
  otherRemotes: string[] = [];
  sourcePathType: PathType = 'currentRemote';
  destPathType: PathType = 'local';

  private get sourceFieldId(): string {
    return `${this.operationType}-source`;
  }

  private get destFieldId(): string {
    return `${this.operationType}-dest`;
  }

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
    this.initializePathListeners();
    if (!this.isServe) {
      this.initializeCronListener();
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.pathSelectionService.unregisterField(this.sourceFieldId);
    this.pathSelectionService.unregisterField(this.destFieldId);
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  private updateOtherRemotes(): void {
    this.otherRemotes = this.existingRemotes.filter(r => r !== this.currentRemoteName);
  }

  private initializePathListeners(): void {
    this.watchPathType('source');
    if (!this.isMount && !this.isServe) {
      this.watchPathType('dest');
    }
  }

  private initializeCronListener(): void {
    const cronControl = this.opFormGroup.get('cronExpression');
    const cronEnabledControl = this.opFormGroup.get('cronEnabled');

    if (cronControl) {
      // Listen for external changes (e.g., from modal population)
      cronControl.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(value => {
        if (value) {
          this.cdRef.markForCheck();
        }
      });
    }

    // Auto-expand panel when cron is enabled
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

    // Set initial state
    this.handlePathTypeChange(group, pathTypeControl.value);

    // Watch for changes
    pathTypeControl.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(value => this.handlePathTypeChange(group, value));
  }

  private handlePathTypeChange(group: PathGroup, value: string): void {
    this.updatePathTypeState(group, value);
    this.registerPathField(group, value);
    this.cdRef.markForCheck();
  }

  private updatePathTypeState(group: PathGroup, value: string): void {
    const pathType = this.parsePathType(value);
    const remoteName = this.getRemoteNameFromValue(value);

    if (group === 'source') {
      this.sourcePathType = pathType;
    } else {
      this.destPathType = pathType;
    }

    // Update otherRemoteName control for display purposes
    const otherRemoteControl = this.getFormGroup(group)?.get('otherRemoteName');
    if (otherRemoteControl && pathType === 'otherRemote') {
      otherRemoteControl.patchValue(remoteName || '', { emitEvent: false });
    }
  }

  private registerPathField(group: PathGroup, pathTypeValue: string): void {
    const fieldId = group === 'source' ? this.sourceFieldId : this.destFieldId;
    const remoteName = this.getRemoteNameFromValue(pathTypeValue);

    // Unregister old field to clear state
    this.pathSelectionService.unregisterField(fieldId);

    // Register new field if it's a remote path
    if (remoteName && !this.isNewRemoteCurrentPath(pathTypeValue)) {
      const formGroup = this.getFormGroup(group);
      const initialPath = formGroup?.get('path')?.value || '';
      const state$ = this.pathSelectionService.registerField(fieldId, remoteName, initialPath);

      if (group === 'source') {
        this.sourcePathState$ = state$;
      } else {
        this.destPathState$ = state$;
      }
    } else {
      // Use empty state for local paths
      const emptyState$ = of({} as PathSelectionState);
      if (group === 'source') {
        this.sourcePathState$ = emptyState$;
      } else {
        this.destPathState$ = emptyState$;
      }
    }
  }

  clearPathOnTypeChange(group: PathGroup): void {
    const formGroup = this.getFormGroup(group);
    formGroup?.get('path')?.setValue('', { emitEvent: false });

    const fieldId = group === 'source' ? this.sourceFieldId : this.destFieldId;
    this.pathSelectionService.resetPath(fieldId);
  }

  // ============================================================================
  // PATH SELECTION EVENT HANDLERS
  // ============================================================================

  onInputChanged(event: Event, group: PathGroup): void {
    const value = (event.target as HTMLInputElement).value;
    const fieldId = group === 'source' ? this.sourceFieldId : this.destFieldId;

    // Skip if it's a new remote and current remote is selected
    if (this.isNewRemote && this.getFormGroup(group)?.get('pathType')?.value === 'currentRemote') {
      return;
    }

    this.pathSelectionService.updateInput(fieldId, value);
  }

  onPathSelected(group: PathGroup, entryName: string): void {
    const fieldId = group === 'source' ? this.sourceFieldId : this.destFieldId;
    const control = this.getPathControl(group);
    this.pathSelectionService.selectEntry(fieldId, entryName, control);
  }

  goUp(group: PathGroup): void {
    const fieldId = group === 'source' ? this.sourceFieldId : this.destFieldId;
    const control = this.getPathControl(group);
    this.pathSelectionService.navigateUp(fieldId, control);
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
  // CRON SCHEDULING
  // ============================================================================

  onCronChange(cron: string | null): void {
    const cronControl = this.opFormGroup.get('cronExpression');
    if (cronControl && cronControl.value !== cron) {
      cronControl.setValue(cron, { emitEvent: false });
    }
  }

  onCronValidationChange(result: CronValidationResponse): void {
    // Store validation result in form if needed
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
    if (value === 'currentRemote') return this.currentRemoteName;
    if (value?.startsWith('otherRemote:')) {
      return value.substring('otherRemote:'.length) || null;
    }
    return null;
  }

  private isNewRemoteCurrentPath(pathTypeValue: string): boolean {
    return this.isNewRemote && pathTypeValue === 'currentRemote';
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
