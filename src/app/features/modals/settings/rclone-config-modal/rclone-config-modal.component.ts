import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit, inject, ChangeDetectorRef } from '@angular/core';
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
  FormControl,
  ReactiveFormsModule,
  FormsModule,
  ValidatorFn,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';

// Services
import { AnimationsService } from '../../../../shared/services/animations.service';
import { RcloneBackendOptionsService } from '@app/services';
import { NotificationService } from '../../../../shared/services/notification.service';
import { RcConfigOption } from '@app/types';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { SecuritySettingsComponent } from '../security-settings/security-settings.component';

// Type aliases
type PageType = 'home' | 'security' | string;
type RCloneOptionsInfo = Record<string, RcConfigOption[]>;

// Component-specific interfaces
interface SettingGroup {
  key: PageType;
  label: string;
  icon: string;
  description: string;
}

interface SettingCategory {
  name: string;
  icon: string;
  description: string;
  groups: SettingGroup[];
  expanded: boolean;
}

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
    MatExpansionModule,
    SearchContainerComponent,
    SecuritySettingsComponent,
  ],
  templateUrl: './rclone-config-modal.component.html',
  styleUrl: './rclone-config-modal.component.scss',
  animations: [AnimationsService.slideOverlay()],
})
export class RcloneConfigModalComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<RcloneConfigModalComponent>);
  private notificationService = inject(NotificationService);
  private rcloneBackendOptions = inject(RcloneBackendOptionsService);
  private cdRef = inject(ChangeDetectorRef);

  currentPage: PageType = 'home';
  isLoading = true;

  // Setting groups for navigation
  settingGroups: SettingGroup[] = [];

  // Categorized settings for grouped navigation
  settingCategories: SettingCategory[] = [];
  filteredCategories: SettingCategory[] = [];

  // Home page search
  homeSearchQuery = '';

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
    nfs: 'ftp',
    proxy: 'shield-halved',
    restic: 'box-archive',
    s3: 'bucket',
    sftp: 'lock',
    webdav: 'cloud',
  };

  // Description mapping for RClone blocks
  private readonly blockDescriptionMap: Record<string, string> = {
    vfs: 'Virtual File System caching and performance settings (O)',
    mount: 'Mount-specific options and FUSE configuration (O)',
    filter: 'File filtering rules and patterns (O)',
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
  rcloneOptionsByBlock: Record<string, RcConfigOption[]> = {};

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

  // Search visibility toggle
  isSearchVisible = false;

  // Global search results (for home page search)
  globalSearchResults: { block: string; option: RcConfigOption }[] = [];

  // Track if we're currently performing search to prevent loops
  private isPerformingSearch = false;

  // Cache for dynamic FormControls used for array (stringArray) options
  private arrayControlsCache = new Map<string, FormControl[]>();

  async ngOnInit(): Promise<void> {
    // Load RClone blocks and create dynamic pages
    await this.loadRCloneBlocks();

    // Load backend options from store and apply to form controls
    await this.loadBackendOptions();

    // Initialize filtered categories
    this.filteredCategories = this.settingCategories;

    // Force change detection after initialization
    this.cdRef.detectChanges();
  }

  /**
   * Load RClone option blocks and create dynamic pages
   */
  private async loadRCloneBlocks(): Promise<void> {
    try {
      // Get blocks from RClone API
      const blocks = await this.rcloneBackendOptions.getOptionBlocks();

      // Get all options info from RClone API
      this.rcloneOptions = await this.rcloneBackendOptions.getAllOptionsInfo();

      // Organize options by block for easy access
      for (const block of blocks) {
        this.rcloneOptionsByBlock[block] = this.rcloneOptions[block] || [];
      }

      // Build setting groups for navigation
      this.buildSettingGroups();

      console.log('Loaded RClone blocks:', blocks);
      console.log('Loaded RClone options:', this.rcloneOptionsByBlock);

      // Create form controls for all RClone options
      this.createRCloneOptionControls();
    } catch (error) {
      console.error('Error loading RClone blocks:', error);
      this.notificationService.showError('Failed to load RClone configuration blocks');
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
        this.optionToFieldNameMap[option.Name] = option.FieldName || option.Name;

        // Get validators for this option type
        const validators = this.getRCloneOptionValidators(option);

        // Get initial value - convert boolean strings to actual booleans and arrays
        let initialValue: unknown = option.ValueStr || option.DefaultStr;
        if (option.Type === 'bool') {
          initialValue = option.ValueStr === 'true' || option.DefaultStr === 'true';
        } else if (option.Type === 'DumpFlags' && typeof initialValue === 'string') {
          // DumpFlags should be an array for multi-select
          initialValue = initialValue ? initialValue.split(',').map((v: string) => v.trim()) : [];
        } else if (option.Type === 'stringArray') {
          // stringArray stored as comma-separated string in some cases; normalize to array
          if (typeof initialValue === 'string') {
            initialValue = initialValue ? initialValue.split(',').map((v: string) => v.trim()) : [];
          } else if (!Array.isArray(initialValue)) {
            initialValue = [];
          }
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
    console.log('Option to FieldName mapping:', this.optionToFieldNameMap);
  }

  /**
   * Load RClone backend options from store and apply to form controls
   */
  private async loadBackendOptions(): Promise<void> {
    try {
      const storedOptions = await this.rcloneBackendOptions.loadOptions();
      console.log('📦 Loaded backend options from store:', storedOptions);

      // Apply stored values to form controls
      for (const block in storedOptions) {
        const blockOptions = storedOptions[block];

        // Get the options for this block to check types
        const blockRCloneOptions = this.rcloneOptionsByBlock[block] || [];

        for (const optionFieldName in blockOptions) {
          // Find the option by FieldName (PascalCase)
          const optionName = Object.keys(this.optionToFieldNameMap).find(
            key => this.optionToFieldNameMap[key] === optionFieldName
          );

          if (optionName && this.rcloneOptionControls[optionName]) {
            const storedValue = blockOptions[optionFieldName];
            const control = this.rcloneOptionControls[optionName];

            // Get the option metadata from the block to determine type
            const option = blockRCloneOptions.find(opt => opt.FieldName === optionFieldName);
            if (!option) {
              console.warn(`⚠️ Option ${optionFieldName} not found in block ${block}`);
              continue;
            }

            // Apply value based on type
            if (option.Type === 'bool') {
              control.setValue(storedValue === true, { emitEvent: false });
              console.log(
                `✅ Applied boolean value for ${optionName} (${optionFieldName}):`,
                storedValue === true
              );
            } else if (option.Type === 'stringArray') {
              // storedValue may be an array or a comma-separated string
              if (Array.isArray(storedValue)) {
                control.setValue(storedValue, { emitEvent: false });
              } else if (typeof storedValue === 'string') {
                control.setValue(
                  storedValue ? storedValue.split(',').map((v: string) => v.trim()) : [],
                  {
                    emitEvent: false,
                  }
                );
              } else {
                control.setValue([], { emitEvent: false });
              }
              console.log(
                `✅ Applied stringArray value for ${optionName} (${optionFieldName}):`,
                storedValue
              );
            } else if (option.Type === 'DumpFlags' && typeof storedValue === 'string') {
              control.setValue(storedValue ? storedValue.split(',').map(v => v.trim()) : [], {
                emitEvent: false,
              });
              console.log(
                `✅ Applied DumpFlags value for ${optionName} (${optionFieldName}):`,
                storedValue
              );
            } else {
              control.setValue(storedValue, { emitEvent: false });
              console.log(`✅ Applied value for ${optionName} (${optionFieldName}):`, storedValue);
            }
          } else {
            console.warn(`⚠️ Control not found for ${optionFieldName} (optionName: ${optionName})`);
          }
        }
      }
      this.isLoading = false;
    } catch (error) {
      this.isLoading = false;
      console.error('Failed to load backend options:', error);
      // Continue with default values on error
    }
  }

  /**
   * Save RClone option value to API (called on blur/change)
   */
  /**
   * Save RClone option value to API (called on blur/change)
   */
  async saveRCloneOption(optionName: string): Promise<void> {
    const control = this.getRCloneOptionControl(optionName);

    // Only save if the control is dirty (value changed) and valid, and not already saving
    if (control.invalid || this.savingOptions.has(optionName) || control.pristine) {
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

      // Call the backend to save the option with block name and FieldName (PascalCase)
      await this.rcloneBackendOptions.saveOption(blockName, fieldName, valueToSave);
      // Also save to local backend.json file for persistence using the service
      await this.rcloneBackendOptions.saveOption(blockName, fieldName, valueToSave);

      // Mark as pristine after successful save
      control.markAsPristine();

      // Show success notification (using display name)
      this.notificationService.showSuccess(`Saved: ${optionName}`);

      console.log(
        `✅ Saved option ${optionName} (${fieldName}) in block ${blockName}:`,
        valueToSave
      );
      console.log(`💾 Persisted to backend.json`);
    } catch (error) {
      console.error(`Failed to save option ${optionName}:`, error);

      // Show error notification
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.notificationService.showError(`Failed to save ${optionName}: ${errorMessage}`);

      // Revert the control value to the original and mark as pristine
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
        control.markAsPristine();
      }
    } finally {
      this.savingOptions.delete(optionName);
      // Re-enable the control after saving
      control.enable();
    }
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
      http: 'HTTP Settings',
      rc: 'Remote Control Settings',
      dlna: 'DLNA Settings',
      ftp: 'FTP Settings',
      nfs: 'NFS Settings',
      proxy: 'Proxy Settings',
      restic: 'Restic Settings',
      s3: 'S3 Settings',
      sftp: 'SFTP Settings',
      webdav: 'WebDAV Settings',
    };
    return labelMap[block] || `${this.capitalizeFirst(block)} Settings`;
  }

  /**
   * Build setting groups from loaded blocks
   */
  private buildSettingGroups(): void {
    this.settingGroups = Object.keys(this.rcloneOptionsByBlock).map(block => ({
      key: block,
      label: this.getBlockLabel(block),
      icon: this.blockIconMap[block] || 'settings',
      description: this.blockDescriptionMap[block] || `${this.capitalizeFirst(block)} settings`,
    }));

    // Build categorized settings
    this.buildCategorizedSettings();
  }

  /**
   * Build categorized settings structure
   */
  private buildCategorizedSettings(): void {
    // Define category mappings
    const categoryMappings: Record<string, string[]> = {
      general: ['main', 'log', 'proxy', 'rc'],
      filesystem: ['vfs', 'mount', 'filter'],
      network: ['http', 'ftp', 'sftp', 'nfs', 'webdav', 's3', 'restic', 'dlna'],
    };

    // Initialize categories
    this.settingCategories = [
      {
        name: 'General Settings',
        icon: 'gear',
        description: 'Core RClone options and logging',
        groups: [],
        expanded: true,
      },
      {
        name: 'File System & Storage',
        icon: 'folder',
        description: 'Virtual file system, mounting, and filtering options',
        groups: [],
        expanded: false,
      },
      {
        name: 'Network & Servers (Serve Options)',
        icon: 'globe',
        description: 'HTTP, FTP, SFTP, WebDAV, S3, and other network settings',
        groups: [],
        expanded: false,
      },
    ];

    // Assign groups to categories
    this.settingGroups.forEach(group => {
      for (const [categoryKey, blocks] of Object.entries(categoryMappings)) {
        if (blocks.includes(group.key)) {
          const categoryIndex = {
            general: 0,
            filesystem: 1,
            network: 2,
            advanced: 3,
          }[categoryKey];

          if (categoryIndex !== undefined) {
            this.settingCategories[categoryIndex].groups.push(group);
          }
          break;
        }
      }
    });

    // Filter out empty categories
    this.settingCategories = this.settingCategories.filter(cat => cat.groups.length > 0);
    this.filteredCategories = [...this.settingCategories];
  }

  /**
   * Handle home search text change
   */
  onHomeSearchChange(searchText: string): void {
    if (this.isPerformingSearch) return;

    this.isPerformingSearch = true;
    this.homeSearchQuery = searchText;

    if (!this.homeSearchQuery || this.homeSearchQuery.trim() === '') {
      this.globalSearchResults = [];
      this.filteredCategories = [...this.settingCategories];
    } else {
      const query = this.homeSearchQuery.toLowerCase().trim();
      this.performGlobalSearch(query);
      this.updateFilteredCategories();
    }

    this.isPerformingSearch = false;
    this.cdRef.detectChanges();
  }

  /**
   * Update filtered categories based on search results
   */
  private updateFilteredCategories(): void {
    if (this.globalSearchResults.length > 0) {
      const blocksWithMatches = new Set(this.globalSearchResults.map(result => result.block));

      this.filteredCategories = this.settingCategories
        .map(category => ({
          ...category,
          groups: category.groups.filter(group => blocksWithMatches.has(group.key)),
          expanded: true,
        }))
        .filter(category => category.groups.length > 0);
    } else {
      // Fallback: Filter by category/group names and descriptions
      const query = this.homeSearchQuery.toLowerCase().trim();
      this.filteredCategories = this.settingCategories
        .map(category => ({
          ...category,
          groups: category.groups.filter(
            group =>
              group.label.toLowerCase().includes(query) ||
              group.description.toLowerCase().includes(query) ||
              group.key.toLowerCase().includes(query)
          ),
          expanded: true,
        }))
        .filter(category => category.groups.length > 0);
    }
  }

  /**
   * Perform global search across all RClone options
   */
  private performGlobalSearch(query: string): void {
    this.globalSearchResults = [];

    for (const [block, options] of Object.entries(this.rcloneOptionsByBlock)) {
      for (const option of options) {
        if (
          option.Name.toLowerCase().includes(query) ||
          (option.FieldName && option.FieldName.toLowerCase().includes(query)) ||
          option.Help.toLowerCase().includes(query) ||
          block.toLowerCase().includes(query)
        ) {
          this.globalSearchResults.push({ block, option });
        }
      }
    }

    console.log(`Global search for "${query}" found ${this.globalSearchResults.length} results`);
  }

  /**
   * Get filtered categories for template (now uses pre-computed array)
   */
  getFilteredCategories(): SettingCategory[] {
    return this.filteredCategories;
  }

  /**
   * Clear home search
   */
  clearHomeSearch(): void {
    this.homeSearchQuery = '';
    this.globalSearchResults = [];
    this.filteredCategories = [...this.settingCategories];
    this.cdRef.detectChanges();
  }

  /**
   * Check if a block has search matches
   */
  blockHasSearchMatches(blockKey: string): boolean {
    return this.globalSearchResults.some(result => result.block === blockKey);
  }

  /**
   * Get search match count for a block
   */
  getBlockMatchCount(blockKey: string): number {
    return this.globalSearchResults.filter(result => result.block === blockKey).length;
  }

  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  navigateTo(page: PageType): void {
    this.currentPage = page;

    // If navigating from home page with active search, transfer search to detail page
    if (this.homeSearchQuery && page !== 'home' && page !== 'security') {
      // Transfer home search query to detail page search
      this.searchQuery = this.homeSearchQuery;
      this.isSearchVisible = true;
      console.log(`🔍 Transferred search "${this.searchQuery}" to detail page: ${page}`);
    }

    this.cdRef.detectChanges();
  }

  /**
   * Get RClone options for the current page/block
   */
  getRCloneOptionsForCurrentPage(): RcConfigOption[] {
    if (this.currentPage === 'home' || this.currentPage === 'security') {
      return [];
    }
    const options = this.rcloneOptionsByBlock[this.currentPage] || [];
    return this.filterOptionsBySearch(options);
  }

  /**
   * Filter options based on search query
   */
  private filterOptionsBySearch(options: RcConfigOption[]): RcConfigOption[] {
    if (!this.searchQuery || this.searchQuery.trim() === '') {
      return options;
    }

    const query = this.searchQuery.toLowerCase().trim();
    return options.filter(
      option =>
        option.Name.toLowerCase().includes(query) ||
        (option.FieldName && option.FieldName.toLowerCase().includes(query)) ||
        option.Help.toLowerCase().includes(query)
    );
  }

  /**
   * Handle search text changes from the search container
   */
  onSearchTextChange(searchText: string): void {
    this.searchQuery = searchText;
    this.cdRef.detectChanges();
  }

  /**
   * Toggle search bar visibility
   */
  toggleSearchVisibility(): void {
    this.isSearchVisible = !this.isSearchVisible;
    this.cdRef.detectChanges();
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
    if (this.currentPage === 'home' || this.currentPage === 'security') {
      return 0;
    }
    const options = this.rcloneOptionsByBlock[this.currentPage] || [];
    return this.filterOptionsBySearch(options).length;
  }

  /**
   * Get total options count for current page
   */
  get totalOptionsCount(): number {
    if (this.currentPage === 'home' || this.currentPage === 'security') {
      return 0;
    }
    return (this.rcloneOptionsByBlock[this.currentPage] || []).length;
  }

  /**
   * Get a specific RClone option by name from current block
   */
  getRCloneOption(name: string): RcConfigOption | undefined {
    const options = this.getRCloneOptionsForCurrentPage();
    return options.find(opt => opt.Name === name);
  }

  // Check if current page is security
  get isSecurityPage(): boolean {
    return this.currentPage === 'security';
  }

  // ============================================================================
  // RClone Option Validators (keep the existing validator methods)
  // ============================================================================

  /**
   * Get validators for a specific RClone option based on its type and constraints
   */
  getRCloneOptionValidators(option: RcConfigOption): ValidatorFn[] {
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
        validators.push(this.integerValidator(option.DefaultStr));
        break;

      case 'float64':
        validators.push(this.floatValidator(option.DefaultStr));
        break;

      case 'Duration':
        validators.push(this.durationValidator(option.DefaultStr));
        break;

      case 'SizeSuffix':
        validators.push(this.sizeSuffixValidator(option.DefaultStr));
        break;

      case 'BwTimetable':
        validators.push(this.bwTimetableValidator(option.DefaultStr));
        break;

      case 'FileMode':
        validators.push(this.fileModeValidator(option.DefaultStr));
        break;

      case 'Time':
        validators.push(this.timeValidator(option.DefaultStr));
        break;

      case 'SpaceSepList':
        validators.push(this.spaceSepListValidator(option.DefaultStr));
        break;

      case 'stringArray':
        // Arrays are handled differently in the UI
        break;

      case 'DumpFlags':
        // Multi-select handled by mat-select
        break;

      case 'Bits':
        validators.push(this.bitsValidator(option.DefaultStr));
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
  private integerValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }

      if (!/^-?\d+$/.test(value)) {
        return { integer: { value, message: 'Must be a valid integer' } };
      }

      const num = parseInt(value, 10);
      if (isNaN(num)) {
        return { integer: { value, message: 'Must be a valid integer' } };
      }

      return null;
    };
  }

  /**
   * Validator for float64 type
   */
  private floatValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }

      if (!/^-?\d+(\.\d+)?$/.test(value)) {
        return { float: { value, message: 'Must be a valid decimal number' } };
      }

      const num = parseFloat(value);
      if (isNaN(num)) {
        return { float: { value, message: 'Must be a valid decimal number' } };
      }

      return null;
    };
  }

  /**
   * Validator for Duration format (e.g., "1h30m45s", "5m", "1h")
   */
  private durationValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }

      // Duration format: combinations of number + unit (ns, us/µs, ms, s, m, h)
      const durationPattern = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

      if (!durationPattern.test(value)) {
        return {
          duration: {
            value,
            message: 'Invalid duration format. Use: 1h30m45s, 5m, 1h',
          },
        };
      }

      return null;
    };
  }

  /**
   * Validator for SizeSuffix format (e.g., "100Ki", "16Mi", "1Gi")
   */
  private sizeSuffixValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }

      // Size format: number + optional suffix (b, B, k, K, Ki, M, Mi, G, Gi, T, Ti, P, Pi, E, Ei)
      const sizePattern = /^\d+(\.\d+)?(b|B|k|K|Ki|M|Mi|G|Gi|T|Ti|P|Pi|E|Ei)?$/;

      if (!sizePattern.test(value)) {
        return {
          sizeSuffix: {
            value,
            message: 'Invalid size format. Use: 100Ki, 16Mi, 1Gi, 2.5G',
          },
        };
      }

      return null;
    };
  }

  /**
   * Validator for BwTimetable format (bandwidth with optional timetable)
   */
  private bwTimetableValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
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
            message: 'Invalid bandwidth format. Use: 100K, 16M, 1G, or full timetable',
          },
        };
      }

      return null;
    };
  }

  /**
   * Validator for FileMode (octal permissions like 755, 644)
   */
  private fileModeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }

      // Octal format: 3 or 4 digits, each 0-7
      if (!/^[0-7]{3,4}$/.test(value)) {
        return {
          fileMode: {
            value,
            message: 'Must be octal format (3-4 digits, each 0-7). Example: 755, 644, 0644',
          },
        };
      }

      return null;
    };
  }

  /**
   * Validator for Time (ISO 8601 format)
   */
  private timeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
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
              message: 'Invalid datetime format. Use ISO 8601: YYYY-MM-DDTHH:mm:ssZ',
            },
          };
        }
      }

      return null;
    };
  }

  /**
   * Validator for SpaceSepList (space-separated list)
   */
  private spaceSepListValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
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
  }

  /**
   * Validator for Bits (comma-separated flags)
   */
  private bitsValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }

      // Check for valid comma-separated values - allow spaces after commas and hyphens
      if (value.length > 0 && !/^[a-zA-Z0-9_-]+(,\s*[a-zA-Z0-9_-]+)*$/.test(value)) {
        return {
          bits: {
            value,
            message: 'Must be comma-separated flags (alphanumeric, underscore, and hyphen)',
          },
        };
      }

      return null;
    };
  }

  /**
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
  }

  /**
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

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close();
  }

  // Get page title based on current page
  getPageTitle(): string {
    if (this.currentPage === 'main') {
      return 'RClone Configuration';
    }
    const group = this.settingGroups.find(g => g.key === this.currentPage);
    return group?.label || 'Backend Settings';
  }

  // Track array items by index
  trackByIndex(index: number): number {
    return index;
  }

  // --------- Array helpers (for stringArray option type) ----------
  getArrayItemControl(block: string, optionName: string, index: number): FormControl {
    const cacheKey = `${block}.${optionName}`;

    // Initialize cache if missing
    if (!this.arrayControlsCache.has(cacheKey)) {
      this.initializeArrayControls(block, optionName);
    }

    const controls = this.arrayControlsCache.get(cacheKey);
    if (!controls) throw new Error(`Array controls not found for ${cacheKey}`);

    const parentControl = this.getFormControl(optionName);
    const array = Array.isArray(parentControl.value) ? parentControl.value : [];

    while (controls.length <= index) {
      const ctrl = new FormControl(array[controls.length] || '');
      this.setupArrayControlSubscription(ctrl, block, optionName, controls.length);
      controls.push(ctrl);
    }

    return controls[index];
  }

  private initializeArrayControls(block: string, optionName: string): void {
    const cacheKey = `${block}.${optionName}`;
    const parentControl = this.getFormControl(optionName);
    const array = Array.isArray(parentControl.value) ? parentControl.value : [];

    const controls = array.map((value, idx) => {
      const ctrl = new FormControl(value);
      this.setupArrayControlSubscription(ctrl, block, optionName, idx);
      return ctrl;
    });

    this.arrayControlsCache.set(cacheKey, controls);
  }

  private setupArrayControlSubscription(
    control: FormControl,
    block: string,
    optionName: string,
    index: number
  ): void {
    control.valueChanges.subscribe(newValue => {
      const parentControl = this.getFormControl(optionName);
      const currentArray = Array.isArray(parentControl.value) ? parentControl.value : [];
      const newArray = [...currentArray];

      const normalize = (v: unknown): string => (v == null || v === '' ? '' : String(v));
      const curNorm = normalize(currentArray[index]);
      const newNorm = normalize(newValue);

      if (curNorm !== newNorm) {
        newArray[index] = newNorm;
        parentControl.setValue(newArray, { emitEvent: false });
        // Persist change via save flow (use option name to find block)
        this.saveRCloneOption(optionName);
      }
    });
  }

  addArrayItem(block: string, optionName: string): void {
    const parentControl = this.getFormControl(optionName);
    const arr = Array.isArray(parentControl.value) ? parentControl.value : [];
    const newArray = [...arr, ''];
    parentControl.setValue(newArray);

    const cacheKey = `${block}.${optionName}`;
    this.arrayControlsCache.delete(cacheKey);

    // Immediately create control for new last index so UI updates
    this.getArrayItemControl(block, optionName, newArray.length - 1);
    // Save to backend
    this.saveRCloneOption(optionName);
  }

  removeArrayItem(block: string, optionName: string, index: number): void {
    const parentControl = this.getFormControl(optionName);
    const arr = Array.isArray(parentControl.value) ? parentControl.value : [];
    const newArray = arr.filter((_: unknown, i: number) => i !== index);
    parentControl.setValue(newArray);

    const cacheKey = `${block}.${optionName}`;
    this.arrayControlsCache.delete(cacheKey);

    this.saveRCloneOption(optionName);
  }

  // Helper to get a rclone option FormControl by option name
  private getFormControl(optionName: string): FormControl {
    return this.rcloneOptionControls[optionName] || new FormControl('');
  }
}
