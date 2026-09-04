import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { ExportModalComponent } from './export-modal.component';
import { BackupRestoreService } from 'src/app/services/settings/backup-restore.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { ExportType } from '@app/types';

describe('ExportModalComponent', () => {
  let fixture: ComponentFixture<ExportModalComponent>;
  let component: ExportModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let backupRestoreSpy: {
    getExportCategories: ReturnType<typeof vi.fn>;
    getBackendProfiles: ReturnType<typeof vi.fn>;
    backupSettings: ReturnType<typeof vi.fn>;
  };
  let remoteManagementSpy: {
    getRemotes: ReturnType<typeof vi.fn>;
  };
  let fileSystemSpy: {
    selectFolder: ReturnType<typeof vi.fn>;
  };

  const mockCategories = [
    { id: 'settings', name: 'settings', categoryType: 'settings', optional: false },
    { id: 'backend', name: 'backend', categoryType: 'subsettings', optional: false },
    { id: 'connections', name: 'connections', categoryType: 'subsettings', optional: false },
    { id: 'remotes', name: 'remotes', categoryType: 'subsettings', optional: false },
    { id: 'alerts/rules', name: 'rules', categoryType: 'subsettings', optional: false },
    { id: 'alerts/actions', name: 'actions', categoryType: 'subsettings', optional: false },
    { id: 'quick_runs', name: 'quick_runs', categoryType: 'subsettings', optional: false },
    { id: 'workflows', name: 'workflows', categoryType: 'subsettings', optional: false },
    { id: 'templates', name: 'templates', categoryType: 'subsettings', optional: false },
  ];

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };
    backupRestoreSpy = {
      getExportCategories: vi.fn().mockResolvedValue(mockCategories),
      getBackendProfiles: vi.fn().mockResolvedValue(['default', 'test']),
      backupSettings: vi.fn().mockResolvedValue('Backup created'),
    };
    remoteManagementSpy = {
      getRemotes: vi.fn().mockResolvedValue(['remote1', 'remote2']),
    };
    fileSystemSpy = {
      selectFolder: vi.fn().mockResolvedValue('/tmp/backup'),
    };

    await TestBed.configureTestingModule({
      imports: [ExportModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: {} },
        { provide: BackupRestoreService, useValue: backupRestoreSpy },
        { provide: RemoteManagementService, useValue: remoteManagementSpy },
        { provide: FileSystemService, useValue: fileSystemSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ExportModalComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    fixture.detectChanges();
  });

  it('builds and maps export options with full backup first', () => {
    const options = component.exportOptions();
    expect(options.length).toBe(10);

    const workflowOption = options.find(o => o.id === 'workflows');
    expect(workflowOption).toBeDefined();
    expect(workflowOption?.icon).toBe('workflow');
    expect(workflowOption?.label).toBe('modals.export.categories.workflows.label');
    expect(workflowOption?.description).toBe('modals.export.categories.workflows.description');

    const quickRunOption = options.find(o => o.id === 'quick_runs');
    expect(quickRunOption).toBeDefined();
    expect(quickRunOption?.icon).toBe('quick-run');
    expect(quickRunOption?.label).toBe('modals.export.categories.quickRuns.label');
    expect(quickRunOption?.description).toBe('modals.export.categories.quickRuns.description');

    const templateOption = options.find(o => o.id === 'templates');
    expect(templateOption).toBeDefined();
    expect(templateOption?.icon).toBe('bookmark');
    expect(templateOption?.label).toBe('modals.export.categories.templates.label');
    expect(templateOption?.description).toBe('modals.export.categories.templates.description');
  });

  it('pre-selects all available profiles by default', () => {
    expect(component.availableProfiles()).toEqual(['default', 'test']);
    expect(component.selectedProfiles()).toEqual(['default', 'test']);
  });

  it('toggles profile selection correctly', () => {
    component.toggleProfile('test', false);
    expect(component.selectedProfiles()).toEqual(['default']);

    component.toggleProfile('test', true);
    expect(component.selectedProfiles()).toEqual(['default', 'test']);
  });

  it('correctly evaluates canExport validation', () => {
    expect(component.canExport()).toBe(false); // No path set yet

    component.exportPath.set('/export/path');
    expect(component.canExport()).toBe(true);

    // Profile requirement when profiles shown
    component.selectedProfiles.set([]);
    expect(component.canExport()).toBe(false);
    component.selectedProfiles.set(['default']);
    expect(component.canExport()).toBe(true);

    // Specific remote requires remote name
    component.onExportOptionChange('specific_remote');
    expect(component.canExport()).toBe(false);
    component.onRemoteSelectionChange('remote1');
    expect(component.canExport()).toBe(true);

    // Password validation when secrets included
    component.onPasswordProtectionChange(true);
    component.password.set(''); // Empty password
    expect(component.canExport()).toBe(false);
    component.password.set('1234'); // Valid password
    expect(component.canExport()).toBe(true);
  });

  it('calls backupSettings with correct exportType on export', async () => {
    component.exportPath.set('/tmp/backup');
    component.onExportOptionChange('workflows');
    await component.onExport();

    expect(backupRestoreSpy.backupSettings).toHaveBeenCalledWith(
      '/tmp/backup',
      ExportType.Category('workflows'),
      null,
      '',
      null,
      ['default', 'test'],
      false
    );
  });

  it('closes dialog when cancel is triggered', () => {
    component.close();
    expect(dialogRefSpy.close).toHaveBeenCalledWith(false);
  });
});
