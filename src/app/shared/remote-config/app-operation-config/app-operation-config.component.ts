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
import { FlagType, Entry, CronValidationResponse } from '@app/types';
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
  @Input({ required: true }) operationType: FlagType = 'mount';
  @Input({ required: true }) currentRemoteName = 'remote';
  @Input() existingRemotes: string[] = [];
  @Input() description = '';
  @Input() isNewRemote = true;

  @Output() sourceFolderSelected = new EventEmitter<void>();
  @Output() destFolderSelected = new EventEmitter<void>();
  @Output() cronExpressionChange = new EventEmitter<string | null>();

  readonly pathSelectionService = inject(PathSelectionService);
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly destroy$ = new Subject<void>();

  // Observables to drive the template
  sourcePathState$!: Observable<PathSelectionState>;
  destPathState$!: Observable<PathSelectionState>;

  // Cron scheduling
  cronExpression: string | null = null;
  cronValidationResult: CronValidationResponse | null = null;
  isPanelExpanded = false;

  isMount = false;
  otherRemotes: string[] = [];
  sourcePathType: PathType = 'currentRemote';
  destPathType: PathType = 'local';

  get sourceFieldId(): string {
    return `${this.operationType}-source`;
  }
  get destFieldId(): string {
    return `${this.operationType}-dest`;
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
    this.initializeCronListener();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.pathSelectionService.unregisterField(this.sourceFieldId);
    this.pathSelectionService.unregisterField(this.destFieldId);
  }

  private initializePathListeners(): void {
    this.watchPathType('source');
    if (!this.isMount) {
      this.watchPathType('dest');
    }
  }

  private watchPathType(group: PathGroup): void {
    const formGroup = this.getFormGroup(group);
    const pathTypeControl = formGroup?.get('pathType');
    if (!pathTypeControl) return;

    // Set initial state and register the field
    this.handlePathTypeChange(group, pathTypeControl.value);

    // Watch for future changes
    pathTypeControl.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(value => this.handlePathTypeChange(group, value));
  }

  private handlePathTypeChange(group: PathGroup, value: string): void {
    this.updatePathTypeState(group, value); // Update local visual state
    const fieldId = group === 'source' ? this.sourceFieldId : this.destFieldId;
    const remoteName = this.getRemoteNameFromValue(value);

    // Unregister the old field to clear its state
    this.pathSelectionService.unregisterField(fieldId);

    if (remoteName && !this.isNewRemoteCurrentPath(group, value)) {
      const formGroup = this.getFormGroup(group);
      const initialPath = formGroup?.get('path')?.value || '';
      // Register the new field, get its state observable
      const state$ = this.pathSelectionService.registerField(fieldId, remoteName, initialPath);
      if (group === 'source') {
        this.sourcePathState$ = state$;
      } else {
        this.destPathState$ = state$;
      }
    } else {
      // If it's a local path, use an empty observable
      const emptyState$ = of({} as PathSelectionState);
      if (group === 'source') {
        this.sourcePathState$ = emptyState$;
      } else {
        this.destPathState$ = emptyState$;
      }
    }

    this.cdRef.markForCheck();
  }

  public clearPathOnTypeChange(group: PathGroup): void {
    // 1. Clear the visible input field
    this.getFormGroup(group)?.get('path')?.setValue('');

    // 2. Tell the service to reset its internal path state to root
    const fieldId = group === 'source' ? this.sourceFieldId : this.destFieldId;
    this.pathSelectionService.resetPath(fieldId);
  }

  // This method now only updates the component's internal visual state
  private updatePathTypeState(group: PathGroup, value: string): void {
    const pathType = this.parsePathType(value);
    const remoteName = this.getRemoteNameFromValue(value);

    if (group === 'source') this.sourcePathType = pathType;
    else this.destPathType = pathType;

    const otherRemoteControl = this.getFormGroup(group)?.get('otherRemoteName');
    if (otherRemoteControl) {
      const newValue = pathType === 'otherRemote' ? remoteName : '';
      otherRemoteControl.patchValue(newValue || '', { emitEvent: false });
    }
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  onInputChanged(event: Event, group: PathGroup): void {
    const value = (event.target as HTMLInputElement).value;
    const fieldId = group === 'source' ? this.sourceFieldId : this.destFieldId;
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
    if (pathType === 'source') this.sourceFolderSelected.emit();
    else this.destFolderSelected.emit();
  }

  trackByEntry(_index: number, entry: Entry): string {
    return entry.ID || entry.Path;
  }

  // ============================================================================
  // HELPERS
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

  private isNewRemoteCurrentPath(group: PathGroup, pathTypeValue: string): boolean {
    return this.isNewRemote && pathTypeValue === 'currentRemote';
  }

  private getFormGroup(group: PathGroup): FormGroup | null {
    const control = this.opFormGroup.get(group as string);
    return control instanceof FormGroup ? control : null;
  }

  private getPathControl(group: PathGroup): AbstractControl | null {
    if (group === 'source') {
      return this.opFormGroup.get('source.path');
    }
    return this.isMount ? this.opFormGroup.get('dest') : this.opFormGroup.get('dest.path');
  }

  // ============================================================================
  // CRON SCHEDULING
  // ============================================================================

  onCronChange(cron: string | null): void {
    this.cronExpression = cron;
    this.cronExpressionChange.emit(cron);
    this.isPanelExpanded = !!cron;

    // ⬇️ ADD THIS BLOCK ⬇️
    // Update the parent form group's control
    const cronControl = this.opFormGroup.get('cronExpression');
    if (cronControl && cronControl.value !== cron) {
      cronControl.setValue(cron, { emitEvent: false });
    }
  }

  clearSchedule(event: Event): void {
    event.stopPropagation(); // Prevent panel toggle
    this.cronExpression = null;
    this.cronExpressionChange.emit(null);
    this.isPanelExpanded = false;

    // ⬇️ ADD THIS BLOCK ⬇️
    // Update the parent form group's control
    const cronControl = this.opFormGroup.get('cronExpression');
    if (cronControl && cronControl.value !== null) {
      cronControl.setValue(null, { emitEvent: false });
    }

    this.cdRef.markForCheck();
  }

  onCronValidationChange(result: CronValidationResponse): void {
    this.cronValidationResult = result;
  }

  private initializeCronListener(): void {
    const cronControl = this.opFormGroup.get('cronExpression');
    if (cronControl) {
      // Set initial value from the form group
      this.cronExpression = cronControl.value;
      this.isPanelExpanded = !!this.cronExpression;

      // Listen for parent form changes (e.g., modal populating)
      cronControl.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(value => {
        if (value !== this.cronExpression) {
          // Prevent self-triggering loops
          this.cronExpression = value;
          this.isPanelExpanded = !!value;
          this.cdRef.markForCheck(); // Notify change detection
        }
      });
    }
  }
}
