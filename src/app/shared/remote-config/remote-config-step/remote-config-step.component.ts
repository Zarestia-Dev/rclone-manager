import {
  ChangeDetectionStrategy,
  ChangeDetectorRef, // Add this import
  Component,
  EventEmitter,
  inject,
  Input,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RcConfigOption, RemoteType } from '@app/types';
import { SettingControlComponent } from 'src/app/shared/components';
import { Observable, ReplaySubject, Subject, combineLatest } from 'rxjs';
import { map, startWith } from 'rxjs/operators';
import { ScrollingModule } from '@angular/cdk/scrolling';

@Component({
  selector: 'app-remote-config-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatAutocompleteModule,
    SettingControlComponent,
    ScrollingModule,
  ],
  templateUrl: './remote-config-step.component.html',
  styleUrl: './remote-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigStepComponent implements OnInit, OnDestroy {
  cdRef = inject(ChangeDetectorRef);

  @Input() form!: FormGroup;
  @Input() remoteFields: RcConfigOption[] = [];
  @Input() isLoading = false;
  @Input() existingRemotes: string[] = [];
  @Input() restrictMode!: boolean;
  @Input() useInteractiveMode = false;

  private remoteTypes$ = new ReplaySubject<RemoteType[]>(1);
  @Input()
  set remoteTypes(types: RemoteType[]) {
    if (types && types.length > 0) {
      this.remoteTypes$.next(types);
      this.remoteTypeMap = new Map(types.map(t => [t.value, t]));
      this.cdRef.markForCheck(); // Mark for check when remote types change
    }
  }

  @Output() remoteTypeChanged = new EventEmitter<void>();
  @Output() interactiveModeToggled = new EventEmitter<boolean>();
  @Output() fieldChanged = new EventEmitter<{ fieldName: string; isChanged: boolean }>();

  remoteSearchCtrl = new FormControl('');
  filteredRemotes$!: Observable<RemoteType[]>;
  showAdvancedOptions = false;

  private remoteTypeMap = new Map<string, RemoteType>();
  private destroy$ = new Subject<void>();

  ngOnInit(): void {
    const searchTerm$ = this.remoteSearchCtrl.valueChanges.pipe(startWith(''));
    this.filteredRemotes$ = combineLatest([this.remoteTypes$, searchTerm$]).pipe(
      map(([types, term]) => this.filterRemotes(types, term || ''))
    );
    const initialTypeValue = this.form.get('type')?.value;
    if (initialTypeValue) {
      this.remoteSearchCtrl.setValue(initialTypeValue, { emitEvent: false });
    }

    const typeControl = this.form.get('type');
    if (typeControl?.disabled) {
      this.remoteSearchCtrl.disable();
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // Get all form fields as an array for virtual scrolling
  get formFields(): any[] {
    const fields = [];

    // Always include the basic fields (name and type)
    fields.push({ type: 'basic-info' });

    // Configuration toggles (if there are remote fields)
    if (this.remoteFields.length > 0) {
      fields.push({ type: 'config-toggles' });
    }

    // Basic configuration fields
    if (this.basicFields.length > 0) {
      fields.push({ type: 'basic-fields' });
    }

    // Advanced options section
    if (this.showAdvancedOptions && this.advancedFields.length > 0) {
      fields.push({ type: 'advanced-section' });
    }

    return fields;
  }

  // Track by function for virtual scrolling
  trackByField(index: number, field: any): string {
    return `${field.type}-${index}`;
  }

  onTypeSelected(value: string): void {
    this.form.get('type')?.setValue(value);
    this.onRemoteTypeChange();
  }

  private filterRemotes(types: RemoteType[], value: string): RemoteType[] {
    const filterValue = value.toLowerCase();
    return types.filter(
      remote =>
        remote.label.toLowerCase().includes(filterValue) ||
        remote.value.toLowerCase().includes(filterValue)
    );
  }

  displayRemote(remoteValue: string): string {
    if (!remoteValue) return '';
    return this.remoteTypeMap.get(remoteValue)?.label || '';
  }

  get basicFields(): RcConfigOption[] {
    return this.remoteFields.filter(f => !f.Advanced);
  }

  get advancedFields(): RcConfigOption[] {
    return this.remoteFields.filter(f => f.Advanced);
  }

  toggleAdvancedOptions(): void {
    this.showAdvancedOptions = !this.showAdvancedOptions;
    // Mark for check since we're changing a property that affects the template
    this.cdRef.markForCheck();
  }

  toggleInteractiveMode(): void {
    this.useInteractiveMode = !this.useInteractiveMode;
    this.interactiveModeToggled.emit(this.useInteractiveMode);
    // Mark for check since we're changing a property that affects the template
    this.cdRef.markForCheck();
  }

  onRemoteTypeChange(): void {
    this.remoteTypeChanged.emit();
  }

  onFieldChanged(fieldName: string, isChanged: boolean): void {
    this.fieldChanged.emit({ fieldName, isChanged });
  }
}
