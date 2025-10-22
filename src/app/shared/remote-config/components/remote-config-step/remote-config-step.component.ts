import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
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
  ],
  templateUrl: './remote-config-step.component.html',
  styleUrl: './remote-config-step.component.scss',
})
export class RemoteConfigStepComponent implements OnInit, OnDestroy {
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
    }
  }

  @Output() remoteTypeChanged = new EventEmitter<void>();
  @Output() interactiveModeToggled = new EventEmitter<boolean>();

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
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onTypeSelected(value: string): void {
    this.form.get('type')?.setValue(value);
    this.onRemoteTypeChange();
  }

  // The filter logic now receives the list directly from the combined observable.
  private filterRemotes(types: RemoteType[], value: string): RemoteType[] {
    const filterValue = value.toLowerCase();
    return types.filter(
      remote =>
        remote.label.toLowerCase().includes(filterValue) ||
        remote.value.toLowerCase().includes(filterValue)
    );
  }

  // This function is now highly performant thanks to the Map lookup.
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
  }

  toggleInteractiveMode(): void {
    this.useInteractiveMode = !this.useInteractiveMode;
    this.interactiveModeToggled.emit(this.useInteractiveMode);
  }

  onRemoteTypeChange(): void {
    this.remoteTypeChanged.emit();
  }
}
