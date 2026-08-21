import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CliImportComponent } from './cli-import.component';
import {
  CliFlagMapperService,
  ImportResult,
} from 'src/app/services/remote/cli-flag-mapper.service';

describe('CliImportComponent', () => {
  let component: CliImportComponent;
  let fixture: ComponentFixture<CliImportComponent>;
  let mapperService: CliFlagMapperService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CliImportComponent],
      providers: [
        CliFlagMapperService,
        provideTranslateService(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CliImportComponent);
    component = fixture.componentInstance;
    mapperService = TestBed.inject(CliFlagMapperService);
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should parse valid CLI command and populate mapped flags', async () => {
    const mockResult: ImportResult = {
      verb: 'sync',
      sourcePath: 'source:path',
      destPath: 'dest:path',
      classified: [
        {
          flag: { raw: '--max-delete 50', key: 'max-delete', value: '50', hasMacro: false },
          status: 'mapped',
          flagType: 'sync',
          fieldName: 'max_delete',
          coercedValue: 50,
        },
      ],
    };

    vi.spyOn(mapperService, 'importCliCommand').mockResolvedValue(mockResult);

    component.cliInput.set('rclone sync source:path dest:path --max-delete 50');
    await component.previewImport();

    expect(component.importResult()).toEqual(mockResult);
    expect(component.mappedFlags().length).toBe(1);
    expect(component.selectedFlags().has('max-delete')).toBe(true);
    expect(component.validationError()).toBeNull();
  });

  it('should show error message when command is invalid', async () => {
    vi.spyOn(mapperService, 'importCliCommand').mockResolvedValue({
      classified: [],
    });

    component.cliInput.set('invalid command');
    await component.previewImport();

    expect(component.validationError()).toBe('wizards.cliImport.invalidCommand');
    expect(component.importResult()).toBeNull();
  });

  it('should toggle flag selection correctly', async () => {
    const mockResult: ImportResult = {
      verb: 'sync',
      classified: [
        {
          flag: { raw: '--max-delete 50', key: 'max-delete', value: '50', hasMacro: false },
          status: 'mapped',
          flagType: 'sync',
          fieldName: 'max_delete',
          coercedValue: 50,
        },
        {
          flag: { raw: '--track-renames', key: 'track-renames', value: true, hasMacro: false },
          status: 'mapped',
          flagType: 'sync',
          fieldName: 'track_renames',
          coercedValue: true,
        },
      ],
    };

    vi.spyOn(mapperService, 'importCliCommand').mockResolvedValue(mockResult);
    component.cliInput.set('rclone sync src: dst: --max-delete 50 --track-renames');
    await component.previewImport();

    expect(component.isFlagSelected('max-delete')).toBe(true);
    component.toggleFlag('max-delete');
    expect(component.isFlagSelected('max-delete')).toBe(false);

    component.selectAllFlags();
    expect(component.selectedFlags().size).toBe(2);

    component.deselectAllFlags();
    expect(component.selectedFlags().size).toBe(0);
  });

  it('should support Quick Run mode (isQuickRun: true) without requiring profile names', async () => {
    fixture.componentRef.setInput('isQuickRun', true);
    fixture.detectChanges();

    const mockResult: ImportResult = {
      verb: 'mount',
      sourcePath: 'remote:path',
      destPath: '/mnt/point',
      classified: [
        {
          flag: {
            raw: '--vfs-cache-mode full',
            key: 'vfs-cache-mode',
            value: 'full',
            hasMacro: false,
          },
          status: 'mapped',
          flagType: 'vfs',
          fieldName: 'vfs_cache_mode',
          coercedValue: 'full',
        },
      ],
    };

    vi.spyOn(mapperService, 'importCliCommand').mockResolvedValue(mockResult);
    component.cliInput.set('rclone mount remote:path /mnt/point --vfs-cache-mode full');
    await component.previewImport();

    expect(component.canPatch()).toBe(true);
    expect(component.canCreateNew()).toBe(false);
    expect(component.isApplyDisabled()).toBe(false);

    let emittedEvent: unknown = null;
    component.apply.subscribe(e => (emittedEvent = e));

    component.onApply();

    expect(emittedEvent).toEqual({
      result: mockResult,
      profileName: '',
      mode: 'patch',
      importSourcePath: true,
      importDestPath: true,
    });
  });

  it('should clear all inputs when clearInput is called', () => {
    component.cliInput.set('some command');
    component.clearInput();

    expect(component.cliInput()).toBe('');
    expect(component.importResult()).toBeNull();
    expect(component.selectedFlags().size).toBe(0);
  });
});
