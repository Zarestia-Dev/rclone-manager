import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit, inject } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  FormsModule,
  ValidatorFn,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { openUrl } from '@tauri-apps/plugin-opener';

// Services
import { AnimationsService } from '../../../../shared/services/animations.service';
import { AppSettingsService, FileSystemService, RclonePasswordService } from '@app/services';
import { ValidatorRegistryService } from '../../../../shared/services/validator-registry.service';
import { NotificationService } from '../../../../shared/services/notification.service';
import { SettingMetadata } from '@app/types';
import { MatSelectModule } from '@angular/material/select';

// Dynamic page type: 'home' for overview, 'security' static, or block name from RClone
type PageType = 'home' | 'security' | string;

// Dynamic page configuration from RClone blocks
interface DynamicPage {
  key: string; // Block name from RClone (vfs, mount, filter, etc.)
  label: string; // Display name
  icon: string; // Material icon name
  description: string; // Description text
  category: string; // Block category from RClone
}

interface SettingGroup {
  key: PageType;
  label: string;
  icon: string;
  description: string;
  settings?: { category: string; key: string }[];
}

// RClone API Option interfaces
interface RCloneOption {
  Name: string;
  FieldName: string;
  Help: string;
  Groups?: string;
  Default: unknown;
  Value: unknown;
  Hide: number;
  Required: boolean;
  IsPassword: boolean;
  NoPrefix: boolean;
  Advanced: boolean;
  Exclusive: boolean;
  Sensitive: boolean;
  DefaultStr: string;
  ValueStr: string;
  Type: string;
  ShortOpt?: string;
  Examples?: { Value: string; Help: string }[];
}

type RCloneOptionsInfo = Record<string, RCloneOption[]>;

