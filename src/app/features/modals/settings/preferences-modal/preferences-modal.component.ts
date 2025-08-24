import { Component, HostListener, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AbstractControl,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators,
} from '@angular/forms';
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

// Services
import { ValidatorRegistryService } from '../../../../shared/services/validator-registry.service';
import { AppSettingsService } from '@app/services';
import { FileSystemService } from '@app/services';
import { SearchResult, SettingMetadata, SettingTab } from '@app/types';

@Component({
  selector: 'app-preferences-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatSlideToggleModule,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule,
    MatSelectModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    SearchContainerComponent,
  ],
  templateUrl: './preferences-modal.component.html',
  styleUrls: ['./preferences-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class PreferencesModalComponent implements OnInit {
  selectedTabIndex = 0;
  settingsForm: FormGroup;
  metadata: Record<string, SettingMetadata> = {};
  bottomTabs = false;
  isLoading = true;
  searchQuery = '';
  searchVisible = false;
  filteredTabs: SettingTab[] = [];
  searchResults: SearchResult[] = [];
  isDiscardingChanges = false;

  // Pending restart-required changes
  pendingRestartChanges = new Map<
    string,
    { category: string; key: string; value: unknown; metadata: SettingMetadata }
  >();

  // Track original values to prevent unnecessary updates
  private originalValues = new Map<string, unknown>();

  get hasPendingRestartChanges(): boolean {
    return this.pendingRestartChanges.size > 0;
  }

  readonly tabs: SettingTab[] = [
    { label: 'General', icon: 'wrench', key: 'general' },
    { label: 'Core', icon: 'puzzle-piece', key: 'core' },
    { label: 'Experimental', icon: 'flask', key: 'experimental' },
  ];

  readonly searchSuggestions = ['Api Port', 'Start on Startup', 'Debug', 'Bandwidth'];

  private dialogRef = inject(MatDialogRef<PreferencesModalComponent>);
  private fb = inject(FormBuilder);
  private appSettingsService = inject(AppSettingsService);
  private fileSystemService = inject(FileSystemService);
  private validatorRegistry = inject(ValidatorRegistryService);
  private arrayControlsCache = new Map<string, FormControl[]>();

  constructor() {
    this.settingsForm = this.fb.group({});
    this.filteredTabs = [...this.tabs];
  }

  ngOnInit(): void {
    this.onResize();
    this.loadSettings();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.bottomTabs = window.innerWidth < 540;
  }

  async loadSettings(): Promise<void> {
    try {
      this.isLoading = true;
      const response = await this.appSettingsService.loadSettings();
      this.metadata = response.metadata;

      const formGroups: Record<string, FormGroup> = {};
      for (const category of Object.keys(response.settings)) {
        formGroups[category] = this.fb.group({});

        for (const [key, value] of Object.entries(response.settings[category])) {
          const meta = this.getMetadata(category, key);
          const validators = this.getValidators(meta);

          if (meta.value_type === 'array' && Array.isArray(value)) {
            formGroups[category].addControl(key, this.fb.control(value, validators));
          } else {
            formGroups[category].addControl(key, this.fb.control(value, validators));
          }
        }
      }

      this.settingsForm = this.fb.group(formGroups);
      this.isLoading = false;
    } catch (error) {
      this.isLoading = false;
      console.error('Error loading settings:', error);
    }
  }

  getValidationMessage(category: string, key: string): string {
    const ctrl = this.getFormControl(category, key);
    const meta = this.getMetadata(category, key);

    if (ctrl.hasError('required')) {
      return meta.validation_message || 'This field is required';
    }

    // Handle custom validator errors with messages
    if (ctrl.hasError('portRange')) {
      return ctrl.getError('portRange').message || 'Invalid port range';
    }
    if (ctrl.hasError('urlArray')) {
      return ctrl.getError('urlArray').message || 'Invalid URL array';
    }
    if (ctrl.hasError('bandwidth')) {
      return ctrl.getError('bandwidth').message || 'Invalid bandwidth format';
    }
    if (ctrl.hasError('numericRange')) {
      return ctrl.getError('numericRange').message || 'Invalid numeric range';
    }

    // Handle pattern errors (both legacy and new)
    if (ctrl.hasError('pattern')) {
      const patternError = ctrl.getError('pattern');
      return patternError.message || meta.validation_message || 'Invalid format';
    }

    // Handle built-in validators
    if (ctrl.hasError('min')) {
      return `Minimum value is ${meta.min_value}`;
    }
    if (ctrl.hasError('max')) {
      return `Maximum value is ${meta.max_value}`;
    }

    // Handle path validation
    if (ctrl.hasError('invalidPath')) {
      return 'Please enter a valid absolute file path';
    }

    // Handle array validation
    if (ctrl.hasError('arrayItemPattern')) {
      return meta.validation_message || 'Some items have invalid format';
    }

    return 'Invalid value';
  }

  getValidators(meta: SettingMetadata): ValidatorFn[] {
    const validators: ValidatorFn[] = [];

    // Add required validator - but be more lenient for path types unless explicitly required
    const isRequired =
      meta.value_type === 'path' ? meta.required === true : (meta.required ?? true);
    if (isRequired) {
      validators.push(Validators.required);
    }

    // Try to get validator from registry first (supports both regex and named validators)
    const registryValidator = this.validatorRegistry.createValidatorFromMetadata(meta);
    if (registryValidator) {
      validators.push(registryValidator);
    } else if (meta.validation_pattern) {
      // Fallback to legacy pattern validation
      if (meta.value_type === 'array') {
        validators.push(this.arrayItemsPatternValidator(meta.validation_pattern));
      } else {
        validators.push(Validators.pattern(meta.validation_pattern));
      }
    }

    // Add number-specific validation
    if (meta.value_type === 'number') {
      validators.push(Validators.pattern(/^-?\d+$/));

      if (meta.min_value !== undefined) {
        validators.push(Validators.min(meta.min_value));
      }

      if (meta.max_value !== undefined) {
        validators.push(Validators.max(meta.max_value));
      }
    }

    // For path types, ensure cross-platform path validation is always applied
    // (unless already added by registry)
    if (meta.value_type === 'path' && !registryValidator) {
      const pathValidator = this.validatorRegistry.getValidator('crossPlatformPath');
      if (pathValidator) {
        validators.push(pathValidator);
      }
    }

    return validators;
  }

  async updateSetting(category: string, key: string, value: unknown): Promise<void> {
    const control = this.getFormControl(category, key);

    if (!control?.valid) {
      return;
    }

    // Check if the value has actually changed from the original setting value
    try {
      const currentServerValue = await this.appSettingsService.loadSettingValue(category, key);

      // Normalize values for comparison (handle different types and empty values)
      const normalizeForComparison = (val: unknown): unknown => {
        if (val === null || val === undefined) return null;
        if (typeof val === 'string' && val.trim() === '') return null;
        if (Array.isArray(val) && val.length === 0) return null;
        if (Array.isArray(val)) {
          // Filter out empty strings from arrays for comparison
          const filtered = val.filter(item => item && String(item).trim());
          return filtered.length === 0 ? null : filtered;
        }
        return val;
      };

      const normalizedCurrent = normalizeForComparison(currentServerValue);
      const normalizedNew = normalizeForComparison(value);

      // If values are the same, don't proceed with the update
      if (JSON.stringify(normalizedCurrent) === JSON.stringify(normalizedNew)) {
        return;
      }

      const meta = this.getMetadata(category, key);

      // Handle different value types
      if (meta.value_type === 'number') {
        value = Number(value);
        // Remove the incorrect check that prevents 0 values
      } else if (meta.value_type === 'array' && Array.isArray(value)) {
        // For arrays, only filter out empty strings if there are also non-empty strings
        // This allows saving completely empty arrays while cleaning up mixed arrays
        const nonEmptyItems = value.filter(item => item && item.trim());
        const hasNonEmpty = nonEmptyItems.length > 0;
        const hasEmpty = value.some(item => !item || !item.trim());

        if (hasNonEmpty && hasEmpty) {
          // Mixed array: keep only non-empty items
          value = nonEmptyItems;
        } else if (!hasNonEmpty) {
          // All items are empty: save as empty array
          value = [];
        }
        // If all items are non-empty, keep the array as is
      }

      // Check if this setting requires restart
      if (meta.requires_restart) {
        // Add to pending changes instead of saving immediately
        const changeKey = `${category}.${key}`;
        this.pendingRestartChanges.set(changeKey, {
          category,
          key,
          value,
          metadata: meta,
        });
        console.log(`Pending restart change: ${changeKey}`, value);
      } else {
        // Save immediately for non-restart settings
        await this.appSettingsService.saveSetting(category, key, value);
      }
    } catch (error) {
      console.error('Error updating setting:', error);
      const currentValue = this.appSettingsService.loadSettingValue(category, key);
      this.settingsForm.get(category)?.get(key)?.setValue(currentValue, { emitEvent: false });
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close();
  }

  get selectedTab(): string {
    return this.tabs[this.selectedTabIndex]?.key || this.tabs[0].key;
  }

  get hasSearchResults(): boolean {
    return this.searchQuery.length > 0 && this.searchResults.length > 0;
  }

  get hasEmptySearchResults(): boolean {
    return this.searchQuery.length > 0 && this.searchResults.length === 0;
  }

  get isGeneralTab(): boolean {
    return this.selectedTab === 'general';
  }

  allowOnlyNumbers(event: KeyboardEvent): void {
    const charCode = event.key ? event.key.charCodeAt(0) : 0;
    if (charCode < 48 || charCode > 57) {
      event.preventDefault();
    }
  }
  getArrayItemControl(category: string, key: string, index: number): FormControl {
    const cacheKey = `${category}.${key}`;

    // Get or create cached controls for this array
    if (!this.arrayControlsCache.has(cacheKey)) {
      this.initializeArrayControls(category, key);
    }

    const controls = this.arrayControlsCache.get(cacheKey);
    if (!controls) {
      throw new Error(`Array controls not found for ${cacheKey}`);
    }

    // Ensure we have enough controls for the current index
    const parentControl = this.getFormControl(category, key);
    const array = parentControl.value as string[];

    while (controls.length <= index) {
      const newControl = new FormControl(array[controls.length] || '');
      this.setupArrayControlSubscription(newControl, category, key, controls.length);
      controls.push(newControl);
    }

    return controls[index];
  }

  private initializeArrayControls(category: string, key: string): void {
    const cacheKey = `${category}.${key}`;
    const parentControl = this.getFormControl(category, key);
    const array = parentControl.value as string[];

    const controls = array.map((value, index) => {
      const control = new FormControl(value);
      this.setupArrayControlSubscription(control, category, key, index);
      return control;
    });

    this.arrayControlsCache.set(cacheKey, controls);
  }

  private setupArrayControlSubscription(
    control: FormControl,
    category: string,
    key: string,
    index: number
  ): void {
    control.valueChanges.subscribe(newValue => {
      const parentControl = this.getFormControl(category, key);
      const currentArray = parentControl.value as string[];
      const newArray = [...currentArray];

      // Normalize values for comparison (treat null, undefined, and '' as equivalent)
      const normalizeValue = (val: unknown): string =>
        val == null || val === '' ? '' : String(val);
      const currentNormalized = normalizeValue(currentArray[index]);
      const newNormalized = normalizeValue(newValue);

      // Only update if the normalized value actually changed
      if (currentNormalized !== newNormalized) {
        newArray[index] = newNormalized;
        parentControl.setValue(newArray, { emitEvent: false });
        this.updateSetting(category, key, newArray);
      }
    });
  }

  addArrayItem(category: string, key: string): void {
    const control = this.getFormControl(category, key);
    const newArray = [...control.value, ''];
    control.setValue(newArray);

    // Clear cache to force recreation of controls
    const cacheKey = `${category}.${key}`;
    this.arrayControlsCache.delete(cacheKey);

    this.updateSetting(category, key, newArray);
  }

  removeArrayItem(category: string, key: string, index: number): void {
    const control = this.getFormControl(category, key);
    const newArray = control.value.filter((_: string, i: number) => i !== index);
    control.setValue(newArray);

    // Clear cache to force recreation of controls
    const cacheKey = `${category}.${key}`;
    this.arrayControlsCache.delete(cacheKey);

    this.updateSetting(category, key, newArray);
  }

  async openFilePicker(category: string, key: string): Promise<void> {
    try {
      let result: string | null = null;
      result = await this.fileSystemService.selectFile();

      if (result) {
        const control = this.getFormControl(category, key);
        control.setValue(result);
        // Trigger validation after setting the value
        control.updateValueAndValidity();
        this.updateSetting(category, key, result);
      }
    } catch (error) {
      console.error('Error selecting file:', error);
    }
  }

  openFolderPicker(category: string, key: string): void {
    this.fileSystemService
      .selectFolder()
      .then(result => {
        if (result) {
          const control = this.getFormControl(category, key);
          control.setValue(result);
          // Trigger validation after setting the value
          control.updateValueAndValidity();
          this.updateSetting(category, key, result);
        }
      })
      .catch(error => {
        console.error('Error selecting folder:', error);
      });
  }

  private arrayItemsPatternValidator(pattern: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || !Array.isArray(control.value)) return null;

      const regex = new RegExp(pattern);
      // Filter out empty strings to allow users to add empty items that they can fill in
      const nonEmptyItems = control.value.filter(item => item && item.trim());
      const invalidItems = nonEmptyItems.filter(item => !regex.test(item));

      return invalidItems.length > 0 ? { arrayItemPattern: { invalidItems } } : null;
    };
  }

  incrementNumber(category: string, key: string, meta: SettingMetadata): void {
    const control = this.getFormControl(category, key);
    const currentValue = control.value || 0;
    const newValue = currentValue + (meta.step || 1);
    const max = meta.max_value !== undefined ? meta.max_value : Infinity;

    if (newValue <= max) {
      control.setValue(newValue);
      this.updateSetting(category, key, newValue);
    }
  }

  decrementNumber(category: string, key: string, meta: SettingMetadata): void {
    const control = this.getFormControl(category, key);
    const currentValue = control.value || 0;
    const newValue = currentValue - (meta.step || 1);
    const min = meta.min_value !== undefined ? meta.min_value : 0;

    if (newValue >= min) {
      control.setValue(newValue);
      this.updateSetting(category, key, newValue);
    }
  }

  selectTab(index: number): void {
    this.selectedTabIndex = index;
  }

  filterSettings(searchText: string): void {
    this.searchQuery = searchText.toLowerCase();
    this.searchResults = [];

    if (!this.searchQuery) {
      this.filteredTabs = [...this.tabs];
      return;
    }

    for (const category of Object.keys(this.settingsForm.controls)) {
      const categoryControl = this.settingsForm.get(category);
      if (!categoryControl) continue;

      for (const key of Object.keys(categoryControl.value || {})) {
        const meta = this.getMetadata(category, key);

        if (
          meta.display_name.toLowerCase().includes(this.searchQuery) ||
          meta.help_text.toLowerCase().includes(this.searchQuery) ||
          key.toLowerCase().includes(this.searchQuery)
        ) {
          this.searchResults.push({ category, key });
        }
      }
    }

    this.filteredTabs = this.tabs.filter(
      tab =>
        tab.label.toLowerCase().includes(this.searchQuery) ||
        this.searchResults.some(result => result.category === tab.key)
    );
  }

  onSearchTextChange(searchText: string): void {
    this.filterSettings(searchText);
  }

  getCategoryDisplayName(category: string): string {
    const tab = this.tabs.find(tab => tab.key === category);
    return tab ? tab.label : category.charAt(0).toUpperCase() + category.slice(1);
  }

  getMetadata(category: string, key: string): SettingMetadata {
    return (
      this.metadata?.[`${category}.${key}`] || {
        display_name: key,
        help_text: '',
        value_type: 'string',
      }
    );
  }

  getObjectKeys(obj: Record<string, unknown>): string[] {
    return obj && typeof obj === 'object' ? Object.keys(obj) : [];
  }

  async resetSettings(): Promise<void> {
    try {
      const isReset = await this.appSettingsService.resetSettings();
      if (isReset) {
        await this.loadSettings();
      }
    } catch (error) {
      console.error('Error resetting settings:', error);
    }
  }

  getFormControl(category: string, key: string): FormControl {
    return this.settingsForm.get(category)?.get(key) as FormControl;
  }

  @HostListener('document:keydown.control.f', ['$event'])
  handleCtrlF(event: KeyboardEvent): void {
    event.preventDefault();
    this.toggleSearch();
  }

  toggleSearch(): void {
    this.searchVisible = !this.searchVisible;
    if (!this.searchVisible) {
      this.searchQuery = '';
      this.filterSettings('');
    }
  }

  getFilteredSettings(category: string): string[] {
    if (!this.searchQuery) {
      return this.getObjectKeys(this.settingsForm.get(category)?.value || []);
    }

    return this.getObjectKeys(this.settingsForm.get(category)?.value || []).filter(key => {
      const meta = this.getMetadata(category, key);
      return (
        meta.display_name.toLowerCase().includes(this.searchQuery) ||
        meta.help_text.toLowerCase().includes(this.searchQuery) ||
        key.toLowerCase().includes(this.searchQuery)
      );
    });
  }

  onPathInput(category: string, key: string): void {
    // Trigger validation when user types in path field
    const control = this.getFormControl(category, key);
    control.updateValueAndValidity();
  }

  /**
   * Debug method to test path validation - can be called from browser console
   */
  testPathValidation(category: string, key: string, testPath: string): void {
    const control = this.getFormControl(category, key);
    const originalValue = control.value;

    console.log('Testing path validation for:', { category, key, testPath });
    console.log('Original value:', originalValue);

    control.setValue(testPath);
    control.updateValueAndValidity();

    console.log('Control valid:', control.valid);
    console.log('Control errors:', control.errors);
    console.log('Validation message:', this.getValidationMessage(category, key));

    // Restore original value
    control.setValue(originalValue);
    control.updateValueAndValidity();
  }

  /**
   * Debug method to test validators from console
   * Usage: (window as any).preferencesModal.testValidator('crossPlatformPath', '/invalid<>path')
   */
  testValidator(validatorName: string, value: unknown): unknown {
    return this.validatorRegistry.testValidator(validatorName, value);
  }

  /**
   * Debug method to list all available validators
   * Usage: (window as any).preferencesModal.listValidators()
   */
  listValidators(): string[] {
    return this.validatorRegistry.getValidatorNames();
  }

  async savePendingChanges(): Promise<void> {
    if (this.pendingRestartChanges.size === 0) return;

    try {
      // Save all pending changes
      const savePromises = Array.from(this.pendingRestartChanges.values()).map(change =>
        this.appSettingsService.saveSetting(change.category, change.key, change.value)
      );

      await Promise.all(savePromises);

      // Clear pending changes
      this.pendingRestartChanges.clear();

      console.log('All pending restart-required changes saved successfully');
    } catch (error) {
      console.error('Error saving pending changes:', error);
    }
  }

  async discardPendingChanges(): Promise<void> {
    this.isDiscardingChanges = true;

    try {
      // Revert form controls to their original values
      for (const change of this.pendingRestartChanges.values()) {
        const originalValue = await this.appSettingsService.loadSettingValue(
          change.category,
          change.key
        );
        this.settingsForm
          .get(change.category)
          ?.get(change.key)
          ?.setValue(originalValue, { emitEvent: false });
      }

      // Clear pending changes
      this.pendingRestartChanges.clear();
      console.log('Pending changes discarded');
    } catch (error) {
      console.error('Error discarding pending changes:', error);
    } finally {
      this.isDiscardingChanges = false;
    }
  }

  getPendingChangesList(): {
    displayName: string;
    category: string;
    key: string;
    value: unknown;
  }[] {
    return Array.from(this.pendingRestartChanges.values()).map(change => ({
      displayName: change.metadata.display_name,
      category: change.category,
      key: change.key,
      value: change.value,
    }));
  }

  isArray(value: unknown): boolean {
    return Array.isArray(value);
  }

  asArray(value: unknown): unknown[] {
    return value as unknown[];
  }

  scrollToPendingChanges(): void {
    const pendingSection = document.querySelector('.pending-changes-section');
    if (pendingSection) {
      pendingSection.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
  }

  // Store the original value of a setting
  storeOriginalValue(category: string, key: string): void {
    const control = this.getFormControl(category, key);
    if (control) {
      const originalKey = `${category}.${key}`;
      // Store a deep copy for complex values like arrays
      const value = control.value;
      this.originalValues.set(originalKey, Array.isArray(value) ? [...value] : value);
    }
  }

  // Handle input blur event to update setting if value changed
  onInputBlur(category: string, key: string): void {
    const control = this.getFormControl(category, key);
    if (!control) return;

    const originalKey = `${category}.${key}`;
    const originalValue = this.originalValues.get(originalKey);
    const currentValue = control.value;

    // Compare values carefully, handling arrays and different types
    const valuesEqual = (a: unknown, b: unknown): boolean => {
      if (a === b) return true;
      if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((val, idx) => val === b[idx]);
      }
      // Normalize empty values for comparison
      const normalizeEmpty = (val: unknown): string =>
        val === null || val === undefined || val === '' ? '' : String(val);
      return normalizeEmpty(a) === normalizeEmpty(b);
    };

    // Only update if the value actually changed
    if (!valuesEqual(originalValue, currentValue)) {
      this.updateSetting(category, key, currentValue);
    }

    // Clean up stored value
    this.originalValues.delete(originalKey);
  }
}
