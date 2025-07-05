import { Component, HostListener, OnInit, ViewChild } from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
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
import { AnimationsService } from '../../../../services/core/animations.service';
import { AppSettingsService } from '../../../../services/settings/app-settings.service';

@Component({
  selector: 'app-preferences-modal',
  standalone: true,
  imports: [
    MatSlideToggleModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    ReactiveFormsModule,
    MatSelectModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    SearchContainerComponent,
  ],
  templateUrl: './preferences-modal.component.html',
  styleUrls: ['./preferences-modal.component.scss'],
  animations: [AnimationsService.slideToggle()],
})
export class PreferencesModalComponent implements OnInit {
  selectedTabIndex = 0;
  settingsForm: FormGroup;
  metadata: any = {};
  bottomTabs = false;
  isLoading = true;
  searchQuery = '';
  searchVisible = false; // Controls the visibility of search field
  filteredTabs: any[] = [];

  @ViewChild(SearchContainerComponent) searchContainer!: SearchContainerComponent;

  searchResults: { category: string; key: string }[] = [];

  tabs = [
    { label: 'General', icon: 'wrench', key: 'general' },
    { label: 'Core', icon: 'puzzle-piece', key: 'core' },
    { label: 'Experimental', icon: 'flask', key: 'experimental' },
  ];

  constructor(
    private dialogRef: MatDialogRef<PreferencesModalComponent>,
    private fb: FormBuilder,
    private appSettingsService: AppSettingsService
  ) {
    this.settingsForm = this.fb.group({});
    this.filteredTabs = [...this.tabs];
  }

  ngOnInit() {
    this.onResize();
    this.loadSettings();
  }

  @HostListener('window:resize')
  onResize() {
    this.bottomTabs = window.innerWidth < 540;
  }

  async loadSettings() {
    try {
      this.isLoading = true;
      const response = await this.appSettingsService.loadSettings();
      this.metadata = response.metadata;

      // Initialize form groups for each category
      const formGroups: any = {};
      for (const category of Object.keys(response.settings)) {
        formGroups[category] = this.fb.group({});

        for (const [key, value] of Object.entries(response.settings[category])) {
          const meta = this.getMetadata(category, key);
          const validators = this.getValidators(meta);

          formGroups[category].addControl(key, this.fb.control(value, validators));
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
    if (ctrl.hasError('pattern')) {
      return meta.validation_message || 'Invalid format';
    }
    if (ctrl.hasError('min')) {
      return `Minimum value is ${meta.min_value}`;
    }
    if (ctrl.hasError('max')) {
      return `Maximum value is ${meta.max_value}`;
    }

    return 'Invalid value';
  }

  getValidators(meta: any) {
    const validators = [];

    if (meta.required ?? true) {
      validators.push(Validators.required);
    }

    if (meta.validation_pattern) {
      validators.push(Validators.pattern(meta.validation_pattern));
    }

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

  async updateSetting(category: string, key: string, value: any): Promise<void> {
    if (!this.settingsForm.get(category)?.get(key)?.valid) {
      return;
    }

    try {
      console.log('Saving setting:', category, key, value);

      // Convert number strings to actual numbers
      const meta = this.getMetadata(category, key);
      if (meta.value_type === 'number') {
        value = Number(value);

        if (value == 0) return;
      }

      await this.appSettingsService.saveSetting(category, key, value);
    } catch (error) {
      console.error('Error saving setting:', error);

      // // Revert to previous value
      const currentValue = this.appSettingsService.loadSettingValue(category, key);
      this.settingsForm.get(category)?.get(key)?.setValue(currentValue, { emitEvent: false });
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  close() {
    this.dialogRef.close();
  }

  selectedTab: string = this.tabs[0].key;

  allowOnlyNumbers(event: KeyboardEvent): void {
    const charCode = event.key ? event.key.charCodeAt(0) : 0;
    if (charCode < 48 || charCode > 57) {
      event.preventDefault();
    }
  }

  selectTab(index: number): void {
    this.selectedTabIndex = index;
    this.selectedTab = this.tabs[index].key;
  }

  filterSettings(searchText: string): void {
    this.searchQuery = searchText.toLowerCase();
    this.searchResults = [];

    if (!this.searchQuery) {
      this.filteredTabs = [...this.tabs];
      return;
    }

    // Build unified search results across all categories
    for (const category of Object.keys(this.settingsForm.controls)) {
      const categoryControl = this.settingsForm.get(category);
      if (!categoryControl) continue;

      for (const key of Object.keys(categoryControl.value || {})) {
        const meta = this.getMetadata(category, key);

        // Check if setting matches search query
        if (
          meta.display_name.toLowerCase().includes(this.searchQuery) ||
          meta.help_text.toLowerCase().includes(this.searchQuery) ||
          key.toLowerCase().includes(this.searchQuery)
        ) {
          this.searchResults.push({ category, key });
        }
      }
    }

    // Filter tabs based on whether they contain matching settings
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

  getMetadata(category: string, key: string): any {
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
      if (this.searchContainer) {
        this.searchContainer.clear();
      }
    } else if (this.searchContainer) {
      this.searchContainer.focus();
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
}