@Component({
  selector: 'app-rclone-config-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule,
    FormsModule,
    MatTooltipModule,
    MatTabsModule,
    MatSelectModule,
  ],
  templateUrl: './rclone-config-modal.component.html',
  styleUrl: './rclone-config-modal.component.scss',
  animations: [AnimationsService.slideOverlay()],
})
export class RcloneConfigModalComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<RcloneConfigModalComponent>);
  private fb = inject(FormBuilder);
  private appSettingsService = inject(AppSettingsService);
  private fileSystemService = inject(FileSystemService);
  private validatorRegistry = inject(ValidatorRegistryService);
  private notificationService = inject(NotificationService);
  private passwordService = inject(RclonePasswordService);
  private snackBar = inject(MatSnackBar);

  currentPage: PageType = 'home';
  settingsForm: FormGroup;
  metadata: Record<string, SettingMetadata> = {};
  isLoading = true;
  scrolled = false;

  // Track which dependent settings are visible
  visibilityMap = new Map<string, boolean>();

  // Dynamic pages loaded from RClone blocks
  dynamicPages: DynamicPage[] = [];

  // Dynamically built setting groups based on RClone blocks
  settingGroups: SettingGroup[] = [];

  // Icon mapping for RClone blocks
  private readonly blockIconMap: Record<string, string> = {
    vfs: 'vfs',
    mount: 'mount',
    filter: 'filter',
    main: 'gear',
    log: 'file-lines',
    http: 'globe',
    rc: 'server',
    dlna: 'tv',
    ftp: 'file-arrow-up',
    nfs: 'network-wired',
    proxy: 'shield-halved',
    restic: 'box-archive',
    s3: 'bucket',
    sftp: 'lock',
    webdav: 'cloud',
  };

  // Description mapping for RClone blocks
  private readonly blockDescriptionMap: Record<string, string> = {
    vfs: 'Virtual File System caching and performance settings',
    mount: 'Mount-specific options and FUSE configuration',
    filter: 'File filtering rules and patterns',
    main: 'General RClone operation and transfer settings',
    log: 'Logging configuration and output settings',
    http: 'HTTP server settings',
    rc: 'Remote control server configuration',
    dlna: 'DLNA server settings',
    ftp: 'FTP server configuration',
    nfs: 'NFS server settings',
    proxy: 'Proxy authentication settings',
    restic: 'Restic server configuration',
    s3: 'S3 server settings',
    sftp: 'SFTP server configuration',
    webdav: 'WebDAV server settings',
  };

  // RClone options loaded from API
  rcloneOptions: RCloneOptionsInfo = {};
  rcloneOptionsByBlock: Record<string, RCloneOption[]> = {};

  // Form controls for RClone options (key: option.Name, value: FormControl)
  rcloneOptionControls: Record<string, FormControl> = {};

  // Map option names to their block names (e.g., { "log_file_compress": "log" })
  optionToBlockMap: Record<string, string> = {};

  // Map option Names (snake_case) to their FieldNames (PascalCase for API)
  // e.g., { "ask_password": "AskPassword", "log_file_compress": "LogFileCompress" }
  optionToFieldNameMap: Record<string, string> = {};

  // Track which options are currently being saved
  savingOptions = new Set<string>();

  // Search functionality
  searchQuery = '';

  // Security tab management
  selectedSecurityTab = 0;

  // Password management forms
  overviewForm: FormGroup;
  encryptionForm: FormGroup;
  changePasswordForm: FormGroup;

  // Status flags for password manager
  hasStoredPassword = false;
  hasEnvPassword = false;
  isConfigEncrypted: boolean | null = null;
  isPasswordLoading = false;

  // Loading states for password operations
  passwordLoading = {
    isValidating: false,
    isEncrypting: false,
    isUnencrypting: false,
    isChangingPassword: false,
    isStoringPassword: false,
    isRemovingPassword: false,
    isSettingEnv: false,
    isClearingEnv: false,
  };

  constructor() {
    this.settingsForm = this.fb.group({});
    this.overviewForm = this.createOverviewForm();
    this.encryptionForm = this.createEncryptionForm();
    this.changePasswordForm = this.createChangePasswordForm();
  }

  async ngOnInit(): Promise<void> {
    // Load RClone blocks first to create dynamic pages
    await this.loadRCloneBlocks();

    await this.loadSettings();

    // Load password manager status when on security page
    if (this.isSecurityPage) {
      await this.loadCachedPasswordStatusQuickly();
      this.refreshPasswordStatus().catch(err => {
        console.error('Failed to load password status:', err);
        this.isPasswordLoading = false;
      });
    }
  }

  private async loadCachedPasswordStatusQuickly(): Promise<void> {
    try {
      const cachedStatus = await this.passwordService.getCachedEncryptionStatus();
      if (cachedStatus !== null) {
        this.isConfigEncrypted = cachedStatus;
      }
    } catch (err) {
      console.debug('No cached status available:', err);
    }
  }

  /**
   * Load RClone option blocks and create dynamic pages
   */
  private async loadRCloneBlocks(): Promise<void> {
    try {
      // Import invoke dynamically
      const { invoke } = await import('@tauri-apps/api/core');

      // Get blocks from RClone API
      const blocksResponse = await invoke<{ options: string[] }>('get_option_blocks');
      const blocks = blocksResponse.options;

      // Get all options info from RClone API
      const optionsResponse = await invoke<RCloneOptionsInfo>('get_all_options_info');
      this.rcloneOptions = optionsResponse;

      // Filter blocks to show (exclude some server-specific blocks)
      const blocksToShow = blocks.filter(
        block =>
          !['http', 'rc', 'dlna', 'ftp', 'nfs', 'proxy', 'restic', 's3', 'sftp', 'webdav'].includes(
            block
          )
      );

      // Organize options by block for easy access
      for (const block of blocksToShow) {
        this.rcloneOptionsByBlock[block] = this.rcloneOptions[block] || [];
      }

      // Create dynamic pages from blocks
      this.dynamicPages = blocksToShow.map(block => ({
        key: block,
        label: this.getBlockLabel(block),
        icon: this.blockIconMap[block] || 'settings',
        description: this.blockDescriptionMap[block] || `${this.capitalizeFirst(block)} settings`,
        category: block,
      }));

      console.log('Loaded RClone blocks:', this.dynamicPages);
      console.log('Loaded RClone options:', this.rcloneOptionsByBlock);

      // Create form controls for all RClone options
      this.createRCloneOptionControls();
    } catch (error) {
      console.error('Error loading RClone blocks:', error);
      // Continue with empty blocks on error
      this.dynamicPages = [];
      this.rcloneOptions = {};
      this.rcloneOptionsByBlock = {};
    }
  }

  /**
   * Create FormControls for all RClone options with appropriate validators
   */
  private createRCloneOptionControls(): void {
    for (const block in this.rcloneOptionsByBlock) {
      const options = this.rcloneOptionsByBlock[block];

      for (const option of options) {
        // Map option name to its block for API calls
        this.optionToBlockMap[option.Name] = block;

        // Map option Name (snake_case) to FieldName (PascalCase) for API calls
        this.optionToFieldNameMap[option.Name] = option.FieldName;

        // Get validators for this option type
        const validators = this.getRCloneOptionValidators(option);

        // Get initial value - convert boolean strings to actual booleans
        let initialValue: unknown = option.ValueStr || option.DefaultStr;
        if (option.Type === 'bool') {
          initialValue = option.ValueStr === 'true' || option.DefaultStr === 'true';
        } else if (option.Type === 'DumpFlags' && typeof initialValue === 'string') {
          // DumpFlags should be an array for multi-select
          initialValue = initialValue ? initialValue.split(',').map(v => v.trim()) : [];
        }

        // Create FormControl with current value and validators
        const control = new FormControl(initialValue, validators);

        // Store the control
        this.rcloneOptionControls[option.Name] = control;
      }
    }

    console.log(
      'Created form controls for RClone options:',
      Object.keys(this.rcloneOptionControls)
    );
    console.log('Option to block mapping:', this.optionToBlockMap);
  }

  /**
   * Save RClone option value to API (called on blur/change)
   */
  async saveRCloneOption(optionName: string): Promise<void> {
    const control = this.getRCloneOptionControl(optionName);

    // Don't save if invalid or already saving
    if (control.invalid || this.savingOptions.has(optionName)) {
      return;
    }

    try {
      this.savingOptions.add(optionName);

      // Disable the control while saving
      control.disable();

      // Get the option to determine its type
      const option = this.getRCloneOption(optionName);
      if (!option) {
        console.error(`Option ${optionName} not found`);
        return;
      }

      // Get the block name for this option
      const blockName = this.optionToBlockMap[optionName];
      if (!blockName) {
        console.error(`Block name not found for option ${optionName}`);
        this.notificationService.showError(`Cannot save ${optionName}: block name unknown`);
        return;
      }

      // Get the FieldName (PascalCase) for API call
      const fieldName = this.optionToFieldNameMap[optionName];
      if (!fieldName) {
        console.error(`FieldName not found for option ${optionName}`);
        this.notificationService.showError(`Cannot save ${optionName}: field name unknown`);
        return;
      }

      // Convert value based on type
      let valueToSave = control.value;

      // Handle boolean conversion
      if (option.Type === 'bool') {
        valueToSave = control.value === true || control.value === 'true';
      }
      // Handle array types (DumpFlags)
      else if (option.Type === 'DumpFlags' && Array.isArray(control.value)) {
        valueToSave = control.value.join(',');
      }
      // Handle empty strings (convert to null or appropriate default)
      else if (valueToSave === '') {
        valueToSave = null;
      }

      // Import invoke dynamically
      const { invoke } = await import('@tauri-apps/api/core');

      // Call the backend to save the option with block name and FieldName (PascalCase)
      await invoke('set_rclone_option', {
        blockName,
        optionName: fieldName, // Use PascalCase FieldName for API
        value: valueToSave,
      });

      // Also save to local rclone_options.json file for persistence
      await invoke('save_rclone_backend_option', {
        block: blockName,
        option: fieldName, // Use PascalCase FieldName
        value: valueToSave,
      });

      // Show success notification (using display name)
      this.notificationService.showSuccess(`Saved: ${optionName}`);

      console.log(
        `✅ Saved option ${optionName} (${fieldName}) in block ${blockName}:`,
        valueToSave
      );
      console.log(`💾 Persisted to rclone_options.json`);
    } catch (error) {
      console.error(`Failed to save option ${optionName}:`, error);

      // Show error notification
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.notificationService.showError(`Failed to save ${optionName}: ${errorMessage}`);

      // Revert the control value to the original
      const option = this.getRCloneOption(optionName);
      if (option) {
        if (option.Type === 'bool') {
          control.setValue(option.ValueStr === 'true', { emitEvent: false });
        } else if (option.Type === 'DumpFlags') {
          control.setValue(option.ValueStr ? option.ValueStr.split(',').map(v => v.trim()) : [], {
            emitEvent: false,
          });
        } else {
          control.setValue(option.ValueStr || option.DefaultStr, { emitEvent: false });
        }
      }
    } finally {
      this.savingOptions.delete(optionName);
      // Re-enable the control after saving
      control.enable();
    }
  }

  /**
   * Check if an option is currently being saved
   */
  isOptionSaving(optionName: string): boolean {
    return this.savingOptions.has(optionName);
  }

  /**
   * Get FormControl for a specific RClone option
   */
  getRCloneOptionControl(optionName: string): FormControl {
    // Return existing control or create a temporary one (should not happen in practice)
    return this.rcloneOptionControls[optionName] || new FormControl('');
  }

  /**
   * Get human-readable label for a block
   */
  private getBlockLabel(block: string): string {
    const labelMap: Record<string, string> = {
      vfs: 'VFS Settings',
      mount: 'Mount Settings',
      filter: 'Filter Settings',
      main: 'Main Settings',
      log: 'Logging Settings',
    };
    return labelMap[block] || `${this.capitalizeFirst(block)} Settings`;
  }

  async loadSettings(): Promise<void> {
    try {
      this.isLoading = true;
      const response = await this.appSettingsService.loadSettings();
      this.metadata = response.metadata;

      // Build form only for RClone-related settings (settings with a group)
      const coreSettings = response.settings['core'];
      const formGroup = this.fb.group({});

      // Group settings by their group field
      const settingsByGroup: Record<string, { category: string; key: string }[]> = {};

      for (const [key, value] of Object.entries(coreSettings)) {
        const meta = this.getMetadata('core', key);

        // Only include settings that have a group assigned (RClone-specific settings)
        if (!meta.group) {
          continue;
        }

        // Add to appropriate group
        if (!settingsByGroup[meta.group]) {
          settingsByGroup[meta.group] = [];
        }
        settingsByGroup[meta.group].push({ category: 'core', key });

        const validators = this.getValidators(meta);
        formGroup.addControl(key, this.fb.control(value, validators));

        // Subscribe to changes for immediate updates
        formGroup.get(key)?.valueChanges.subscribe(newValue => {
          this.updateSetting('core', key, newValue);
          // Update visibility if this is a dependency parent
          this.updateVisibilityMap();
        });
      }

      this.settingsForm = this.fb.group({ core: formGroup });

      // Build setting groups from dynamic pages
      this.settingGroups = this.dynamicPages.map(page => ({
        key: page.key,
        label: page.label,
        icon: page.icon,
        description: page.description,
        settings: settingsByGroup[page.key] || [],
      }));

      // Initialize visibility map
      this.updateVisibilityMap();

      this.isLoading = false;
    } catch (error) {
      this.isLoading = false;
      console.error('Error loading settings:', error);
      this.notificationService.showError('Failed to load settings');
    }
  }

  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
  getValidators(meta: SettingMetadata): ValidatorFn[] {
    const validators: ValidatorFn[] = [];

    if (meta.required) {
      validators.push(Validators.required);
    }

    // Try to get validator from registry
    const registryValidator = this.validatorRegistry.createValidatorFromMetadata(meta);
    if (registryValidator) {
      validators.push(registryValidator);
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

    return validators;
  }

  getValidationMessage(key: string): string {
    const ctrl = this.getFormControl(key);
    const meta = this.getMetadata('core', key);

    if (ctrl.hasError('required')) {
      return meta.validation_message || 'This field is required';
    }

    if (ctrl.hasError('portRange')) {
      return ctrl.getError('portRange').message || 'Invalid port range';
    }

    if (ctrl.hasError('proxyUrl')) {
      return ctrl.getError('proxyUrl').message || 'Invalid proxy URL';
    }

    if (ctrl.hasError('pattern')) {
      const patternError = ctrl.getError('pattern');
      return patternError.message || meta.validation_message || 'Invalid format';
    }

    if (ctrl.hasError('min')) {
      return `Minimum value is ${meta.min_value}`;
    }

    if (ctrl.hasError('max')) {
      return `Maximum value is ${meta.max_value}`;
    }

    return 'Invalid value';
  }

  async updateSetting(category: string, key: string, value: unknown): Promise<void> {
    const control = this.getFormControl(key);

    if (!control?.valid) {
      return;
    }

    try {
      const meta = this.getMetadata(category, key);

      // Handle different value types
      if (meta.value_type === 'number') {
        value = Number(value);
      }

      await this.appSettingsService.saveSetting(category, key, value);
    } catch (error) {
      console.error('Error updating setting:', error);
      this.notificationService.showError('Failed to update setting');
    }
  }

  getFormControl(key: string): FormControl {
    return this.settingsForm.get('core')?.get(key) as FormControl;
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

  incrementNumber(key: string, meta: SettingMetadata): void {
    const control = this.getFormControl(key);
    const currentValue = control.value || 0;
    const newValue = currentValue + (meta.step || 1);
    const max = meta.max_value !== undefined ? meta.max_value : Infinity;

    if (newValue <= max) {
      control.setValue(newValue);
    }
  }

  decrementNumber(key: string, meta: SettingMetadata): void {
    const control = this.getFormControl(key);
    const currentValue = control.value || 0;
    const newValue = currentValue - (meta.step || 1);
    const min = meta.min_value !== undefined ? meta.min_value : 0;

    if (newValue >= min) {
      control.setValue(newValue);
    }
  }

  async openFilePicker(key: string): Promise<void> {
    try {
      const result = await this.fileSystemService.selectFile();
      if (result) {
        const control = this.getFormControl(key);
        control.setValue(result);
        control.updateValueAndValidity();
      }
    } catch (error) {
      console.error('Error selecting file:', error);
      this.notificationService.showError('Failed to select file');
    }
  }

  async openFolderPicker(key: string): Promise<void> {
    try {
      const result = await this.fileSystemService.selectFolder();
      if (result) {
        const control = this.getFormControl(key);
        control.setValue(result);
        control.updateValueAndValidity();
      }
    } catch (error) {
      console.error('Error selecting folder:', error);
      this.notificationService.showError('Failed to select folder');
    }
  }

  onScroll(content: HTMLElement): void {
    this.scrolled = content.scrollTop > 10;
  }

  async navigateTo(page: PageType): Promise<void> {
    this.currentPage = page;

    // Load password manager status when navigating to security page
    if (page === 'security') {
      this.isPasswordLoading = true;
      await this.loadCachedPasswordStatusQuickly();
      this.refreshPasswordStatus().catch(err => {
        console.error('Failed to load password status:', err);
        this.isPasswordLoading = false;
      });
    }
  }

  getSettingsForCurrentPage(): { category: string; key: string }[] {
    if (this.currentPage === 'home') {
      return [];
    }
    const group = this.settingGroups.find(g => g.key === this.currentPage);
    return group?.settings || [];
  }

  /**
   * Get RClone options for the current page/block
   */
  getRCloneOptionsForCurrentPage(): RCloneOption[] {
    if (this.currentPage === 'home' || this.currentPage === 'security') {
      return [];
    }
    const options = this.rcloneOptionsByBlock[this.currentPage] || [];
    return this.filterOptionsBySearch(options);
  }

  /**
   * Filter options based on search query
   */
  private filterOptionsBySearch(options: RCloneOption[]): RCloneOption[] {
    if (!this.searchQuery || this.searchQuery.trim() === '') {
      return options;
    }

    const query = this.searchQuery.toLowerCase().trim();
    return options.filter(
      option =>
        option.Name.toLowerCase().includes(query) ||
        option.FieldName.toLowerCase().includes(query) ||
        option.Help.toLowerCase().includes(query) ||
        (option.Groups && option.Groups.toLowerCase().includes(query))
    );
  }

  /**
   * Clear search query
   */
  clearSearch(): void {
    this.searchQuery = '';
  }

  /**
   * Check if search is active
   */
  get hasSearchQuery(): boolean {
    return this.searchQuery.trim().length > 0;
  }

  /**
   * Get count of filtered options
   */
  get filteredOptionsCount(): number {
    const options = this.rcloneOptionsByBlock[this.currentPage] || [];
    return this.filterOptionsBySearch(options).length;
  }

  /**
   * Get total options count for current page
   */
  get totalOptionsCount(): number {
    return (this.rcloneOptionsByBlock[this.currentPage] || []).length;
  }

  /**
   * Get a specific RClone option by name from current block
   */
  getRCloneOption(name: string): RCloneOption | undefined {
    const options = this.getRCloneOptionsForCurrentPage();
    return options.find(opt => opt.Name === name);
  }

  // Check if current page is security
  get isSecurityPage(): boolean {
    return this.currentPage === 'security';
  }

  // Password Manager Form Creation
  private createOverviewForm(): FormGroup {
    return this.fb.group({
      password: ['', [Validators.required, this.createPasswordValidator()]],
    });
  }

  private createEncryptionForm(): FormGroup {
    return this.fb.group(
      {
        password: ['', [Validators.required, this.createPasswordValidator()]],
        confirmPassword: ['', [Validators.required]],
      },
      { validators: this.passwordMatchValidator }
    );
  }

  private createChangePasswordForm(): FormGroup {
    return this.fb.group(
      {
        currentPassword: ['', [Validators.required, this.createPasswordValidator()]],
        newPassword: ['', [Validators.required, this.createPasswordValidator()]],
        confirmNewPassword: ['', [Validators.required]],
      },
      { validators: this.newPasswordMatchValidator }
    );
  }

  // Proxy Credential Form Creation
  private createProxyCredentialForm(): FormGroup {
    return this.fb.group({
      http: [''],
      https: [''],
      socks5: [''],
    });
  }

  // Password validators
  private createPasswordValidator() {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;
      if (!value) return null;

      if (value.length < 3) {
        return {
          minLength: {
            message: 'Password must be at least 3 characters',
            actualLength: value.length,
            requiredLength: 3,
          },
        };
      }

      if (/['"]/.test(value)) {
        return { invalidChars: { message: 'Password cannot contain quotes' } };
      }

      return null;
    };
  }

  private passwordMatchValidator = (group: AbstractControl): ValidationErrors | null => {
    const password = group.get('password')?.value;
    const confirmPassword = group.get('confirmPassword')?.value;

    if (!password || !confirmPassword) return null;

    return password === confirmPassword
      ? null
      : { passwordMismatch: { message: 'Passwords do not match' } };
  };

  private newPasswordMatchValidator = (group: AbstractControl): ValidationErrors | null => {
    const newPassword = group.get('newPassword')?.value;
    const confirmNewPassword = group.get('confirmNewPassword')?.value;

    if (!newPassword || !confirmNewPassword) return null;

    return newPassword === confirmNewPassword
      ? null
      : { passwordMismatch: { message: 'Passwords do not match' } };
  };

  // Password Manager Methods
  get canValidatePassword(): boolean {
    return (
      (this.overviewForm.get('password')?.valid && this.overviewForm.get('password')?.enabled) ||
      false
    );
  }

  get canEncrypt(): boolean {
    return this.encryptionForm.valid && this.encryptionForm.enabled;
  }

  get canUnencrypt(): boolean {
    return (
      (this.encryptionForm.get('password')?.valid &&
        this.encryptionForm.get('password')?.enabled) ||
      false
    );
  }

  get canChangePassword(): boolean {
    return this.changePasswordForm.valid && this.changePasswordForm.enabled;
  }

  get canStorePassword(): boolean {
    return (
      (this.overviewForm.get('password')?.valid && this.overviewForm.get('password')?.enabled) ||
      false
    );
  }

  get isLoadingPassword(): boolean {
    return this.isPasswordLoading || this.isConfigEncrypted === null;
  }

  get isEncryptedConfig(): boolean {
    return this.isConfigEncrypted === true;
  }

  get isUnencryptedConfig(): boolean {
    return this.isConfigEncrypted === false;
  }

  switchToEncryptionTab(): void {
    this.selectedSecurityTab = 1;
  }

  learnMoreAboutEncryption(): void {
    openUrl('https://rclone.org/docs/#configuration-encryption').catch(err => {
      console.error('Failed to open URL:', err);
      this.showError('Failed to open documentation');
    });
  }

  async validatePassword(): Promise<void> {
    const passwordControl = this.overviewForm.get('password');
    if (!passwordControl?.valid || !passwordControl?.value) return;

    this.passwordLoading.isValidating = true;
    try {
      await this.passwordService.validatePassword(passwordControl.value);
      this.showSuccess('Password is valid!');
    } catch (error) {
      passwordControl.setErrors({ apiError: { message: 'Invalid password' } });
      this.showError(this.getErrorMessage(error));
    } finally {
      this.passwordLoading.isValidating = false;
    }
  }

  async storePassword(): Promise<void> {
    if (!this.canStorePassword) return;

    const passwordControl = this.overviewForm.get('password');
    if (!passwordControl?.value) return;

    this.passwordLoading.isStoringPassword = true;
    try {
      await this.passwordService.validatePassword(passwordControl.value);
      await this.passwordService.storePassword(passwordControl.value);
      this.resetPasswordForms();
      this.showSuccess('Password stored securely in system keychain');
      await this.refreshPasswordStatus();
    } catch (error) {
      this.showError(`Failed to store password: ${this.getErrorMessage(error)}`);
    } finally {
      this.passwordLoading.isStoringPassword = false;
    }
  }

  async removePassword(): Promise<void> {
    this.passwordLoading.isRemovingPassword = true;
    try {
      await this.passwordService.removeStoredPassword();
      this.showSuccess('Stored password removed from system keychain');
      await this.refreshPasswordStatus();
    } catch (err) {
      console.error('Remove password error:', err);
      this.showError('Failed to remove stored password');
    } finally {
      this.passwordLoading.isRemovingPassword = false;
    }
  }

  async encryptConfig(): Promise<void> {
    if (!this.canEncrypt) return;

    const passwordControl = this.encryptionForm.get('password');
    if (!passwordControl?.value) return;

    this.passwordLoading.isEncrypting = true;
    try {
      await this.passwordService.encryptConfig(passwordControl.value);
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Configuration encrypted successfully');
      this.resetPasswordForms();
      await this.refreshPasswordStatus();
    } catch (error) {
      this.showError(`Failed to encrypt configuration: ${this.getErrorMessage(error)}`);
    } finally {
      this.passwordLoading.isEncrypting = false;
    }
  }

  async unencryptConfig(): Promise<void> {
    if (!this.canUnencrypt) return;

    const passwordControl = this.encryptionForm.get('password');
    if (!passwordControl?.value) return;

    this.passwordLoading.isUnencrypting = true;
    try {
      await this.passwordService.unencryptConfig(passwordControl.value);
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Configuration unencrypted successfully');
      this.resetPasswordForms();
      await this.refreshPasswordStatus();
    } catch (error) {
      this.showError(`Failed to unencrypt configuration: ${this.getErrorMessage(error)}`);
    } finally {
      this.passwordLoading.isUnencrypting = false;
    }
  }

  async changePassword(): Promise<void> {
    if (!this.canChangePassword) return;

    const currentPasswordControl = this.changePasswordForm.get('currentPassword');
    const newPasswordControl = this.changePasswordForm.get('newPassword');

    if (!currentPasswordControl?.value || !newPasswordControl?.value) return;

    this.passwordLoading.isChangingPassword = true;
    try {
      await this.passwordService.changeConfigPassword(
        currentPasswordControl.value,
        newPasswordControl.value
      );
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Password changed successfully');
      this.resetPasswordForms();
      await this.refreshPasswordStatus();
    } catch (error) {
      this.showError(`Failed to change password: ${this.getErrorMessage(error)}`);
    } finally {
      this.passwordLoading.isChangingPassword = false;
    }
  }

  async setEnvPassword(): Promise<void> {
    this.passwordLoading.isSettingEnv = true;
    try {
      const storedPassword = await this.passwordService.getStoredPassword();
      if (storedPassword) {
        await this.passwordService.setConfigPasswordEnv(storedPassword);
        this.showSuccess('Environment variable set');
        await this.refreshPasswordStatus();
      } else {
        this.showError('No stored password found');
      }
    } catch (err) {
      console.error('Set env password error:', err);
      this.showError('Failed to set environment variable');
    } finally {
      this.passwordLoading.isSettingEnv = false;
    }
  }

  async clearEnvPassword(): Promise<void> {
    this.passwordLoading.isClearingEnv = true;
    try {
      await this.passwordService.clearPasswordEnvironment();
      this.showSuccess('Environment variable cleared');
      await this.refreshPasswordStatus();
    } catch (err) {
      console.error('Clear env password error:', err);
      this.showError('Failed to clear environment variable');
    } finally {
      this.passwordLoading.isClearingEnv = false;
    }
  }

  private async refreshPasswordStatus(): Promise<void> {
    try {
      const cachedStatus = await this.passwordService.getCachedEncryptionStatus();
      if (cachedStatus !== null && this.isPasswordLoading) {
        this.isConfigEncrypted = cachedStatus;
      }

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Status check timeout')), 5000);
      });

      const statusPromise = Promise.all([
        this.passwordService.hasStoredPassword(),
        this.passwordService.hasConfigPasswordEnv(),
        this.passwordService.isConfigEncryptedCached(),
      ]);

      const [hasStored, hasEnv, isEncrypted] = (await Promise.race([
        statusPromise,
        timeoutPromise,
      ])) as [boolean, boolean, boolean];

      this.hasStoredPassword = hasStored;
      this.hasEnvPassword = hasEnv;
      this.isConfigEncrypted = isEncrypted;
    } catch (error) {
      console.error('Failed to refresh password status:', error);
      if (this.isConfigEncrypted === null) {
        this.showError('Failed to load configuration status');
        this.isConfigEncrypted = false;
      }
      this.hasStoredPassword = false;
      this.hasEnvPassword = false;
    } finally {
      this.isPasswordLoading = false;
    }
  }

  private resetPasswordForms(): void {
    this.overviewForm.reset();
    this.encryptionForm.reset();
    this.changePasswordForm.reset();
  }

  private showSuccess(message: string): void {
    this.snackBar.open(`✅ ${message}`, 'Close', {
      duration: 3000,
      panelClass: ['success-snackbar'],
    });
  }

  private showError(message: string): void {
    this.snackBar.open(`❌ ${message}`, 'Close', {
      duration: 5000,
      panelClass: ['error-snackbar'],
    });
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // ============================================================================
  // RClone Option Validators
  // ============================================================================

  /**
   * Get validators for a specific RClone option based on its type and constraints
   */
  getRCloneOptionValidators(option: RCloneOption): ValidatorFn[] {
    const validators: ValidatorFn[] = [];

    // Required validation
    if (option.Required) {
      validators.push(Validators.required);
    }

    // Type-specific validators
    switch (option.Type) {
      case 'int':
      case 'int64':
      case 'uint32':
        validators.push(this.integerValidator());
        // TODO: Add min/max from option metadata when available
        break;

      case 'float64':
        validators.push(this.floatValidator());
        break;

      case 'Duration':
        validators.push(this.durationValidator());
        break;

      case 'SizeSuffix':
        validators.push(this.sizeSuffixValidator());
        break;

      case 'BwTimetable':
        validators.push(this.bwTimetableValidator());
        break;

      case 'FileMode':
        validators.push(this.fileModeValidator());
        break;

      case 'Time':
        validators.push(this.timeValidator());
        break;

      case 'SpaceSepList':
        validators.push(this.spaceSepListValidator());
        break;

      case 'stringArray':
        // Arrays are handled differently in the UI
        break;

      case 'DumpFlags':
        // Multi-select handled by mat-select
        break;

      case 'Bits':
        validators.push(this.bitsValidator());
        break;

      case 'LogLevel':
      case 'CacheMode':
        // Enum validators handled by mat-select with Examples
        if (option.Examples) {
          validators.push(this.enumValidator(option.Examples.map(e => e.Value)));
        }
        break;
    }

    // Exclusive options (enum-like)
    if (option.Exclusive && option.Examples) {
      validators.push(this.enumValidator(option.Examples.map(e => e.Value)));
    }

    return validators;
  }

  /**
   * Validator for integer types (int, int64, uint32)
   */
  private integerValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null; // Empty is valid (unless required)

      const value = control.value.toString().trim();

      // Allow common RClone defaults
      if (['off', 'unlimited', 'none'].includes(value.toLowerCase())) {
        return null;
      }

      if (!/^-?\d+$/.test(value)) {
        return { integer: { value, message: 'Must be a valid integer or "off"' } };
      }

      const num = parseInt(value, 10);
      if (isNaN(num)) {
        return { integer: { value, message: 'Must be a valid integer or "off"' } };
      }

      return null;
    };
  }

  /**
   * Validator for float64 type
   */
  private floatValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow common RClone defaults
      if (['off', 'unlimited', 'none'].includes(value.toLowerCase())) {
        return null;
      }

      if (!/^-?\d+(\.\d+)?$/.test(value)) {
        return { float: { value, message: 'Must be a valid decimal number or "off"' } };
      }

      const num = parseFloat(value);
      if (isNaN(num)) {
        return { float: { value, message: 'Must be a valid decimal number or "off"' } };
      }

      return null;
    };
  }

  /**
   * Validator for Duration format (e.g., "1h30m45s", "5m", "1h")
   */
  private durationValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow common RClone defaults
      if (['off', '0', '0s', 'unlimited', 'none', '-1', '-1s'].includes(value.toLowerCase())) {
        return null;
      }

      // Duration format: combinations of number + unit (ns, us/µs, ms, s, m, h)
      const durationPattern = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

      if (!durationPattern.test(value)) {
        return {
          duration: {
            value,
            message: 'Invalid duration format. Use: 1h30m45s, 5m0s, 1h, or "off"',
          },
        };
      }

      return null;
    };
  } /**
   * Validator for SizeSuffix format (e.g., "100Ki", "16Mi", "1Gi")
   */
  private sizeSuffixValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow common RClone defaults
      if (['off', '0', 'unlimited', 'none', '-1'].includes(value.toLowerCase())) {
        return null;
      }

      // Size format: number + optional suffix (b, B, k, K, Ki, M, Mi, G, Gi, T, Ti, P, Pi, E, Ei)
      const sizePattern = /^\d+(\.\d+)?(b|B|k|K|Ki|M|Mi|G|Gi|T|Ti|P|Pi|E|Ei)?$/;

      if (!sizePattern.test(value)) {
        return {
          sizeSuffix: {
            value,
            message: 'Invalid size format. Use: 100Ki, 16Mi, 1Gi, 2.5G, or "off"',
          },
        };
      }

      return null;
    };
  } /**
   * Validator for BwTimetable format (bandwidth with optional timetable)
   */
  private bwTimetableValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow common RClone defaults
      if (['off', '0', 'unlimited', 'none', '-1'].includes(value.toLowerCase())) {
        return null;
      }

      // Simple bandwidth: number + optional suffix (B, K, M, G, T, P)
      const simpleBandwidth = /^\d+(\.\d+)?(B|K|M|G|T|P)?$/i;

      // Timetable format is complex, allow it if it contains time markers or scheduling
      const hasTimetable = value.includes(',') || value.includes('-') || value.includes(':');

      if (!simpleBandwidth.test(value) && !hasTimetable && value.length > 0) {
        return {
          bwTimetable: {
            value,
            message: 'Invalid bandwidth format. Use: 100K, 16M, 1G, "off", or full timetable',
          },
        };
      }

      return null;
    };
  } /**
   * Validator for FileMode (octal permissions like 755, 644)
   */
  private fileModeValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow common RClone defaults
      if (['off', 'none', 'default'].includes(value.toLowerCase())) {
        return null;
      }

      // Octal format: 3 or 4 digits, each 0-7
      if (!/^[0-7]{3,4}$/.test(value)) {
        return {
          fileMode: {
            value,
            message:
              'Must be octal format (3-4 digits, each 0-7). Example: 755, 644, 0644, or "off"',
          },
        };
      }

      return null;
    };
  } /**
   * Validator for Time (ISO 8601 format)
   */
  private timeValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow common RClone defaults
      if (['off', 'none', 'now'].includes(value.toLowerCase())) {
        return null;
      }

      // ISO 8601 datetime format check
      const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)?$/;

      if (!isoPattern.test(value)) {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return {
            time: {
              value,
              message: 'Invalid datetime format. Use ISO 8601: YYYY-MM-DDTHH:mm:ssZ or "off"',
            },
          };
        }
      }

      return null;
    };
  } /**
   * Validator for SpaceSepList (space-separated list)
   */
  private spaceSepListValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      // Empty values and common defaults are valid
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow common RClone defaults
      if (['off', 'none'].includes(value.toLowerCase())) {
        return null;
      }

      // Check for valid space-separated values (no special validation needed)
      // Just ensure it's not all whitespace if it has content
      if (value.length > 0 && !/\S/.test(value)) {
        return {
          spaceSepList: {
            value,
            message: 'List cannot contain only whitespace',
          },
        };
      }

      return null;
    };
  } /**
   * Validator for Bits (comma-separated flags)
   */
  private bitsValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow common RClone defaults
      if (['off', 'none', '0'].includes(value.toLowerCase())) {
        return null;
      }

      // Check for valid comma-separated values - allow spaces after commas and hyphens
      if (value.length > 0 && !/^[a-zA-Z0-9_-]+(,\s*[a-zA-Z0-9_-]+)*$/.test(value)) {
        return {
          bits: {
            value,
            message:
              'Must be comma-separated flags (alphanumeric, underscore, and hyphen) or "off"',
          },
        };
      }

      return null;
    };
  } /**
   * Validator for enum types (validates against allowed values)
   */
  private enumValidator(allowedValues: string[]): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Case-insensitive comparison for enum values
      const valueLower = value.toLowerCase();
      const allowedLower = allowedValues.map(v => v.toLowerCase());

      if (!allowedLower.includes(valueLower)) {
        return {
          enum: {
            value,
            allowedValues,
            message: `Must be one of: ${allowedValues.join(', ')}`,
          },
        };
      }

      return null;
    };
  } /**
   * Get error message for a specific RClone option control
   */
  getRCloneOptionError(control: AbstractControl | null): string | null {
    if (!control || !control.errors) return null;

    const errors = control.errors;

    if (errors['required']) return 'This field is required';
    if (errors['integer']) return errors['integer'].message;
    if (errors['float']) return errors['float'].message;
    if (errors['duration']) return errors['duration'].message;
    if (errors['sizeSuffix']) return errors['sizeSuffix'].message;
    if (errors['bwTimetable']) return errors['bwTimetable'].message;
    if (errors['fileMode']) return errors['fileMode'].message;
    if (errors['time']) return errors['time'].message;
    if (errors['spaceSepList']) return errors['spaceSepList'].message;
    if (errors['bits']) return errors['bits'].message;
    if (errors['enum']) return errors['enum'].message;

    return 'Invalid value';
  }

  // ============================================================================
  // End RClone Option Validators
  // ============================================================================

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close();
  }

  // Check if a setting should be visible based on dependencies
  isSettingVisible(key: string): boolean {
    const meta = this.getMetadata('core', key);

    // If no dependency, always visible
    if (!meta.depends_on) {
      return true;
    }

    // Check if parent setting has the required value
    const parentControl = this.getFormControl(meta.depends_on);
    if (!parentControl) {
      return true; // If parent doesn't exist, show by default
    }

    return parentControl.value === meta.depends_value;
  }

  // Update visibility map for all settings
  private updateVisibilityMap(): void {
    const group = this.settingGroups.find(g => g.key === this.currentPage);
    if (!group || !group.settings) return;

    for (const setting of group.settings) {
      const key = `${setting.category}.${setting.key}`;
      this.visibilityMap.set(key, this.isSettingVisible(setting.key));
    }
  }

  // Get page title based on current page
  getPageTitle(): string {
    if (this.currentPage === 'main') {
      return 'RClone Configuration';
    }
    const group = this.settingGroups.find(g => g.key === this.currentPage);
    return group?.label || 'Settings';
  }

  // Add array item for array-type settings
  addArrayItem(key: string): void {
    const control = this.getFormControl(key);
    const currentValue = control.value || [];
    const newArray = [...currentValue, ''];
    control.setValue(newArray);
  }

  // Remove array item
  removeArrayItem(key: string, index: number): void {
    const control = this.getFormControl(key);
    const currentValue = control.value || [];
    const newArray = currentValue.filter((_: string, i: number) => i !== index);
    control.setValue(newArray);
  }

  // Track array items
  trackByIndex(index: number): number {
    return index;
  }
}
