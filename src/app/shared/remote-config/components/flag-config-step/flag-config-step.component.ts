import {
  Component,
  EventEmitter,
  Input,
  Output,
  OnInit,
  OnChanges,
  SimpleChanges,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Entry, FlagType } from '../../remote-config-types';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Observable, map, startWith } from 'rxjs';

import { RcConfigOption } from '@app/types'; // Assuming this path from setting-control.ts
import { SettingControlComponent } from 'src/app/shared/components';

@Component({
  selector: 'app-flag-config-step',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatAutocompleteModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    MatInputModule,
    SettingControlComponent,
  ],
  templateUrl: './flag-config-step.component.html',
  styleUrl: './flag-config-step.component.scss',
})
export class FlagConfigStepComponent implements OnInit, OnChanges {
  @Input() form!: FormGroup;
  @Input() flagType!: FlagType;
  @Input() isEditMode = false;
  @Input() existingRemotes: string[] = [];
  @Input() pathState: Record<
    string,
    { remoteName: string; currentPath: string; options: Entry[] }
  > = {};
  @Input() sourceLoading = false;
  @Input() destLoading = false;

  @Input() dynamicFlagFields: RcConfigOption[] = [];
  @Input() mountTypes: string[] = [];

  filteredDestRemotes$ = new Observable<string[]>();
  filteredSourceRemotes$ = new Observable<string[]>();

  @Output() destRemoteSelected = new EventEmitter<string>();
  @Output() sourceRemoteSelected = new EventEmitter<string>();
  @Output() destOptionSelected = new EventEmitter<string>();
  @Output() sourceOptionSelected = new EventEmitter<string>();
  @Output() folderSelected = new EventEmitter<{
    formPath: string;
    requiredEmpty: boolean;
  }>();
  @Output() remoteSelectionReset = new EventEmitter<string>();

  public showAdvancedOptions = false;

  ngOnInit(): void {
    this.initializeFilteredRemotes();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // When inputs arrive/ change (form, flagType, existingRemotes) reinitialize filters
    if (changes['form'] || changes['flagType'] || changes['existingRemotes']) {
      this.initializeFilteredRemotes();
    }
  }

  private initializeFilteredRemotes(): void {
    const destControl = this.configGroup?.get('dest');
    if (destControl) {
      this.filteredDestRemotes$ = destControl.valueChanges.pipe(
        startWith(destControl.value || ''),
        map(value => this._filterRemotes(value || ''))
      );
    } else {
      this.filteredDestRemotes$ = new Observable(observer => {
        observer.next(this.existingRemotes);
      });
    }

    const sourceControl = this.configGroup?.get('source');
    if (sourceControl) {
      this.filteredSourceRemotes$ = sourceControl.valueChanges.pipe(
        startWith(sourceControl.value || ''),
        map(value => this._filterRemotes(value || ''))
      );
    } else {
      this.filteredSourceRemotes$ = new Observable(observer => {
        observer.next(this.existingRemotes);
      });
    }
  }

  private _filterRemotes(value: string): string[] {
    if (!value || value.includes('://') || value.includes(':/')) {
      return this.existingRemotes;
    }

    const filterValue = value.toLowerCase();
    return this.existingRemotes.filter(remote => remote.toLowerCase().includes(filterValue));
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
      const allowNonEmpty = this.configGroup?.get('AllowNonEmpty')?.value;
      const requireEmpty = !allowNonEmpty;
      return requireEmpty;
    }
    return false;
  }

  onDestOptionSelected(option: string): void {
    // Check if this is a remote selection (contains :/ but no path after)
    if (option.includes(':/') && (option.endsWith(':/') || option.match(/^[^:]+:\/$/))) {
      // This is a remote selection - emit to destRemoteSelected
      this.destRemoteSelected.emit(option);
    } else {
      // This is a path selection - emit to destOptionSelected
      this.destOptionSelected.emit(option);
    }
  }

  onSourceOptionSelected(option: string): void {
    // Check if this is a remote selection (contains :/ but no path after)
    if (option.includes(':/') && (option.endsWith(':/') || option.match(/^[^:]+:\/$/))) {
      // This is a remote selection - emit to sourceRemoteSelected
      this.sourceRemoteSelected.emit(option);
    } else {
      // This is a path selection - emit to sourceOptionSelected
      this.sourceOptionSelected.emit(option);
    }
  }

  onSelectFolder(formPath: string, requiredEmpty: boolean): void {
    this.folderSelected.emit({ formPath, requiredEmpty });
  }

  onResetRemoteSelection(formPath: string): void {
    this.remoteSelectionReset.emit(formPath);
  }
}
