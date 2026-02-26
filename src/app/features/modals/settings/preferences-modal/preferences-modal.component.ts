import {
  Component,
  HostListener,
  OnInit,
  inject,
  ChangeDetectionStrategy,
  signal,
  computed,
  effect,
  OnDestroy,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidatorFn,
  Validators,
} from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';

// Services and Types
import { ValidatorRegistryService, ModalService } from '@app/services';
import { AppSettingsService, FileSystemService } from '@app/services';
import { SearchResult, SettingMetadata, SettingTab } from '@app/types';

interface PendingChange {
  category: string;
  key: string;
  value: unknown;
  metadata: SettingMetadata;
}

@Component({
  selector: 'app-preferences-modal',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatSlideToggleModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    SearchContainerComponent,
    TranslateModule,
    NgTemplateOutlet,
  ],
  templateUrl: './preferences-modal.component.html',
  styleUrls: ['./preferences-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreferencesModalComponent implements OnInit, OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly dialogRef = inject(MatDialogRef<PreferencesModalComponent>);

  settingsForm: FormGroup;

  // Signals
  readonly isLoading = signal(true);
  readonly selectedTabIndex = signal(0);
  readonly bottomTabs = signal(false);
  readonly searchQuery = signal('');
  readonly searchVisible = signal(false);
  readonly isDiscardingChanges = signal(false);

  // Pending restart changes as a signal of Map
  readonly pendingRestartChanges = signal<Map<string, PendingChange>>(new Map());

  readonly options = toSignal(this.appSettingsService.options$);

  // Computed Signals
  readonly enrichedOptions = computed(() => {
    const rawOptions = this.options();
    if (!rawOptions) return {};
    return this.enrichMetadata(rawOptions);
  });

  readonly tabs: SettingTab[] = [
    { label: 'modals.preferences.tabs.general', icon: 'wrench', key: 'general' },
    { label: 'modals.preferences.tabs.core', icon: 'puzzle-piece', key: 'core' },
    { label: 'modals.preferences.tabs.developer', icon: 'flask', key: 'developer' },
  ];

  readonly filteredTabs = computed(() => {
    // Tabs are static in this case, but good to have prepared for future dynamic tabs
    return this.tabs;
  });

  readonly searchSuggestions = signal<string[]>([]);

  readonly searchResults = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const options = this.enrichedOptions();

    if (!query) return [];

    const results: SearchResult[] = [];
    for (const [fullKey, meta] of Object.entries(options)) {
      const displayName = meta.metadata.display_name || meta.metadata.label || '';
      const helpText = meta.metadata.help_text || meta.metadata.description || '';

      if (displayName.toLowerCase().includes(query) || helpText.toLowerCase().includes(query)) {
        const { category, key } = this.splitKey(fullKey);
        // Only include if category exists in our tabs
        if (this.tabs.some(t => t.key === category)) {
          results.push({ category, key });
        }
      }
    }
    return results;
  });

  readonly selectedTabKey = computed(() => {
    return this.filteredTabs()[this.selectedTabIndex()]?.key || this.filteredTabs()[0].key;
  });

  readonly isGeneralTab = computed(() => this.selectedTabKey() === 'general');
  readonly hasSearchResults = computed(() => this.searchQuery().length > 0);
  readonly hasEmptySearchResults = computed(
    () => this.hasSearchResults() && this.searchResults().length === 0
  );
  readonly hasPendingRestartChanges = computed(() => this.pendingRestartChanges().size > 0);
  readonly pendingChangesCount = computed(() => this.pendingRestartChanges().size);

  private readonly HOLD_DELAY = 300;
  private readonly HOLD_INTERVAL = 75;
  private holdTimeout: ReturnType<typeof setTimeout> | null = null;
  private holdInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.settingsForm = this.fb.group({});

    // Effect to build form when options change
    effect(() => {
      const options = this.enrichedOptions();
      if (Object.keys(options).length > 0) {
        this.buildForm(options);
        this.isLoading.set(false);
      } else {
        this.isLoading.set(true);
      }
    });

    this.populateSearchSuggestions();
  }

  ngOnInit(): void {
    this.onResize();
  }

  ngOnDestroy(): void {
    this.stopHold(false);
  }

  private populateSearchSuggestions(): void {
    const suggestionKeys = ['apiPort', 'startup', 'debug', 'bandwidth'];
    this.translate
      .get(suggestionKeys.map(k => `modals.preferences.searchSuggestions.${k}`))
      .pipe(takeUntilDestroyed())
      .subscribe(translations => {
        this.searchSuggestions.set(Object.values(translations));
      });
  }

  @HostListener('window:resize')
  onResize(): void {
    this.bottomTabs.set(window.innerWidth < 540);
  }

  private enrichMetadata(
    options: Record<string, SettingMetadata>
  ): Record<string, SettingMetadata> {
    const enriched: Record<string, SettingMetadata> = {};
    for (const [fullKey, meta] of Object.entries(options)) {
      const [, key] = fullKey.split('.');

      // Infer Type if missing
      if (!meta.value_type) {
        enriched[fullKey] = { ...meta, value_type: this.inferValueType(meta, key) };
      } else {
        enriched[fullKey] = meta;
      }
    }
    return enriched;
  }

  private inferValueType(meta: SettingMetadata, key: string): SettingMetadata['value_type'] {
    if (meta.options && meta.options.length > 0) return 'string';

    // Check key patterns for specialized types
    if (key.includes('bandwidth')) return 'bandwidth';
    if (key.endsWith('_urls') || key.endsWith('_apps')) return 'string[]'; // Lists
    if (key.includes('path') || key.includes('file')) return 'file';
    if (key.includes('folder') || key.includes('directory')) return 'folder';

    // Fallback to type of default value
    const def = meta.default;
    if (typeof def === 'boolean') return 'bool';
    if (typeof def === 'number') return 'int';
    if (Array.isArray(def)) return 'string[]';

    return 'string' as const;
  }

  private buildForm(options: Record<string, SettingMetadata>): void {
    for (const fullKey in options) {
      const meta = options[fullKey];
      const { category, key } = this.splitKey(fullKey);

      // Only build for known tabs
      if (!this.tabs.some(t => t.key === category)) continue;

      let categoryGroup = this.settingsForm.get(category) as FormGroup;
      if (!categoryGroup) {
        categoryGroup = this.fb.group({});
        this.settingsForm.addControl(category, categoryGroup);
      }

      const existingControl = categoryGroup.get(key);
      const validators = this.getValidators(meta, fullKey);

      if (existingControl) {
        if (!existingControl.dirty && !this.valuesEqual(existingControl.value, meta.value)) {
          if (existingControl instanceof FormArray && meta.value_type === 'string[]') {
            this.resetControlValue(existingControl, meta.value, meta);
          } else {
            existingControl.setValue(meta.value, { emitEvent: false });
          }
        }
      } else {
        let control: FormControl | FormArray;
        if (meta.value_type === 'string[]') {
          const itemValidators = this.getItemValidators(meta);
          control = this.fb.array(
            ((meta.value || []) as string[]).map(val => this.fb.control(val, itemValidators)),
            validators
          );
        } else {
          control = this.fb.control(meta.value, validators);
        }
        categoryGroup.addControl(key, control);
      }
    }
  }

  private normalizeValue(val: unknown): string {
    return val === null || val === undefined || val === '' ? '' : String(val);
  }

  private valuesEqual(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((val, idx) => val === b[idx]);
    }
    return this.normalizeValue(a) === this.normalizeValue(b);
  }

  onBlur(category: string, key: string): void {
    this.commitSetting(category, key);
  }

  onValueChange(category: string, key: string): void {
    this.commitSetting(category, key);
  }

  private commitSetting(category: string, key: string): void {
    const control = this.getFormControl(category, key);
    if (control?.valid) {
      this.updateSetting(category, key, control.value);
    }
  }

  private getItemValidators(meta: SettingMetadata): ValidatorFn[] {
    const validators: ValidatorFn[] = [];
    if (meta.reserved && meta.reserved.length > 0) {
      validators.push(this.createReservedValidator(meta.reserved));
    }
    return validators;
  }

  private createReservedValidator(reserved: string[]): ValidatorFn {
    return (control: AbstractControl): Record<string, any> | null => {
      const value = control.value;
      if (!value) return null;
      const isReserved = reserved.some(
        r => value === r || value.startsWith(r + '=') || value.startsWith(r + ' ')
      );
      return isReserved ? { reserved: { value, reservedValues: reserved } } : null;
    };
  }

  private getValidators(meta: SettingMetadata, fullKey: string): ValidatorFn[] {
    const validators: ValidatorFn[] = [];
    if (meta.metadata.required) {
      validators.push(Validators.required);
    }

    switch (meta.value_type) {
      case 'int':
        validators.push(this.validatorRegistry.integerValidator());
        if (meta.min !== undefined) validators.push(Validators.min(meta.min));
        if (meta.max !== undefined) validators.push(Validators.max(meta.max));
        break;
      case 'file':
      case 'folder': {
        const validator = this.validatorRegistry.getValidator('crossPlatformPath');
        if (validator) validators.push(validator);
        break;
      }
      case 'string[]':
        if (fullKey === 'core.connection_check_urls') {
          const validator = this.validatorRegistry.getValidator('urlList');
          if (validator) validators.push(validator);
        }
        break;
      case 'bandwidth': {
        const validator = this.validatorRegistry.getValidator('bandwidthFormat');
        if (validator) validators.push(validator);
        break;
      }
    }
    return validators;
  }

  updateSetting(category: string, key: string, value: unknown): void {
    const control = this.getFormControl(category, key);
    if (!control?.valid) return;

    const meta = this.getMetadata(category, key);
    let finalValue = value;

    if (meta.value_type === 'int' && typeof finalValue === 'string' && finalValue.trim() !== '') {
      finalValue = parseInt(finalValue, 10);
    }

    if (meta.value_type === 'string[]' && Array.isArray(finalValue)) {
      finalValue = finalValue.filter(item => item && String(item).trim() !== '');
    }

    if (meta.metadata.engine_restart) {
      if (this.valuesEqual(meta.value, finalValue)) {
        this.pendingRestartChanges.update(map => {
          const newMap = new Map(map);
          newMap.delete(`${category}.${key}`);
          return newMap;
        });
      } else {
        this.pendingRestartChanges.update(map => {
          const newMap = new Map(map);
          newMap.set(`${category}.${key}`, {
            category,
            key,
            value: finalValue,
            metadata: meta,
          });
          return newMap;
        });
      }
    } else {
      if (!this.valuesEqual(meta.value, finalValue)) {
        this.appSettingsService.saveSetting(category, key, finalValue);
      }
    }
  }

  getFormControl(category: string, key: string): FormControl | FormArray {
    return this.settingsForm.get(category)?.get(key) as FormControl | FormArray;
  }

  getArrayItemControl(category: string, key: string, index: number): FormControl {
    return (this.getFormControl(category, key) as FormArray).at(index) as FormControl;
  }

  getArrayControls(category: string, key: string): AbstractControl[] {
    return (this.getFormControl(category, key) as FormArray).controls;
  }

  getMetadata(category: string, key: string): SettingMetadata {
    return this.enrichedOptions()[`${category}.${key}`];
  }

  isControlInvalid(category: string, key: string, index?: number): boolean {
    const ctrl =
      index !== undefined
        ? this.getArrayItemControl(category, key, index)
        : this.getFormControl(category, key);
    return !!ctrl && ctrl.invalid && ctrl.touched;
  }

  private splitKey(fullKey: string): { category: string; key: string } {
    const [category, key] = fullKey.split('.');
    return { category, key };
  }

  onIntegerInput(event: KeyboardEvent): void {
    if (
      [
        'Backspace',
        'Delete',
        'Tab',
        'Escape',
        'Enter',
        'Home',
        'End',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
      ].includes(event.key) ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    if (!/^\d$/.test(event.key)) {
      event.preventDefault();
    }
  }

  startHold(
    action: 'increment' | 'decrement',
    step: number | 'any',
    category: string,
    key: string,
    meta: SettingMetadata
  ): void {
    this.stopHold(false);
    const performAction = (): void => {
      if (action === 'increment') this.incrementNumber(category, key, meta);
      else this.decrementNumber(category, key, meta);
    };
    performAction();
    this.holdTimeout = setTimeout(() => {
      this.holdInterval = setInterval(performAction, this.HOLD_INTERVAL);
    }, this.HOLD_DELAY);
  }

  stopHold(_commit = true): void {
    if (this.holdTimeout) clearTimeout(this.holdTimeout);
    if (this.holdInterval) clearInterval(this.holdInterval);
    this.holdTimeout = null;
    this.holdInterval = null;
  }

  incrementNumber(category: string, key: string, meta: SettingMetadata): void {
    const control = this.getFormControl(category, key) as FormControl;
    const step = meta.step || 1;
    const max = meta.max ?? Infinity;
    const newValue = (Number(control.value) || 0) + step;
    if (newValue <= max) control.setValue(newValue);
  }

  decrementNumber(category: string, key: string, meta: SettingMetadata): void {
    const control = this.getFormControl(category, key) as FormControl;
    const step = meta.step || 1;
    const min = meta.min ?? -Infinity;
    const newValue = (Number(control.value) || 0) - step;
    if (newValue >= min) control.setValue(newValue);
  }

  addArrayItem(category: string, key: string): void {
    const control = this.getFormControl(category, key) as FormArray;
    const meta = this.getMetadata(category, key);
    const itemValidators = this.getItemValidators(meta);
    control.push(this.fb.control('', itemValidators));
  }

  removeArrayItem(category: string, key: string, index: number): void {
    const control = this.getFormControl(category, key) as FormArray;
    control.removeAt(index);
    this.updateSetting(category, key, control.value);
  }

  async openFilePicker(category: string, key: string): Promise<void> {
    const result = await this.fileSystemService.selectFile();
    if (result) this.getFormControl(category, key).setValue(result);
  }

  async openFolderPicker(category: string, key: string): Promise<void> {
    const result = await this.fileSystemService.selectFolder();
    if (result) this.getFormControl(category, key).setValue(result);
  }

  getValidationMessage(category: string, key: string, index?: number): string {
    let ctrl: AbstractControl | null;
    if (index !== undefined) {
      ctrl = this.getArrayItemControl(category, key, index);
    } else {
      ctrl = this.getFormControl(category, key);
    }

    if (!ctrl?.errors) return '';
    const meta = this.getMetadata(category, key);
    if (ctrl.hasError('required'))
      return this.translate.instant('modals.preferences.validation.required');
    if (ctrl.hasError('integer'))
      return this.translate.instant('modals.preferences.validation.integer');
    if (ctrl.hasError('min'))
      return this.translate.instant('modals.preferences.validation.min', { val: meta.min });
    if (ctrl.hasError('max'))
      return this.translate.instant('modals.preferences.validation.max', { val: meta.max });
    if (ctrl.hasError('invalidPath'))
      return this.translate.instant('modals.preferences.validation.invalidPath');
    if (ctrl.hasError('bandwidth'))
      return this.translate.instant('modals.preferences.validation.bandwidth');
    if (ctrl.hasError('urlArray'))
      return this.translate.instant('modals.preferences.validation.urlArray');
    if (ctrl.hasError('reserved'))
      return this.translate.instant('modals.preferences.validation.reserved', {
        value: ctrl.errors['reserved'].value,
      });

    return this.translate.instant('modals.preferences.validation.invalid');
  }

  onSearchTextChange(searchText: string): void {
    this.searchQuery.set(searchText.toLowerCase());
  }

  getCategoryDisplayName(category: string): string {
    const tab = this.tabs.find(tab => tab.key === category);
    if (tab) return this.translate.instant(tab.label);
    return category.charAt(0).toUpperCase() + category.slice(1);
  }

  getSettingLabel(_category: string, _key: string, meta: SettingMetadata): string {
    const labelKey = meta.metadata.label || meta.metadata.display_name;
    if (!labelKey) return _key;
    return this.translate.instant(labelKey);
  }

  getSettingDescription(_category: string, _key: string, meta: SettingMetadata): string {
    const descKey = meta.metadata.description || meta.metadata.help_text;
    if (!descKey) return '';
    return this.translate.instant(descKey);
  }

  getOptionLabel(_category: string, _key: string, option: unknown): string {
    const opt = option as { value: unknown; label: unknown };
    const labelKey = opt?.label ?? option;
    return this.translate.instant(String(labelKey));
  }

  getObjectKeys(obj: Record<string, unknown>): string[] {
    return obj ? Object.keys(obj) : [];
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }

  @HostListener('document:keydown.control.f', ['$event'])
  handleCtrlF(event: Event): void {
    event.preventDefault();
    this.toggleSearch();
  }

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
    if (!this.searchVisible()) {
      this.onSearchTextChange('');
    }
  }

  selectTab(index: number): void {
    this.selectedTabIndex.set(index);
  }

  onPathInput(category: string, key: string): void {
    this.getFormControl(category, key).updateValueAndValidity();
  }

  async resetSetting(category: string, key: string): Promise<void> {
    const meta = this.getMetadata(category, key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaultValue = (meta as any).default;

    const control = this.getFormControl(category, key);
    if (control) this.resetControlValue(control, defaultValue, meta);

    if (meta.metadata.engine_restart) {
      this.pendingRestartChanges.update(map => {
        const newMap = new Map(map);
        newMap.set(`${category}.${key}`, {
          category,
          key,
          value: defaultValue,
          metadata: meta,
        });
        return newMap;
      });
    } else {
      try {
        await this.appSettingsService.resetSetting(category, key);
      } catch (error) {
        console.error(`Failed to reset setting ${category}.${key}`, error);
      }
    }
  }

  isModified(category: string, key: string): boolean {
    const meta = this.getMetadata(category, key);
    const control = this.getFormControl(category, key);
    if (!meta || !control) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaultValue = (meta as any).default;
    return !this.valuesEqual(defaultValue, control.value);
  }

  async resetSettings(): Promise<void> {
    try {
      await this.appSettingsService.resetSettings();
    } catch (error) {
      console.error('Error resetting settings:', error);
    }
  }

  async savePendingChanges(): Promise<void> {
    if (this.pendingRestartChanges().size === 0) return;
    try {
      const savePromises = Array.from(this.pendingRestartChanges().values()).map(change =>
        this.appSettingsService.saveSetting(change.category, change.key, change.value)
      );
      await Promise.all(savePromises);
      this.pendingRestartChanges.update(map => {
        const newMap = new Map(map);
        newMap.clear();
        return newMap;
      });
    } catch (error) {
      console.error('Error saving pending changes:', error);
    }
  }

  async discardPendingChanges(): Promise<void> {
    this.isDiscardingChanges.set(true);
    for (const change of this.pendingRestartChanges().values()) {
      const originalValue = this.getMetadata(change.category, change.key).value;
      const control = this.getFormControl(change.category, change.key);
      if (control) this.resetControlValue(control, originalValue, change.metadata);
    }
    this.pendingRestartChanges.update(map => {
      const newMap = new Map(map);
      newMap.clear();
      return newMap;
    });
    this.isDiscardingChanges.set(false);
  }

  private resetControlValue(
    control: FormControl | FormArray,
    value: unknown,
    meta: SettingMetadata
  ): void {
    if (control instanceof FormArray) {
      const itemValidators = this.getItemValidators(meta);
      control.clear();
      (Array.isArray(value) ? value : []).forEach(val => {
        control.push(this.fb.control(val, itemValidators));
      });
    } else {
      control.setValue(value, { emitEvent: false });
    }
  }

  getPendingChangesList(): {
    displayName: string;
    category: string;
    key: string;
    value: unknown;
  }[] {
    return Array.from(this.pendingRestartChanges().values()).map(change => ({
      displayName:
        change.metadata.metadata.display_name || change.metadata.metadata.label || change.key,
      category: change.category,
      key: change.key,
      value: change.value,
    }));
  }

  scrollToPendingChanges(): void {
    const pendingSection = document.querySelector('.pending-changes-section');
    if (pendingSection) {
      pendingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  isArray(value: unknown): boolean {
    return Array.isArray(value);
  }

  asArray(value: unknown): unknown[] {
    return value as unknown[];
  }
}
