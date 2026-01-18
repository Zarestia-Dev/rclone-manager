import {
  Component,
  effect,
  input,
  output,
  signal,
  computed,
  untracked,
  OnDestroy,
  inject,
} from '@angular/core';

import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { RcConfigOption, RemoteType } from '@app/types';
import { SettingControlComponent } from 'src/app/shared/components';
import { startWith } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { TranslateModule } from '@ngx-translate/core';
import { MatIcon } from '@angular/material/icon';
import { IconService } from '@app/services';

@Component({
  selector: 'app-remote-config-step',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatAutocompleteModule,
    SettingControlComponent,
    ScrollingModule,
    TranslateModule,
    MatIcon,
  ],
  templateUrl: './remote-config-step.component.html',
  styleUrl: './remote-config-step.component.scss',
})
export class RemoteConfigStepComponent implements OnDestroy {
  // --- Signal Inputs ---
  form = input.required<FormGroup>();
  remoteFields = input<RcConfigOption[]>([]);
  isLoading = input(false);
  existingRemotes = input<string[]>([]);
  restrictMode = input(false);
  useInteractiveMode = input(false);
  remoteTypes = input<RemoteType[]>([]);
  showAdvancedToggle = input(true); // Hide advanced toggle for quick-add modal

  // --- Signal Outputs ---
  remoteTypeChanged = output<void>();
  interactiveModeToggled = output<boolean>();
  fieldChanged = output<{ fieldName: string; isChanged: boolean }>();

  // --- Local Form Controls ---
  remoteSearchCtrl = new FormControl('');
  providerSearchCtrl = new FormControl('');

  // --- Local Signals ---
  showAdvancedOptions = signal(false);
  selectedProvider = signal<string | undefined>(undefined);

  // Convert FormControls to Signals for use in computed
  private remoteSearchTerm = toSignal(this.remoteSearchCtrl.valueChanges.pipe(startWith('')), {
    initialValue: '',
  });
  private providerSearchTerm = toSignal(this.providerSearchCtrl.valueChanges.pipe(startWith('')), {
    initialValue: '',
  });

  private providerSub?: Subscription;
  readonly iconService = inject(IconService);

  constructor() {
    // Effect 1: Detect Provider Field and sync with form
    effect(() => {
      const fields = this.remoteFields();
      const formGroup = this.form();

      // Clean up previous subscription
      if (this.providerSub) {
        this.providerSub.unsubscribe();
        this.providerSub = undefined;
      }

      // Logic to find which field acts as the "Provider" (e.g. AWS vs DigitalOcean for S3)
      let fieldDef = fields.find(f => f.Name === 'provider' && f.Examples && f.Examples.length > 0);
      if (!fieldDef) {
        fieldDef = fields.find(
          f => f.Examples && f.Examples.length > 0 && fields.some(other => other.Provider)
        );
      }

      if (fieldDef) {
        const control = formGroup.get(fieldDef.Name);
        if (control) {
          // Sync initial value without triggering cycles
          untracked(() => {
            const currentVal = control.value || fieldDef?.DefaultStr || fieldDef?.Default;
            this.selectedProvider.set(currentVal);

            // Ensure our local search control matches the form's value
            if (currentVal && currentVal !== this.providerSearchCtrl.value) {
              this.providerSearchCtrl.setValue(currentVal, { emitEvent: false });
            }

            // If the main form control is empty but we have a default, set it
            if (!control.value && currentVal) {
              control.setValue(currentVal, { emitEvent: true });
            }
          });

          // Subscribe to future changes
          this.providerSub = control.valueChanges.subscribe(newProviderValue => {
            const oldProviderValue = this.selectedProvider();
            this.selectedProvider.set(newProviderValue);

            if (oldProviderValue && newProviderValue !== oldProviderValue) {
              this.clearProviderDependentFields(fields, formGroup, newProviderValue);
            }

            // Sync search control
            if (newProviderValue && newProviderValue !== this.providerSearchCtrl.value) {
              this.providerSearchCtrl.setValue(newProviderValue, { emitEvent: false });
            }
          });
        }
      }
    });

    // Effect 2: Sync Type Control state with Search Control
    effect(() => {
      const formGroup = this.form();
      const typeControl = formGroup.get('type');
      this.remoteTypes(); // Ensure dependency is tracked

      if (typeControl) {
        untracked(() => {
          const val = typeControl.value;
          if (val) {
            this.remoteSearchCtrl.setValue(this.displayRemote(val), { emitEvent: false });
          }

          if (typeControl.disabled) {
            this.remoteSearchCtrl.disable({ emitEvent: false });
          } else {
            this.remoteSearchCtrl.enable({ emitEvent: false });
          }
        });
      }
    });
  }

  ngOnDestroy(): void {
    this.providerSub?.unsubscribe();
  }

  // --- Computed State ---

  /** Map for O(1) label lookups */
  private remoteTypeMap = computed(() => {
    return new Map(this.remoteTypes().map(t => [t.value, t]));
  });

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

