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
import { startWith } from 'rxjs';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { RcConfigOption, RemoteType, RemoteConfigStepVisibility, CommandOption } from '@app/types';
import { IconService } from 'src/app/services/ui/icon.service';
import { matchesConfigSearch } from 'src/app/services/remote/utils/remote-config.utils';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { JsonEditorComponent } from 'src/app/shared/components/json-editor/json-editor.component';
import { SettingControlComponent } from 'src/app/shared/components/setting-control/setting-control.component';
import {
  INITIAL_COMMAND_OPTIONS,
  syncNonInteractiveOption,
} from 'src/app/services/remote/utils/command-options.util';
import { findUniqueName } from 'src/app/services/remote/utils/unique-name.util';

import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

import {
  isProviderReady,
  matchesProviderRule,
  resolveProviderField,
} from 'src/app/services/remote/utils/config-metadata.utils';
import { ConfigCommandOptionsComponent } from '../config-command-options/config-command-options.component';
import { ConfigFormSkeletonComponent } from 'src/app/shared/remote-config/config-form-skeleton/config-form-skeleton.component';
import { generatePrefixedId } from 'src/app/shared/utils';
import { MatDivider } from '@angular/material/divider';
import {
  getProviderTier,
  PROVIDER_SUMMARY_FEATURES,
  REMOTE_FEATURE_LABEL_KEYS,
} from 'src/app/services/remote/utils/provider-metadata.utils';

