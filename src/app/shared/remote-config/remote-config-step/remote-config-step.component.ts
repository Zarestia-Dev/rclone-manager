import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  inject,
  Input,
  OnDestroy,
  OnInit,
  Output,
  OnChanges,
  SimpleChanges,
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
import { map, startWith, takeUntil } from 'rxjs/operators';
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
export class RemoteConfigStepComponent implements OnInit, OnDestroy, OnChanges {
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
  selectedProvider?: string;
  private providerFieldName?: string = 'provider';

  private remoteTypeMap = new Map<string, RemoteType>();
  private destroy$ = new Subject<void>();

  ngOnInit(): void {
    this.detectProviderField();
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

  ngOnChanges(changes: SimpleChanges): void {
    // Re-detect provider field when remoteFields change
    if (changes['remoteFields'] && this.remoteFields.length > 0) {
      setTimeout(() => {
        this.detectProviderField();
      }, 100);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
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

  private detectProviderField(): void {
    let providerField = this.remoteFields.find(
      f => f.Name === 'provider' && f.Examples && f.Examples.length > 0
    );

    if (!providerField) {
      providerField = this.remoteFields.find(
        f => f.Examples && f.Examples.length > 0 && this.remoteFields.some(other => other.Provider)
      );
    }

    if (!providerField) {
      return;
    }

    this.providerFieldName = providerField.Name;
    const providerControl = this.form.get(providerField.Name);

    if (!providerControl) {
      return;
    }

    providerControl.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(value => {
      this.selectedProvider = value;
      this.cdRef.markForCheck();
    });

    const currentValue = providerControl.value;
    this.selectedProvider =
      currentValue ||
      providerField.DefaultStr ||
      providerField.Default ||
      providerField.Examples?.[0]?.Value;

    if (!currentValue && this.selectedProvider) {
      providerControl.setValue(this.selectedProvider, { emitEvent: true });
    }
  }

  get providerField(): RcConfigOption | null {
    if (!this.providerFieldName) return null;
    return this.remoteFields.find(f => f.Name === this.providerFieldName) || null;
  }

  get basicFields(): RcConfigOption[] {
    return this.remoteFields
      .filter(f => !f.Advanced)
      .filter(f => f.Name !== this.providerFieldName)
      .filter(f => this.shouldShowField(f));
  }

  get advancedFields(): RcConfigOption[] {
    return this.remoteFields
      .filter(f => f.Advanced)
      .filter(f => f.Name !== this.providerFieldName)
      .filter(f => this.shouldShowField(f));
  }

  /**
   * Determines if a field should be shown based on the selected provider.
   * Handles comma-separated lists and negated lists (starting with '!').
   */
  private shouldShowField(field: RcConfigOption): boolean {
    const providerRule = field.Provider;

    // 1. If the field has no provider rule, always show it.
    if (!providerRule) {
      return true;
    }

    // 2. If a provider rule exists but no provider has been selected yet, hide the field.
    if (!this.selectedProvider) {
      return false;
    }

    const isNegated = providerRule.startsWith('!');
    // 3. Clean the rule: remove '!' and split into an array, trimming whitespace from each item.
    const providers = (isNegated ? providerRule.substring(1) : providerRule)
      .split(',')
      .map(p => p.trim());

    // 4. Apply the logic.
    if (isNegated) {
      // If the rule is negated, show the field if the selected provider is NOT in the list.
      // e.g., rule "!Storj,Ceph" -> show if provider is "Minio", hide if it's "Storj".
      return !providers.includes(this.selectedProvider);
    } else {
      // If the rule is inclusive, show the field if the selected provider IS in the list.
      // e.g., rule "AWS,Minio" -> show if provider is "AWS", hide if it's "Storj".
      return providers.includes(this.selectedProvider);
    }
  }

  get formFields(): any[] {
    const fields = [];
    fields.push({ type: 'basic-info' });

    if (this.remoteFields.length > 0) {
      fields.push({ type: 'config-toggles' });
    }

    if (this.providerField) {
      fields.push({ type: 'provider-field' });
    }

    if (this.basicFields.length > 0 && (!this.providerField || this.selectedProvider)) {
      fields.push({ type: 'basic-fields' });
    }

    if (
      this.showAdvancedOptions &&
      this.advancedFields.length > 0 &&
      (!this.providerField || this.selectedProvider)
    ) {
      fields.push({ type: 'advanced-section' });
    }

    return fields;
  }
}
