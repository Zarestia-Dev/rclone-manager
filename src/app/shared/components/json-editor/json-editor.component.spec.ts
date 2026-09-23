import { TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { JsonEditorComponent } from './json-editor.component';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { RcConfigOption } from '@app/types';

describe('JsonEditorComponent', () => {
  let component: JsonEditorComponent;
  let componentRef: ComponentRef<JsonEditorComponent>;
  let formGroup: FormGroup;
  let appSettingsServiceMock: {
    selectSetting: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    appSettingsServiceMock = {
      selectSetting: vi.fn().mockReturnValue(of({ value: false })),
    };

    TestBed.configureTestingModule({
      imports: [JsonEditorComponent],
      providers: [
        provideTranslateService(),
        { provide: AppSettingsService, useValue: appSettingsServiceMock },
      ],
    });

    formGroup = new FormGroup({
      vfs_cache_mode: new FormControl('full'),
      min_age: new FormControl('10m'),
    });

    const fixture = TestBed.createComponent(JsonEditorComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('formGroup', formGroup);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should correctly build chips for field definitions', () => {
    const fields: RcConfigOption[] = [
      {
        Name: 'vfs_cache_mode',
        FieldName: 'VfsCacheMode',
        Help: 'Cache mode',
        Type: 'string',
        DefaultStr: 'off',
      },
      {
        Name: 'min_age',
        FieldName: 'MinAge',
        Help: 'Minimum age',
        Type: 'Duration',
        DefaultStr: '0s',
      },
    ];

    componentRef.setInput('fieldDefs', fields);
    const chips = component.chips();
    expect(chips.length).toBe(2);
    expect(chips[0].displayKey).toBe('vfs_cache_mode');
    expect(chips[0].isChanged).toBe(true);
  });

  it('should open and close example menu correctly', () => {
    const field: RcConfigOption = {
      Name: 'vfs_cache_mode',
      FieldName: 'VfsCacheMode',
      Help: 'Cache mode',
      Type: 'string',
      DefaultStr: 'off',
      Examples: [
        { Value: 'off', Help: 'Disable' },
        { Value: 'full', Help: 'Full cache' },
      ],
    };

    const dummyRect = {
      left: 100,
      top: 200,
      bottom: 220,
      right: 180,
      width: 80,
      height: 20,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    } as DOMRect;

    expect(component.activeExampleMenu()).toBeNull();

    component.openExampleMenu(dummyRect, 'vfs_cache_mode', field.Examples ?? [], field, {
      from: 10,
      to: 16,
    });

    const menu = component.activeExampleMenu();
    expect(menu).toBeTruthy();
    expect(menu?.keyText).toBe('vfs_cache_mode');
    expect(menu?.examples.length).toBe(2);
    expect(component.menuAnchorPos()).toEqual({ x: 100, y: 200, width: 80, height: 20 });

    component.closeExampleMenu();
    expect(component.activeExampleMenu()).toBeNull();
  });

  it('should set anchor position correctly when opening example menu', () => {
    const field: RcConfigOption = {
      Name: 'test',
      FieldName: 'Test',
      Help: '',
      Type: 'Duration',
      DefaultStr: '10s',
    };

    component.openExampleMenu(
      {
        left: 50,
        top: 100,
        bottom: 120,
        right: 150,
        width: 100,
        height: 20,
        toJSON: () => ({}),
      } as DOMRect,
      'test',
      [{ Value: '10s', Help: '10s' }],
      field,
      { from: 0, to: 0 }
    );

    expect(component.activeExampleMenu()).not.toBeNull();
    expect(component.menuAnchorPos()).toEqual({ x: 50, y: 100, width: 100, height: 20 });
  });

  it('should format boolean, number, and string replacements correctly in selectExample', () => {
    const mockDispatch = vi.fn();
    const mockFocus = vi.fn();
    const mockDestroy = vi.fn();
    const mockDoc = {
      sliceString: vi.fn().mockReturnValue(':'),
    };
    (component as unknown as { editorView: unknown }).editorView = {
      dispatch: mockDispatch,
      focus: mockFocus,
      destroy: mockDestroy,
      state: { doc: mockDoc },
    };

    // 1. Boolean field
    component.openExampleMenu(
      {
        left: 0,
        top: 0,
        bottom: 20,
        right: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      } as DOMRect,
      'test_bool',
      [{ Value: 'true', Help: '' }],
      { Name: 'test_bool', FieldName: 'TestBool', Help: '', Type: 'bool', DefaultStr: 'false' },
      { from: 10, to: 10 }
    );
    component.selectExample('true');
    expect(mockDispatch).toHaveBeenCalledWith({
      changes: { from: 10, to: 10, insert: ' true' },
    });
    expect(component.activeExampleMenu()).toBeNull();

    // 2. Numeric field
    component.openExampleMenu(
      {
        left: 0,
        top: 0,
        bottom: 20,
        right: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      } as DOMRect,
      'test_num',
      [{ Value: '4', Help: '' }],
      { Name: 'test_num', FieldName: 'TestNum', Help: '', Type: 'int', DefaultStr: '0' },
      { from: 5, to: 8 }
    );
    component.selectExample('4');
    expect(mockDispatch).toHaveBeenCalledWith({
      changes: { from: 5, to: 8, insert: '4' },
    });

    // 3. String field
    component.openExampleMenu(
      {
        left: 0,
        top: 0,
        bottom: 20,
        right: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      } as DOMRect,
      'test_str',
      [{ Value: 'full', Help: '' }],
      { Name: 'test_str', FieldName: 'TestStr', Help: '', Type: 'string', DefaultStr: '' },
      { from: 5, to: 8 }
    );
    component.selectExample('full');
    expect(mockDispatch).toHaveBeenCalledWith({
      changes: { from: 5, to: 8, insert: '"full"' },
    });
  });
});