@Component({
  selector: 'app-remote-config-step',
  imports: [
    ConfigFormSkeletonComponent,
    ConfigCommandOptionsComponent,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatAutocompleteModule,
    MatButtonModule,
    SettingControlComponent,
    JsonEditorComponent,
    TranslatePipe,
    MatIcon,
    MatDivider,
  ],
  templateUrl: './remote-config-step.component.html',
  styleUrl: './remote-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigStepComponent {
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly iconService = inject(IconService);
  private readonly uiStateService = inject(UiStateService);

  // ── Inputs ─────────────────

  readonly form = input.required<FormGroup>();
  readonly remoteFields = input<RcConfigOption[]>([]);
  readonly isLoading = input<boolean>(false);
  readonly existingRemotes = input<string[]>([]);
  readonly isTypeLocked = input(false);
  readonly isNameLocked = input(false);
  readonly remoteTypes = input<RemoteType[]>([]);
  readonly visibility = input<RemoteConfigStepVisibility>({});
  readonly showAdvancedOptions = input<boolean>(false);
  readonly autoObscure = input(false);
  readonly disabled = input(false);
  readonly searchQuery = input<string>('');
  readonly initialCommandOptions = input<CommandOption[]>(INITIAL_COMMAND_OPTIONS);

  // ── Outputs ───────────────────────────────────────────────────────────────

  readonly remoteTypeChanged = output<void>();
  readonly advancedOptionsToggled = output<boolean>();
  readonly fieldChanged = output<{ fieldName: string; isChanged: boolean }>();
  readonly commandOptionsChanged = output<CommandOption[]>();

  // ── Visibility ────────────────────────────────────────────────────────────

  readonly showTypeField = computed(() => this.visibility().type ?? true);
  readonly showAdvancedToggle = computed(() => this.visibility().advanced ?? true);
  readonly showNameField = computed(() => this.visibility().name ?? true);
  readonly showCommandField = computed(() => this.visibility().commands !== false);

  // ── Local form controls ───────────────────────────────────────────────────

  readonly remoteSearchCtrl = new FormControl('');
  readonly providerSearchCtrl = new FormControl('');

  readonly remoteTypeValue = signal('');

  private readonly remoteSearchTerm = toSignal(this.remoteSearchCtrl.valueChanges, {
    initialValue: this.remoteSearchCtrl.value ?? '',
  });

  private readonly providerSearchTerm = toSignal(this.providerSearchCtrl.valueChanges, {
    initialValue: this.providerSearchCtrl.value ?? '',
  });

  // ── Signals ───────────────────────────────────────────────────────────────

  readonly selectedProvider = signal<string | undefined>(undefined);
  readonly showJsonMode = this.uiStateService.showJsonMode;
  readonly showCommandOptions = signal(false);
  readonly showProviderOverview = signal(false);
  readonly providerOverviewId = generatePrefixedId('provider-overview');
  readonly commandOptions = signal<CommandOption[]>(INITIAL_COMMAND_OPTIONS);
  readonly randomIcon = signal('cloud');
  readonly animTrigger = signal(0);
  readonly suggestedRemotes = signal<{ label: string; value: string; icon: string }[]>([]);

  // ── Computed View Models ──────────────────────────────────────────────────

  readonly remoteTypeIcon = computed(() =>
    this.iconService.getIconName(this.remoteTypeValue() || 'hard-drive')
  );
  readonly currentProviderIcon = computed(() =>
    this.iconService.getIconName(this.selectedProvider() || 'hard-drive')
  );

  readonly remoteTypesWithIcons = computed(() =>
    this.remoteTypes().map(r => ({ ...r, icon: this.iconService.getIconName(r.value) }))
  );

  readonly filteredRemotes = computed(() => {
    const term = (this.remoteSearchTerm() ?? '').toLowerCase();
    return this.remoteTypesWithIcons().filter(
      r => r.label.toLowerCase().includes(term) || r.value.toLowerCase().includes(term)
    );
  });

  readonly providerField = computed(() => resolveProviderField(this.remoteFields()));

  readonly providerOverview = computed(
    () => this.remoteTypes().find(type => type.value === this.remoteTypeValue())?.overview
  );

  readonly providerTier = computed(() => getProviderTier(this.providerOverview()?.Tier));

  readonly providerCapabilities = computed(() => {
    const overview = this.providerOverview();
    if (overview?.Virtual) return [];
    const features = overview?.Features ?? [];
    return PROVIDER_SUMMARY_FEATURES.filter(feature => features.includes(feature)).map(
      feature => REMOTE_FEATURE_LABEL_KEYS[feature]
    );
  });

  readonly filteredProvidersView = computed(() => {
    const field = this.providerField();
    if (!field?.Examples) return [];
    const term = (this.providerSearchTerm() ?? '').toLowerCase();
    return field.Examples.filter(
      o => o.Value?.toLowerCase().includes(term) || o.Help?.toLowerCase().includes(term)
    ).map(o => ({
      ...o,
      icon: this.iconService.getIconName(o.Value || 'hard-drive'),
    }));
  });

  readonly basicFields = computed(() => this.getFieldsByAdvanced(false));
  readonly advancedFields = computed(() => this.getFieldsByAdvanced(true));

  readonly providerReady = computed(() =>
    isProviderReady(this.remoteTypeValue(), this.providerField(), this.selectedProvider())
  );

  readonly jsonExcludeKeys = ['name', 'type'];

  readonly showObscureButton = computed(() => {
    const options = this.commandOptions();
    return (
      !this.autoObscure() ||
      !options.some(option => option.key === 'obscure' && option.value === true) ||
      options.some(option => option.key === 'noObscure' && option.value === true)
    );
  });

  // ── Effects ───────────────────────────────────────────────────────────────

  constructor() {
    // Track remote type control value changes
    effect(onCleanup => {
      const form = this.form();
      const typeCtrl = form?.get('type');
      if (!typeCtrl) return;

      const updateType = (value: string): void => {
        if (untracked(this.remoteTypeValue) !== (value || '')) this.showProviderOverview.set(false);
        this.remoteTypeValue.set(value || '');
        this.remoteSearchCtrl.setValue(this.displayRemote(value), { emitEvent: false });
      };
      updateType(typeCtrl.value);
      const sub = typeCtrl.valueChanges.subscribe(updateType);
      onCleanup(() => sub.unsubscribe());
    });

    // Emit command options changes (skip initial)
    let isFirstCommandOptionsRun = true;
    effect(() => {
      const opts = this.commandOptions();
      if (isFirstCommandOptionsRun) {
        isFirstCommandOptionsRun = false;
        return;
      }
      this.commandOptionsChanged.emit(opts);
    });

    effect(() => {
      const initial = this.initialCommandOptions();
      untracked(() => this.commandOptions.set(initial));
    });

    effect(onCleanup => {
      const fieldDef = this.providerField();
      if (!fieldDef) {
        this.selectedProvider.set(undefined);
        return;
      }

      const control = this.form().get(fieldDef.Name);
      if (!control) return;

      const sub = control.valueChanges.pipe(startWith(control.value)).subscribe(val => {
        const prev = untracked(this.selectedProvider);
        if (val === prev) return;

        untracked(() => {
          this.selectedProvider.set(val);
          if (prev) this.clearProviderDependentFields(this.remoteFields(), this.form(), val);

          const display = this.displayProvider(val);
          if (display !== this.providerSearchCtrl.value) {
            this.providerSearchCtrl.setValue(display, { emitEvent: false });
          }
        });
      });

      onCleanup(() => sub.unsubscribe());
    });

    effect(() => {
      const opts = { emitEvent: false } as const;
      if (this.isTypeLocked() || this.disabled()) {
        this.remoteSearchCtrl.disable(opts);
      } else {
        this.remoteSearchCtrl.enable(opts);
      }
    });

    effect(() => {
      const opts = { emitEvent: false } as const;
      const nameControl = this.form().get('name');
      if (!nameControl) return;

      if (this.isNameLocked() || this.disabled()) {
        nameControl.disable(opts);
      } else {
        nameControl.enable(opts);
      }
    });

    effect(() => {
      const fields = this.remoteFields();
      const provider = this.selectedProvider();
      const form = this.form();
      if (this.disabled() || form.disabled) return;
      untracked(() => {
        for (const field of fields) {
          if (!field.Provider) continue;
          const control = form.get(field.Name || field.FieldName);
          if (!control) continue;
          const visible = matchesProviderRule(field.Provider, provider);
          if (visible && control.disabled) control.enable({ emitEvent: false });
          else if (!visible && control.enabled) control.disable({ emitEvent: false });
        }
        form.updateValueAndValidity();
      });
    });

    effect(() => {
      const types = this.remoteTypesWithIcons();
      if (types.length > 0 && untracked(this.suggestedRemotes).length === 0) {
        this.suggestedRemotes.set(this.shuffleSample(types));
      }
    });

    effect(() => {
      if (!this.showCommandField()) return;
      const isInteractive = this.remoteManagementService.isInteractiveRemote(
        this.remoteTypeValue()
      );

      untracked(() => {
        const current = this.commandOptions();
        const next = syncNonInteractiveOption(current, isInteractive);
        if (next !== current) this.commandOptions.set(next);
      });
    });

    effect(onCleanup => {
      if (!this.showTypeField() || this.remoteTypeValue() || this.isLoading()) {
        this.randomIcon.set('cloud');
        this.animTrigger.set(0);
        return;
      }
      const types = this.remoteTypesWithIcons();
      if (!types.length) return;

      const timer = setInterval(() => {
        const alternatives = types.filter(type => type.icon !== this.randomIcon());
        const candidates = alternatives.length ? alternatives : types;
        this.randomIcon.set(candidates[Math.floor(Math.random() * candidates.length)].icon);
        this.animTrigger.update(value => value + 1);
      }, 3000);
      onCleanup(() => clearInterval(timer));
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private getFilteredField(field: RcConfigOption, provider?: string): RcConfigOption {
    if (!field.Examples?.length || !provider) return field;
    return {
      ...field,
      Examples: field.Examples.filter(ex => matchesProviderRule(ex.Provider, provider)),
    };
  }

  private getFieldsByAdvanced(isAdvanced: boolean): RcConfigOption[] {
    const providerName = this.providerField()?.Name;
    const currentProvider = this.selectedProvider();
    const query = this.searchQuery().trim();

    return this.remoteFields()
      .filter(f => !!f.Advanced === isAdvanced)
      .filter(f => f.Name !== providerName)
      .filter(f => matchesProviderRule(f.Provider, currentProvider))
      .map(f => this.getFilteredField(f, currentProvider))
      .filter(f => matchesConfigSearch(f, query));
  }

  private clearProviderDependentFields(
    fields: RcConfigOption[],
    form: FormGroup,
    newProvider: string
  ): void {
    for (const field of fields) {
      const control = form.get(field.Name);
      if (!control) continue;

      if (field.Provider && !matchesProviderRule(field.Provider, newProvider)) {
        control.setValue(null);
        continue;
      }

      if (field.Examples?.length) {
        const current = control.value;
        if (current && !this.isValueValidForProvider(field, current, newProvider)) {
          control.setValue('');
        }
      }
    }
  }

  private isValueValidForProvider(field: RcConfigOption, value: string, provider: string): boolean {
    const match = field.Examples?.find(ex => ex.Value === value);
    return !(match && !matchesProviderRule(match.Provider, provider));
  }

  private shuffleSample<T>(list: T[], count = 5): T[] {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, count);
  }

  // ── Template bindings ─────────────────────────────────────────────────────

  readonly displayRemote = (value: string): string =>
    this.remoteTypes().find(t => t.value === value)?.label ?? value ?? '';

  readonly displayProvider = (value: string): string =>
    this.providerField()?.Examples?.find(o => o.Value === value)?.Help ?? value;

  onTypeSelected(value: string): void {
    this.form().get('type')?.setValue(value);
    this.generateRemoteName(value);
    this.remoteTypeChanged.emit();
  }

  clearType(): void {
    this.form().get('type')?.setValue('');
    this.remoteSearchCtrl.setValue('');
    this.remoteTypeChanged.emit();
  }

  stopAndClearType(event: MouseEvent): void {
    event.stopPropagation();
    this.clearType();
  }

  private generateRemoteName(remoteType: string): void {
    const nameControl = this.form().get('name');
    if (!nameControl || (nameControl.value && nameControl.dirty)) return;

    const base = remoteType.replace(/\s+/g, '');
    const name = findUniqueName(base, this.existingRemotes());

    nameControl.setValue(name, { emitEvent: true });
    nameControl.updateValueAndValidity({ emitEvent: false });
    if (nameControl.invalid) nameControl.markAsTouched();
  }

  toggleJsonMode(): void {
    this.uiStateService.toggleShowJsonMode();
  }

  toggleAdvancedOptions(): void {
    const nextVal = !this.showAdvancedOptions();
    this.advancedOptionsToggled.emit(nextVal);
  }

  toggleCommandOptions(): void {
    this.showCommandOptions.update(v => !v);
  }

  onProviderSelected(value: string): void {
    const field = this.providerField();
    if (field) this.form().get(field.Name)?.setValue(value);
  }

  onFieldChanged(fieldName: string, isChanged: boolean): void {
    this.fieldChanged.emit({ fieldName, isChanged });
  }

  reshuffleSuggestions(): void {
    this.suggestedRemotes.set(this.shuffleSample(this.remoteTypesWithIcons()));
  }
}
