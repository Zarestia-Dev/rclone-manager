import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
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
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

// Services and Types
import { ValidatorRegistryService, ModalService } from '@app/services';
import { AppSettingsService, FileSystemService } from '@app/services';
import { SearchResult, SettingMetadata, SettingTab } from '@app/types';

@Component({
  selector: 'app-preferences-modal',
  standalone: true,
  imports: [
    CommonModule,
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
  ],
  templateUrl: './preferences-modal.component.html',
  styleUrls: ['./preferences-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class PreferencesModalComponent implements OnInit, OnDestroy {
  settingsForm: FormGroup;
  optionsMap: Record<string, SettingMetadata> = {};
  isLoading = true;

  selectedTabIndex = 0;
  bottomTabs = false;
  searchQuery = '';
  searchVisible = false;
  filteredTabs: SettingTab[] = [];
  searchResults: SearchResult[] = [];
  isDiscardingChanges = false;

  pendingRestartChanges = new Map<
    string,
    { category: string; key: string; value: unknown; metadata: SettingMetadata }
  >();

  private destroyed$ = new Subject<void>();

  readonly tabs: SettingTab[] = [
    { label: 'modals.preferences.tabs.general', icon: 'wrench', key: 'general' },
    { label: 'modals.preferences.tabs.core', icon: 'puzzle-piece', key: 'core' },
    { label: 'modals.preferences.tabs.developer', icon: 'flask', key: 'developer' },
  ];

  searchSuggestions: string[] = [];

  private dialogRef = inject(MatDialogRef<PreferencesModalComponent>);
  private fb = inject(FormBuilder);
  private appSettingsService = inject(AppSettingsService);
  private fileSystemService = inject(FileSystemService);
  private validatorRegistry = inject(ValidatorRegistryService);
  private translate = inject(TranslateService);
  private modalService = inject(ModalService);

  private readonly HOLD_DELAY = 300;
  private readonly HOLD_INTERVAL = 75;
  private holdTimeout: ReturnType<typeof setTimeout> | null = null;
  private holdInterval: ReturnType<typeof setInterval> | null = null;

  get hasSearchResults(): boolean {
    return this.searchQuery.length > 0;
  }
  get hasEmptySearchResults(): boolean {
    return this.searchQuery.length > 0 && this.searchResults.length === 0;
  }
  get hasPendingRestartChanges(): boolean {
    return this.pendingRestartChanges.size > 0;
  }
  get selectedTabKey(): string {
    return this.filteredTabs[this.selectedTabIndex]?.key || this.filteredTabs[0].key;
  }
  get isGeneralTab(): boolean {
    return this.selectedTabKey === 'general';
  }

  constructor() {
    this.settingsForm = this.fb.group({});
    this.filteredTabs = [...this.tabs];
  }

  private valuesEqual(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((val, idx) => val === b[idx]);
    }
    const normalizeEmpty = (val: unknown): string =>
      val === null || val === undefined || val === '' ? '' : String(val);
    return normalizeEmpty(a) === normalizeEmpty(b);
  }

  ngOnInit(): void {
    this.onResize();
    this.subscribeToOptions();
    this.populateSearchSuggestions();
  }

  private populateSearchSuggestions(): void {
    const suggestionKeys = ['apiPort', 'startup', 'debug', 'bandwidth'];
    this.translate
      .get(suggestionKeys.map(k => `modals.preferences.searchSuggestions.${k}`))
      .pipe(takeUntil(this.destroyed$))
      .subscribe(translations => {
        this.searchSuggestions = Object.values(translations);
      });
  }

  ngOnDestroy(): void {
    this.destroyed$.next();
    this.destroyed$.complete();
    // Ensure hold timers are cleaned up
    this.stopHold(false);
  }

  @HostListener('window:resize')
  onResize(): void {
    this.bottomTabs = window.innerWidth < 540;
  }

  private subscribeToOptions(): void {
    this.appSettingsService.options$.pipe(takeUntil(this.destroyed$)).subscribe(options => {
      if (options) {
        // Enchant metadata with inferred types and labels if missing
        this.enrichMetadata(options);
        this.optionsMap = options;
        this.buildForm(options);
        this.isLoading = false;
      } else {
        this.isLoading = true;
      }
    });
  }

  private enrichMetadata(options: Record<string, SettingMetadata>): void {
    for (const [fullKey, meta] of Object.entries(options)) {
      const [, key] = fullKey.split('.');

      // Infer Type if missing
      if (!meta.value_type) {
        meta.value_type = this.inferValueType(meta, key);
      }
    }
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
    const formGroups: Record<string, FormGroup> = {};

    for (const fullKey in options) {
      const meta = options[fullKey];
      const [category, key] = fullKey.split('.');

      if (!formGroups[category]) {
        if (this.tabs.some(t => t.key === category)) {
          formGroups[category] = this.fb.group({});
        } else {
          continue;
        }
      }

      const validators = this.getValidators(meta, fullKey);
      const control =
        meta.value_type === 'string[]'
          ? this.fb.array(
              ((meta.value || []) as string[]).map(val => this.fb.control(val)),
              validators
            )
          : this.fb.control(meta.value, validators);

      formGroups[category].addControl(key, control);
    }
    this.settingsForm = this.fb.group(formGroups);
  }

  /**
   * Called on blur for text inputs - saves the current value
   */
  onBlur(category: string, key: string): void {
    const control = this.getFormControl(category, key);
    if (control?.valid) {
      this.updateSetting(category, key, control.value);
    }
  }

  /**
   * Called on selection change for dropdowns and toggles - saves immediately
   */
  onValueChange(category: string, key: string): void {
    const control = this.getFormControl(category, key);
    if (control?.valid) {
      this.updateSetting(category, key, control.value);
    }
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
      this.pendingRestartChanges.set(`${category}.${key}`, {
        category,
        key,
        value: finalValue,
        metadata: meta,
      });
    } else {
      this.appSettingsService.saveSetting(category, key, finalValue);
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
    return this.optionsMap[`${category}.${key}`];
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
    control.push(this.fb.control(''));
  }

  removeArrayItem(category: string, key: string, index: number): void {
    const control = this.getFormControl(category, key) as FormArray;
    control.removeAt(index);
  }

  async openFilePicker(category: string, key: string): Promise<void> {
    const result = await this.fileSystemService.selectFile();
    if (result) this.getFormControl(category, key).setValue(result);
  }

  async openFolderPicker(category: string, key: string): Promise<void> {
    const result = await this.fileSystemService.selectFolder();
    if (result) this.getFormControl(category, key).setValue(result);
  }

  getValidationMessage(category: string, key: string): string {
    const ctrl = this.getFormControl(category, key);
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
    return this.translate.instant('modals.preferences.validation.invalid');
  }

  onSearchTextChange(searchText: string): void {
    this.searchQuery = searchText.toLowerCase();
    this.searchResults = [];
    if (!this.searchQuery) {
      this.filteredTabs = [...this.tabs];
      return;
    }
    for (const [fullKey, meta] of Object.entries(this.optionsMap)) {
      const displayName = meta.metadata.display_name || meta.metadata.label || '';
      const helpText = meta.metadata.help_text || meta.metadata.description || '';

      if (
        displayName.toLowerCase().includes(this.searchQuery) ||
        helpText.toLowerCase().includes(this.searchQuery)
      ) {
        const [category, key] = fullKey.split('.');
        this.searchResults.push({ category, key });
      }
    }
  }

  getCategoryDisplayName(category: string): string {
    const tab = this.tabs.find(tab => tab.key === category);
    if (tab) return this.translate.instant(tab.label);
    return category.charAt(0).toUpperCase() + category.slice(1);
  }

  getSettingLabel(_category: string, _key: string, meta: SettingMetadata): string {
    // Backend now sends translation keys directly, just translate them
    const labelKey = meta.metadata.label || meta.metadata.display_name;
    if (!labelKey) return _key;
    return this.translate.instant(labelKey);
  }

  getSettingDescription(_category: string, _key: string, meta: SettingMetadata): string {
    // Backend now sends translation keys directly, just translate them
    const descKey = meta.metadata.description || meta.metadata.help_text;
    if (!descKey) return '';
    return this.translate.instant(descKey);
  }

  getOptionLabel(_category: string, _key: string, option: unknown): string {
    // Backend now sends translation keys directly for option labels
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
    this.searchVisible = !this.searchVisible;
    if (!this.searchVisible) {
      this.onSearchTextChange('');
    }
  }

  selectTab(index: number): void {
    this.selectedTabIndex = index;
  }

  onPathInput(category: string, key: string): void {
    this.getFormControl(category, key).updateValueAndValidity();
  }

  async resetSetting(category: string, key: string): Promise<void> {
    const meta = this.getMetadata(category, key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaultValue = (meta as any).default;

    // Update the form control to the default value
    const control = this.getFormControl(category, key);
    if (control) {
      control.setValue(defaultValue, { emitEvent: false });
    }

    // If this setting requires restart, add to pending changes
    if (meta.metadata.engine_restart) {
      this.pendingRestartChanges.set(`${category}.${key}`, {
        category,
        key,
        value: defaultValue,
        metadata: meta,
      });
    } else {
      // Otherwise reset immediately
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
    if (this.pendingRestartChanges.size === 0) return;
    try {
      const savePromises = Array.from(this.pendingRestartChanges.values()).map(change =>
        this.appSettingsService.saveSetting(change.category, change.key, change.value)
      );
      await Promise.all(savePromises);
      this.pendingRestartChanges.clear();
    } catch (error) {
      console.error('Error saving pending changes:', error);
    }
  }

  async discardPendingChanges(): Promise<void> {
    this.isDiscardingChanges = true;
    for (const change of this.pendingRestartChanges.values()) {
      const originalValue = this.getMetadata(change.category, change.key).value;
      this.getFormControl(change.category, change.key).setValue(originalValue, {
        emitEvent: false,
      });
    }
    this.pendingRestartChanges.clear();
    this.isDiscardingChanges = false;
  }

  getPendingChangesList(): {
    displayName: string;
    category: string;
    key: string;
    value: unknown;
  }[] {
    return Array.from(this.pendingRestartChanges.values()).map(change => ({
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