  /** Basic config fields, filtered by selected provider */
  basicFields = computed(() => {
    const fields = this.remoteFields();
    const providerName = this.providerField()?.Name;
    const currentProvider = this.selectedProvider();

    return fields
      .filter(f => !f.Advanced)
      .filter(f => f.Name !== providerName) // Don't show provider field here
      .filter(f => this.shouldShowField(f, currentProvider))
      .map(f => this.getFilteredField(f, currentProvider));
  });

  /** Advanced config fields, filtered by selected provider */
  advancedFields = computed(() => {
    const fields = this.remoteFields();
    const providerName = this.providerField()?.Name;
    const currentProvider = this.selectedProvider();

    return fields
      .filter(f => f.Advanced)
      .filter(f => f.Name !== providerName)
      .filter(f => this.shouldShowField(f, currentProvider))
      .map(f => this.getFilteredField(f, currentProvider));
  });

  /** Virtual Scroll Data Source */
  formFields = computed(() => {
    const fields = [];
    fields.push({ type: 'basic-info' });
    fields.push({ type: 'config-toggles' });

    if (this.providerField()) {
      fields.push({ type: 'provider-field' });
    }

    const hasBasic = this.basicFields().length > 0;
    // Show fields if no provider concept exists OR if a provider is selected
    const providerReady = !this.providerField() || this.selectedProvider();

    if (hasBasic && providerReady) {
      fields.push({ type: 'basic-fields' });
    }

    if (this.showAdvancedOptions() && this.advancedFields().length > 0 && providerReady) {
      fields.push({ type: 'advanced-section' });
    }

    return fields;
  });

  // --- Logic Helpers ---

  private shouldShowField(field: RcConfigOption, provider?: string): boolean {
    const providerRule = field.Provider;
    if (!providerRule) return true;
    if (!provider) return false;

    const isNegated = providerRule.startsWith('!');
    const cleanRule = isNegated ? providerRule.substring(1) : providerRule;
    const parts = cleanRule.split(',').map(p => p.trim());

    if (isNegated) {
      return !parts.includes(provider);
    } else {
      return parts.includes(provider);
    }
  }

  private getFilteredField(field: RcConfigOption, provider?: string): RcConfigOption {
    if (!field.Examples || field.Examples.length === 0 || !provider) {
      return field;
    }
    // Filter examples based on provider rule
    const filteredExamples = field.Examples.filter(ex =>
      this.isProviderMatch(ex.Provider, provider)
    );
    return { ...field, Examples: filteredExamples };
  }

  private isProviderMatch(rule: string | undefined, provider: string): boolean {
    if (!rule) return true;
    const isNegated = rule.startsWith('!');
    const cleanRule = isNegated ? rule.substring(1) : rule;
    const parts = cleanRule.split(',').map(p => p.trim());

    return isNegated ? !parts.includes(provider) : parts.includes(provider);
  }

  private clearProviderDependentFields(
    fields: RcConfigOption[],
    form: FormGroup,
    newProvider: string
  ): void {
    fields.forEach(field => {
      // If a field has a specific Provider rule, checks if it is still valid
      if (field.Provider) {
        const isVisible = this.shouldShowField(field, newProvider);
        if (!isVisible) {
          // Field is hidden now -> reset it
          form.get(field.Name)?.setValue(null);
        }
      }

      // If a field is shared (like 'endpoint') but the Examples list changed
      if (field.Examples && field.Examples.length > 0) {
        const control = form.get(field.Name);
        const currentValue = control?.value;

        // If the current value was one of the OLD examples, we should probably clear it
        // so the user doesn't accidentally send an Alibaba endpoint to AWS
        // (Optional: strict check logic could go here)
        if (currentValue && !this.isValueValidForProvider(field, currentValue, newProvider)) {
          control?.setValue(''); // Reset to empty so they pick a new one
        }
      }
    });
  }

  private isValueValidForProvider(field: RcConfigOption, value: string, provider: string): boolean {
    // If the value matches an Example that is NOT allowed for this provider, return false
    const match = field.Examples?.find(ex => ex.Value === value);
    if (match && match.Provider && !this.isProviderMatch(match.Provider, provider)) {
      return false;
    }
    return true;
  }

  // --- Template Bindings ---

  trackByField(index: number, field: { type: string }): string {
    return `${field.type}-${index}`;
  }

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
    const existingNames = this.existingRemotes();
    let newName = baseName;
    let counter = 1;

    while (existingNames.includes(newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    nameControl.setValue(newName, { emitEvent: true });
  }

  displayRemote(remoteValue: string): string {
    if (!remoteValue) return '';
    return this.remoteTypeMap().get(remoteValue)?.label || remoteValue;
  }

  displayProvider(value: string): string {
    const field = this.providerField();
    if (!field?.Examples) return value;
    const option = field.Examples.find(o => o.Value === value);
    return option ? option.Help : value;
  }

  toggleAdvancedOptions(): void {
    this.showAdvancedOptions.update(v => !v);
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
