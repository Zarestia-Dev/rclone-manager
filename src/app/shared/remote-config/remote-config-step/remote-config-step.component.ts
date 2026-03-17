import {
  Component,
  effect,
  input,
  output,
  signal,
  computed,
  untracked,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';

import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RcConfigOption, RemoteType, RemoteConfigStepVisibility } from '@app/types';
import { SettingControlComponent } from 'src/app/shared/components';
import { startWith } from 'rxjs/operators';
import { TranslateModule } from '@ngx-translate/core';
import { MatIcon } from '@angular/material/icon';
import { IconService } from '@app/services';

@Component({
  selector: 'app-remote-config-step',
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatAutocompleteModule,
    SettingControlComponent,
    TranslateModule,
    MatIcon,
  ],
  templateUrl: './remote-config-step.component.html',
  styleUrl: './remote-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigStepComponent {
  // --- Signal Inputs ---
  form = input.required<FormGroup>();
  remoteFields = input<RcConfigOption[]>([]);
  isLoading = input(false);
  existingRemotes = input<string[]>([]);
  isTypeLocked = input(false);
  useInteractiveMode = input(false);
  remoteTypes = input<RemoteType[]>([]);
  visibility = input<RemoteConfigStepVisibility>({});
  showTypeField = computed(() => this.visibility().type ?? true);
  showAdvancedToggle = computed(() => this.visibility().advanced ?? true);
  showNameField = computed(() => this.visibility().name ?? true);
  showInteractiveToggle = computed(() => this.visibility().interactive ?? true);
  searchQuery = input('');

  // --- Signal Outputs ---
  remoteTypeChanged = output<void>();
  interactiveModeToggled = output<boolean>();
  advancedOptionsToggled = output<boolean>();
  fieldChanged = output<{ fieldName: string; isChanged: boolean }>();

  // --- Local Form Controls ---
  remoteSearchCtrl = new FormControl('');
  providerSearchCtrl = new FormControl('');

  // --- Local Signals ---
  showAdvancedOptions = input(false);
  selectedProvider = signal<string | undefined>(undefined);

  private remoteSearchTerm = toSignal(this.remoteSearchCtrl.valueChanges, {
    initialValue: this.remoteSearchCtrl.value ?? '',
  });
  private providerSearchTerm = toSignal(this.providerSearchCtrl.valueChanges, {
    initialValue: this.providerSearchCtrl.value ?? '',
  });

  readonly iconService = inject(IconService);

  constructor() {
    // Sync Provider control value -> Signal mapping
    effect(onCleanup => {
      const fieldDef = this.providerField();
      if (!fieldDef) return;

      const control = this.form().get(fieldDef.Name);
      if (!control) return;

      // Manually subscribe since the control instance can change
      const sub = control.valueChanges.pipe(startWith(control.value)).subscribe(val => {
        const oldVal = untracked(this.selectedProvider);
        if (val !== oldVal) {
          untracked(() => {
            this.selectedProvider.set(val);
            if (oldVal) {
              this.clearProviderDependentFields(this.remoteFields(), this.form(), val);
            }
            // Sync search control
            if (val !== this.providerSearchCtrl.value) {
              this.providerSearchCtrl.setValue(val, { emitEvent: false });
            }
          });
        }
      });

      onCleanup(() => sub.unsubscribe());
    });

    // Sync Type control value -> local search control
    effect(onCleanup => {
      const typeControl = this.form().get('type');
      if (!typeControl) return;

      const sub = typeControl.valueChanges.pipe(startWith(typeControl.value)).subscribe(val => {
        this.remoteSearchCtrl.setValue(this.displayRemote(val), {
          emitEvent: false,
        });
      });

      onCleanup(() => sub.unsubscribe());
    });

    effect(() => {
      const isLocked = this.isTypeLocked();
      untracked(() => {
        if (isLocked) {
          this.remoteSearchCtrl.disable({ emitEvent: false });
        } else {
          this.remoteSearchCtrl.enable({ emitEvent: false });
        }
      });
    });
  }

  // --- Computed State ---
  /** Filtered list of remotes based on search term */
  filteredRemotes = computed(() => {
    const types = this.remoteTypes();
    const term = (this.remoteSearchTerm() || '').toLowerCase();
    return types.filter(
      remote =>
        remote.label.toLowerCase().includes(term) || remote.value.toLowerCase().includes(term)
    );
  });

  /** The identified provider field configuration */
  providerField = computed(() => {
    const fields = this.remoteFields();
    let f = fields.find(f => f.Name === 'provider' && f.Examples && f.Examples.length > 0);
    if (!f) {
      f = fields.find(
        x => x.Examples && x.Examples.length > 0 && fields.some(other => other.Provider)
      );
    }
    return f || null;
  });

  /** Filtered provider examples */
  filteredProviders = computed(() => {
    const field = this.providerField();
    if (!field || !field.Examples) return [];

    const term = (this.providerSearchTerm() || '').toLowerCase();
    return field.Examples.filter(
      opt =>
        (opt.Value && opt.Value.toLowerCase().includes(term)) ||
        (opt.Help && opt.Help.toLowerCase().includes(term))
    );
  });

  basicFields = computed(() => {
    return this.getFieldsByAdvanced(false);
  });

  /** Advanced config fields, filtered by selected provider and search query */
  advancedFields = computed(() => {
    return this.getFieldsByAdvanced(true);
  });

  providerReady = computed(() => !this.providerField() || !!this.selectedProvider());

  // --- Logic Helpers ---

  private matchesProviderRule(rule: string | undefined, provider?: string): boolean {
    if (!rule) return true;
    if (!provider) return false;
    const isNegated = rule.startsWith('!');
    const parts = (isNegated ? rule.substring(1) : rule).split(',').map(p => p.trim());
    return isNegated ? !parts.includes(provider) : parts.includes(provider);
  }

  private getFilteredField(field: RcConfigOption, provider?: string): RcConfigOption {
    if (!field.Examples || field.Examples.length === 0 || !provider) {
      return field;
    }
    const filteredExamples = field.Examples.filter(ex =>
      this.matchesProviderRule(ex.Provider, provider)
    );
    return { ...field, Examples: filteredExamples };
  }

  private matchesSearch(field: RcConfigOption, query: string): boolean {
    if (!query) return true;
    const normalized = query.toLowerCase();
    return (
      field.Name?.toLowerCase().includes(normalized) ||
      field.FieldName?.toLowerCase().includes(normalized) ||
      field.Help?.toLowerCase().includes(normalized)
    );
  }

  private getFieldsByAdvanced(isAdvanced: boolean): RcConfigOption[] {
    const providerName = this.providerField()?.Name;
    const currentProvider = this.selectedProvider();
    const query = this.searchQuery().trim();

    return this.remoteFields()
      .filter(f => !!f.Advanced === isAdvanced)
      .filter(f => f.Name !== providerName)
      .filter(f => this.matchesProviderRule(f.Provider, currentProvider))
      .map(f => this.getFilteredField(f, currentProvider))
      .filter(f => this.matchesSearch(f, query));
  }

  private clearProviderDependentFields(
    fields: RcConfigOption[],
    form: FormGroup,
    newProvider: string
  ): void {
    fields.forEach(field => {
      if (field.Provider && !this.matchesProviderRule(field.Provider, newProvider)) {
        form.get(field.Name)?.setValue(null);
      }

      if (field.Examples && field.Examples.length > 0) {
        const control = form.get(field.Name);
        const currentValue = control?.value;
        if (currentValue && !this.isValueValidForProvider(field, currentValue, newProvider)) {
          control?.setValue('');
        }
      }
    });
  }

  private isValueValidForProvider(field: RcConfigOption, value: string, provider: string): boolean {
    const match = field.Examples?.find(ex => ex.Value === value);
    return !(match && !this.matchesProviderRule(match.Provider, provider));
  }

  // --- Template Bindings ---

  onTypeSelected(value: string): void {
    this.form().get('type')?.setValue(value);
    this.generateRemoteName(value);
    this.remoteTypeChanged.emit();
  }

  private generateRemoteName(remoteType: string): void {
    const nameControl = this.form().get('name');
    // Only auto-generate if the field is empty or hasn't been manually edited
    if (!nameControl || (nameControl.value && nameControl.dirty)) {
      return;
    }

    const baseName = remoteType.replace(/\s+/g, '');
    const existingNames = new Set(this.existingRemotes());
    let newName = baseName;
    let counter = 1;

    while (existingNames.has(newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    nameControl.setValue(newName, { emitEvent: true });
    nameControl.updateValueAndValidity({ emitEvent: false });

    // If auto-generated value still fails validation, show the reason immediately.
    if (nameControl.invalid) {
      nameControl.markAsTouched();
    }
  }

  displayRemote = (remoteValue: string): string => {
    if (!remoteValue) return '';
    return this.remoteTypes().find(t => t.value === remoteValue)?.label || remoteValue;
  };

  displayProvider = (value: string): string => {
    const field = this.providerField();
    if (!field?.Examples) return value;
    const option = field.Examples.find(o => o.Value === value);
    return option ? option.Help : value;
  };

  toggleAdvancedOptions(): void {
    const newValue = !this.showAdvancedOptions();
    this.advancedOptionsToggled.emit(newValue);
  }

  toggleInteractiveMode(): void {
    const newValue = !this.useInteractiveMode();
    this.interactiveModeToggled.emit(newValue);
  }

  onProviderSelected(value: string): void {
    const field = this.providerField();
    if (field) {
      this.form().get(field.Name)?.setValue(value);
    }
  }

  onFieldChanged(fieldName: string, isChanged: boolean): void {
    this.fieldChanged.emit({ fieldName, isChanged });
  }
}
