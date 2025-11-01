import {
  Component,
  EventEmitter,
  Input,
  Output,
  OnChanges,
  SimpleChanges,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { ScrollingModule } from '@angular/cdk/scrolling';

import { FlagType, RcConfigOption } from '@app/types';
import { SettingControlComponent } from 'src/app/shared/components';
import { OperationConfigComponent } from 'src/app/shared/remote-config/app-operation-config/app-operation-config.component';

@Component({
  selector: 'app-flag-config-step',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    MatInputModule,
    SettingControlComponent,
    ScrollingModule,
    OperationConfigComponent,
  ],
  templateUrl: './flag-config-step.component.html',
  styleUrl: './flag-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlagConfigStepComponent implements OnChanges {
  @Input() form!: FormGroup;
  @Input() flagType!: FlagType;
  @Input() isEditMode = false;
  @Input() existingRemotes: string[] = [];
  @Input({ required: true }) currentRemoteName = 'remote';
  @Input() isNewRemote = false;

  @Input() dynamicFlagFields: RcConfigOption[] = [];
  @Input() mountTypes: string[] = [];

  @Input() getControlKey!: (flagType: FlagType, field: RcConfigOption) => string;

  @Output() sourceFolderSelected = new EventEmitter<void>();
  @Output() destFolderSelected = new EventEmitter<void>();

  public showAdvancedOptions = false;
  private cdRef = inject(ChangeDetectorRef);

  ngOnChanges(changes: SimpleChanges): void {
    // Mark for check when dynamic fields or mount types change
    if (changes['dynamicFlagFields'] || changes['mountTypes']) {
      this.cdRef.markForCheck();
    }
  }

  // Get all form fields as an array for virtual scrolling
  get formFields(): any[] {
    const fields = [];

    if (!this.isType(['vfs', 'filter', 'backend'])) {
      fields.push({ type: 'operation-config' });
    }

    // Mount type selector
    if (this.isType('mount')) {
      fields.push({ type: 'mount-type' });
    }

    // Bisync options
    if (this.isType('bisync')) {
      fields.push({ type: 'bisync-options' });
    }

    // Move options
    if (this.isType('move')) {
      fields.push({ type: 'move-options' });
    }

    // Copy/Sync options
    if (this.isType(['copy', 'sync'])) {
      fields.push({ type: 'copy-sync-options' });
    }

    // Dynamic flag fields
    if (this.dynamicFlagFields && this.dynamicFlagFields.length > 0) {
      fields.push({ type: 'dynamic-fields' });
    }

    return fields;
  }

  // Track by function for virtual scrolling
  trackByField(index: number, field: any): string {
    return `${field.type}-${index}`;
  }

  onSourceFolderSelect(): void {
    this.sourceFolderSelected.emit();
  }

  onDestFolderSelect(): void {
    this.destFolderSelected.emit();
  }

  get configGroup(): FormGroup {
    return this.form.get(`${this.flagType}Config`) as FormGroup;
  }

  /**
   * Returns true if the current flagType matches the given type(s).
   * Usage: this.isType('mount') or this.isType(['sync', 'copy'])
   */
  isType(type: FlagType | FlagType[]): boolean {
    if (Array.isArray(type)) {
      return type.includes(this.flagType);
    }
    return this.flagType === type;
  }

  /**
   * Determines if folder selection should require empty folder
   * For mount operations, checks if AllowNonEmpty is set to true
   */
  get shouldRequireEmptyFolder(): boolean {
    if (this.isType('mount')) {
      const allowNonEmpty = this.configGroup?.get('options.AllowNonEmpty')?.value;
      const requireEmpty = !allowNonEmpty;
      return requireEmpty;
    }
    return false;
  }
}
