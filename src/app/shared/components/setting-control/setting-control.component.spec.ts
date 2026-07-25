import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { SettingControlComponent } from './setting-control.component';
import { RcConfigOption } from '@app/types';
import { TranslateModule } from '@ngx-translate/core';
import { By } from '@angular/platform-browser';
import { MatSelect } from '@angular/material/select';

@Component({
  imports: [SettingControlComponent, ReactiveFormsModule],
  template: `
    <app-setting-control [option]="option()" [formControl]="control"></app-setting-control>
  `,
})
class TestHostComponent {
  readonly option = signal<RcConfigOption | null>(null);
  readonly control = new FormControl<unknown>(null);
}

describe('SettingControlComponent', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let host: TestHostComponent;

  const mockScopeOption: RcConfigOption = {
    Name: 'scope',
    FieldName: '',
    Help: 'Comma separated list of scopes that rclone should use when requesting access from drive.',
    Type: 'CommaSepList',
    Exclusive: false,
    DefaultStr: '',
    Examples: [
      { Value: 'drive', Help: 'Full access all files' },
      { Value: 'drive.readonly', Help: 'Read-only access' },
      { Value: 'drive.file', Help: 'Access to files created by rclone only' },
      { Value: 'drive.appfolder', Help: 'Allows read and write access to App folder' },
    ],
  };

  const mockExclusiveOption: RcConfigOption = {
    Name: 'type',
    FieldName: '',
    Help: 'Type of storage',
    Type: 'string',
    Exclusive: true,
    DefaultStr: 'drive',
    Examples: [
      { Value: 'drive', Help: 'Google Drive' },
      { Value: 's3', Help: 'Amazon S3' },
    ],
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent, TranslateModule.forRoot()],
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    host = fixture.componentInstance;
  });

  it('should render a multi-select dropdown when option is a multiselect type (CommaSepList)', () => {
    host.option.set(mockScopeOption);
    fixture.detectChanges();

    const selectDebugEl = fixture.debugElement.query(By.directive(MatSelect));
    expect(selectDebugEl).toBeTruthy();
    const matSelect = selectDebugEl.componentInstance as MatSelect;
    expect(matSelect.multiple).toBeTrue();
  });

  it('should render a single-select dropdown when option is exclusive (Exclusive: true) with Examples', () => {
    host.option.set(mockExclusiveOption);
    fixture.detectChanges();

    const selectDebugEl = fixture.debugElement.query(By.directive(MatSelect));
    expect(selectDebugEl).toBeTruthy();
    const matSelect = selectDebugEl.componentInstance as MatSelect;
    expect(matSelect.multiple).toBeFalse();
  });

  it('should parse comma-separated string initial value into an array for multi-select control', () => {
    host.option.set(mockScopeOption);
    host.control.setValue('drive.file,drive.appfolder');
    fixture.detectChanges();

    const settingControlEl = fixture.debugElement.query(By.directive(SettingControlComponent));
    const settingControlComp = settingControlEl.componentInstance as SettingControlComponent;
    const internalValue = settingControlComp.control()?.value;

    expect(internalValue).toEqual(['drive.file', 'drive.appfolder']);
  });

  it('should emit comma-separated string when multi-select value changes', () => {
    host.option.set(mockScopeOption);
    fixture.detectChanges();

    const settingControlEl = fixture.debugElement.query(By.directive(SettingControlComponent));
    const settingControlComp = settingControlEl.componentInstance as SettingControlComponent;

    settingControlComp.control()?.setValue(['drive.readonly', 'drive.file']);
    fixture.detectChanges();

    expect(host.control.value).toBe('drive.readonly,drive.file');
  });

  it('should correctly determine isMultiselectOption for non-exclusive string options', () => {
    host.option.set(mockScopeOption);
    fixture.detectChanges();

    const settingControlEl = fixture.debugElement.query(By.directive(SettingControlComponent));
    const settingControlComp = settingControlEl.componentInstance as SettingControlComponent;

    expect(settingControlComp.isMultiselectOption()).toBeTrue();
  });

  it('should NOT treat boolean options with Exclusive: false as multiselect and should reset to default boolean value', () => {
    const mockBoolOption: RcConfigOption = {
      Name: 'shared_files',
      FieldName: '',
      Help: 'Instructs rclone to work on individual shared files.',
      Type: 'bool',
      Exclusive: false,
      Default: false,
      DefaultStr: 'false',
    };

    host.option.set(mockBoolOption);
    fixture.detectChanges();

    const settingControlEl = fixture.debugElement.query(By.directive(SettingControlComponent));
    const settingControlComp = settingControlEl.componentInstance as SettingControlComponent;

    expect(settingControlComp.isMultiselectOption()).toBeFalse();
    expect(settingControlComp.control()?.value).toBeFalse();

    settingControlComp.control()?.setValue(true);
    fixture.detectChanges();
    expect(settingControlComp.isValueChanged()).toBeTrue();

    settingControlComp.resetToDefault();
    fixture.detectChanges();
    expect(settingControlComp.control()?.value).toBeFalse();
    expect(settingControlComp.isValueChanged()).toBeFalse();
  });
});
