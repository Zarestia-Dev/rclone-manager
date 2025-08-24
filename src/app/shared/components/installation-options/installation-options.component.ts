import { Component, Input, Output, EventEmitter, inject, OnInit } from '@angular/core';

import { FormControl, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { MatRadioModule } from '@angular/material/radio';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

// Services
import { FileSystemService } from '@app/services';
import { SystemInfoService } from '@app/services';
import { AnimationsService } from '../../services/animations.service';
import { ValidatorRegistryService } from '../../services/validator-registry.service';
import { InstallationOptionsData, InstallationTabOption } from '../../types';

@Component({
  selector: 'app-installation-options',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    FormsModule,
    MatRadioModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
  ],
  animations: [AnimationsService.slideInOut()],

  templateUrl: './installation-options.component.html',
  styleUrl: './installation-options.component.scss',
})
export class InstallationOptionsComponent implements OnInit {
  @Input() disabled = false;
  @Input() showExistingOption = true;
  @Input() customPathLabel = 'Custom Installation Path';
  @Input() existingBinaryLabel = 'Existing Binary Path';

  @Output() dataChange = new EventEmitter<InstallationOptionsData>();
  @Output() validChange = new EventEmitter<boolean>();

  installLocation: 'default' | 'custom' | 'existing' = 'default';
  customPath = '';
  existingBinaryPath = '';
  binaryTestResult: 'untested' | 'testing' | 'valid' | 'invalid' = 'untested';

  customPathControl = new FormControl('');
  existingBinaryControl = new FormControl('');

  private fileSystemService = inject(FileSystemService);
  private systemInfoService = inject(SystemInfoService);
  private validatorRegistry = inject(ValidatorRegistryService);

  @Input() tabOptions: InstallationTabOption[] = [
    { key: 'default', label: 'Quick Fix', icon: 'bolt' },
    { key: 'custom', label: 'Custom', icon: 'folder' },
    { key: 'existing', label: 'Existing', icon: 'file' },
  ];

  ngOnInit(): void {
    this.setupValidation();
    this.emitData();
  }

  private setupValidation(): void {
    const pathValidator = this.validatorRegistry.getValidator('crossPlatformPath');

    if (pathValidator) {
      this.customPathControl.setValidators([pathValidator]);
      this.existingBinaryControl.setValidators([pathValidator]);
    }

    // Subscribe to form control changes
    this.customPathControl.valueChanges.subscribe(value => {
      this.customPath = value || '';
      this.emitData();
      this.checkValidity();
    });

    this.existingBinaryControl.valueChanges.subscribe(value => {
      this.existingBinaryPath = value || '';
      if (this.installLocation === 'existing') {
        this.binaryTestResult = 'untested';
      }
      this.emitData();
      this.checkValidity();
    });

    this.customPathControl.updateValueAndValidity();
    this.existingBinaryControl.updateValueAndValidity();
  }

  setInstallLocation(location: 'default' | 'custom' | 'existing'): void {
    this.installLocation = location;

    // Reset form values when switching options
    if (location !== 'custom') {
      this.customPath = '';
      this.customPathControl.setValue('');
    }
    if (location !== 'existing') {
      this.existingBinaryPath = '';
      this.existingBinaryControl.setValue('');
      this.binaryTestResult = 'untested';
    }

    // Auto-test existing binary if it's already set
    if (location === 'existing' && this.existingBinaryPath.trim()) {
      this.testSelectedBinary();
    } else if (location !== 'existing') {
      this.binaryTestResult = 'untested';
    }

    this.emitData();
    this.checkValidity();
  }

  async selectCustomFolder(): Promise<void> {
    try {
      const selectedPath = await this.fileSystemService.selectFolder();
      if (selectedPath) {
        this.customPath = selectedPath;
        this.customPathControl.setValue(selectedPath);
        this.customPathControl.updateValueAndValidity();
      }
    } catch (error) {
      console.error('Failed to select folder:', error);
    }
  }

  async selectExistingBinary(): Promise<void> {
    try {
      // const selectedPath = await this.fileSystemService.selectFile();
      const selectedPath = await this.fileSystemService.selectFolder();
      if (selectedPath) {
        this.existingBinaryPath = selectedPath;
        this.existingBinaryControl.setValue(selectedPath);
        this.existingBinaryControl.updateValueAndValidity();
        this.binaryTestResult = 'untested';
        await this.testSelectedBinary();
      }
    } catch (error) {
      console.error('Failed to select binary:', error);
    }
  }

  async testSelectedBinary(): Promise<void> {
    if (!this.existingBinaryPath.trim()) {
      this.binaryTestResult = 'untested';
      this.emitData();
      this.checkValidity();
      return;
    }

    this.binaryTestResult = 'testing';
    this.emitData();
    this.checkValidity();

    try {
      const isValid = await this.systemInfoService.isRcloneAvailable(this.existingBinaryPath);
      this.binaryTestResult = isValid ? 'valid' : 'invalid';
    } catch (error) {
      console.error('Error testing binary:', error);
      this.binaryTestResult = 'invalid';
    }

    this.emitData();
    this.checkValidity();
  }

  getBinaryTestStatusText(): string {
    switch (this.binaryTestResult) {
      case 'untested':
        return 'Not tested';
      case 'testing':
        return 'Testing...';
      case 'valid':
        return 'Valid rclone binary';
      case 'invalid':
        return 'Invalid or not rclone';
      default:
        return 'Unknown';
    }
  }

  getBinaryTestStatusIcon(): string {
    switch (this.binaryTestResult) {
      case 'untested':
        return 'help';
      case 'testing':
        return 'refresh';
      case 'valid':
        return 'circle-check';
      case 'invalid':
        return 'circle-xmark';
      default:
        return 'help';
    }
  }

  getValidationMessage(control: FormControl): string {
    if (control.hasError('invalidPath')) {
      return 'Please enter a valid absolute file path';
    }
    if (control.hasError('required')) {
      return 'This field is required';
    }
    return '';
  }

  isValid(): boolean {
    if (this.installLocation === 'default') {
      return true;
    }

    if (this.installLocation === 'custom') {
      return this.customPath.trim().length > 0 && this.customPathControl.valid;
    }

    if (this.installLocation === 'existing') {
      return (
        this.existingBinaryPath.trim().length > 0 &&
        this.existingBinaryControl.valid &&
        this.binaryTestResult === 'valid'
      );
    }

    return false;
  }

  private emitData(): void {
    const data: InstallationOptionsData = {
      installLocation: this.installLocation,
      customPath: this.customPath,
      existingBinaryPath: this.existingBinaryPath,
      binaryTestResult: this.binaryTestResult,
    };
    this.dataChange.emit(data);
  }

  private checkValidity(): void {
    this.validChange.emit(this.isValid());
  }
}
