import { TestBed, ComponentFixture } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { SettingControlComponent } from './setting-control.component';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RcConfigOption } from '@app/types';

describe('SettingControlComponent', () => {
  let fixture: ComponentFixture<SettingControlComponent>;
  let component: SettingControlComponent;
  let componentRef: ComponentRef<SettingControlComponent>;
  let appSettingsServiceMock: {
    selectSetting: ReturnType<typeof vi.fn>;
  };
  let remoteServiceMock: {
    obscureValue: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    appSettingsServiceMock = {
      selectSetting: vi.fn().mockReturnValue(of({ value: false })),
    };
    remoteServiceMock = {
      obscureValue: vi.fn().mockResolvedValue('obscured_pass'),
    };

    TestBed.configureTestingModule({
      imports: [SettingControlComponent],
      providers: [
        provideTranslateService(),
        { provide: AppSettingsService, useValue: appSettingsServiceMock },
        { provide: RemoteManagementService, useValue: remoteServiceMock },
      ],
    });

    fixture = TestBed.createComponent(SettingControlComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should return select for exclusive options with Examples', () => {
    const opt: RcConfigOption = {
      Name: 'vfs_cache_mode',
      FieldName: 'VfsCacheMode',
      Help: 'Cache mode',
      Type: 'string',
      DefaultStr: 'off',
      Examples: [
        { Value: 'off', Help: 'Disable cache' },
        { Value: 'minimal', Help: 'Minimal cache' },
        { Value: 'writes', Help: 'Cache writes' },
        { Value: 'full', Help: 'Full cache' },
      ],
    };

    componentRef.setInput('option', opt);
    fixture.detectChanges();
    expect(component.controlType()).toBe('select');
  });

  it('should return autocomplete for options with Exclusive: false to allow custom input', () => {
    const opt: RcConfigOption = {
      Name: 'custom_header',
      FieldName: 'CustomHeader',
      Help: 'Custom header value',
      Type: 'string',
      DefaultStr: '',
      Exclusive: false,
      Examples: [
        { Value: 'Header-1', Help: 'First Header' },
        { Value: 'Header-2', Help: 'Second Header' },
      ],
    };

    componentRef.setInput('option', opt);
    fixture.detectChanges();
    expect(component.controlType()).toBe('autocomplete');
  });

  it('should validate format for typed values on convertible types like Duration', () => {
    const opt: RcConfigOption = {
      Name: 'min_age',
      FieldName: 'MinAge',
      Help: 'Minimum age of files',
      Type: 'Duration',
      DefaultStr: '0s',
    };

    componentRef.setInput('option', opt);
    fixture.detectChanges();
    const ctrl = component.control();
    expect(ctrl).toBeTruthy();

    // Valid duration formats
    ctrl?.setValue('10m');
    expect(ctrl?.valid).toBe(true);

    ctrl?.setValue('1h30m');
    expect(ctrl?.valid).toBe(true);

    // Invalid duration format
    ctrl?.setValue('not-a-duration');
    expect(ctrl?.valid).toBe(false);
    expect(ctrl?.hasError('duration')).toBe(true);
  });

  it('should enforce required validator only when option.Required is true', () => {
    const opt: RcConfigOption = {
      Name: 'bucket',
      FieldName: 'Bucket',
      Help: 'Target bucket',
      Type: 'string',
      DefaultStr: '',
      Required: true,
    };

    componentRef.setInput('option', opt);
    fixture.detectChanges();
    const ctrl = component.control();
    expect(ctrl).toBeTruthy();

    ctrl?.setValue('');
    expect(ctrl?.valid).toBe(false);
    expect(ctrl?.hasError('required')).toBe(true);

    ctrl?.setValue('my-bucket');
    expect(ctrl?.valid).toBe(true);
  });

  it('should automatically provide autocomplete options for Duration and SizeSuffix types even without explicit Examples', () => {
    const durationOpt: RcConfigOption = {
      Name: 'timeout',
      FieldName: 'Timeout',
      Help: 'Connect timeout',
      Type: 'Duration',
      DefaultStr: '1m',
    };

    componentRef.setInput('option', durationOpt);
    fixture.detectChanges();
    expect(component.controlType()).toBe('autocomplete');
    expect(component.controlOptionsList().length).toBeGreaterThan(0);

    const sizeOpt: RcConfigOption = {
      Name: 'buffer_size',
      FieldName: 'BufferSize',
      Help: 'Buffer size',
      Type: 'SizeSuffix',
      DefaultStr: '16M',
    };

    componentRef.setInput('option', sizeOpt);
    fixture.detectChanges();
    expect(component.controlType()).toBe('autocomplete');
    expect(component.controlOptionsList().length).toBeGreaterThan(0);
  });
});
