import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { describe, expect, it } from 'vitest';
import { FlagConfigStepComponent } from './flag-config-step.component';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { MatIconRegistry } from '@angular/material/icon';
import { By } from '@angular/platform-browser';
import { Observable, of } from 'rxjs';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { JsonEditorComponent } from 'src/app/shared/components/json-editor/json-editor.component';

describe('FlagConfigStepComponent search', () => {
  it('preserves the JSON editor and validation errors when no flags match', () => {
    TestBed.configureTestingModule({
      imports: [FlagConfigStepComponent],
      providers: [
        provideTranslateService(),
        { provide: UiStateService, useValue: { showJsonMode: signal(true) } },
        { provide: IconService, useValue: {} },
        {
          provide: AppSettingsService,
          useValue: { selectSetting: (): Observable<{ value: boolean }> => of({ value: false }) },
        },
        {
          provide: MatIconRegistry,
          useValue: {
            getNamedSvgIcon: (): Observable<SVGElement> =>
              of(document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
          },
        },
      ],
    }).overrideComponent(JsonEditorComponent, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(FlagConfigStepComponent);
    const group = new FormGroup({
      options: new FormGroup({ createEmptySrcDirs: new FormControl(true) }),
    });
    fixture.componentRef.setInput('form', new FormGroup({ copyConfig: group }));
    fixture.componentRef.setInput('flagType', 'copy');
    fixture.componentRef.setInput('dynamicFlagFields', [
      { Name: 'createEmptySrcDirs', FieldName: '', Help: '', Type: 'bool', DefaultStr: 'false' },
    ]);
    fixture.detectChanges();
    const editor = fixture.debugElement.query(By.directive(JsonEditorComponent))
      .componentInstance as JsonEditorComponent;
    (editor as unknown as { applyEditorChanges: (text: string) => void }).applyEditorChanges('{');
    expect(group.hasError('jsonParse')).toBe(true);
    fixture.componentRef.setInput('searchQuery', 'unrelated');
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(JsonEditorComponent))?.componentInstance).toBe(
      editor
    );
    fixture.componentRef.setInput('searchQuery', '');
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(JsonEditorComponent))?.componentInstance).toBe(
      editor
    );
    expect(editor.parseError()?.key).toBe('shared.jsonEditor.parseError');
    expect(group.get('options.createEmptySrcDirs')?.value).toBe(true);
  });

  it('moves the two Windows display flags out of the advanced list without removing their values', () => {
    TestBed.configureTestingModule({
      imports: [FlagConfigStepComponent],
      providers: [
        provideTranslateService(),
        { provide: UiStateService, useValue: { showJsonMode: signal(false) } },
        { provide: IconService, useValue: {} },
      ],
    }).overrideComponent(FlagConfigStepComponent, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(FlagConfigStepComponent);
    const options = new FormGroup({
      volname: new FormControl('Archive'),
      network_mode: new FormControl(true),
      direct_io: new FormControl(false),
    });
    fixture.componentRef.setInput(
      'form',
      new FormGroup({ mountConfig: new FormGroup({ options }) })
    );
    fixture.componentRef.setInput('flagType', 'mount');
    fixture.componentRef.setInput(
      'dynamicFlagFields',
      ['volname', 'network_mode', 'direct_io'].map(Name => ({
        Name,
        FieldName: '',
        Help: '',
        Type: 'string',
        DefaultStr: '',
      }))
    );
    fixture.componentRef.setInput('showWindowsMountTarget', true);
    fixture.detectChanges();
    expect(fixture.componentInstance.dynamicFieldBindings().map(field => field.controlKey)).toEqual(
      ['direct_io']
    );
    expect(options.value).toEqual({ volname: 'Archive', network_mode: true, direct_io: false });

    fixture.componentRef.setInput('showWindowsMountTarget', false);
    fixture.detectChanges();
    expect(fixture.componentInstance.dynamicFieldBindings().map(field => field.controlKey)).toEqual(
      ['volname', 'network_mode', 'direct_io']
    );
  });

  it('shows the automatic Windows method even when the backend only lists cmount', () => {
    TestBed.configureTestingModule({
      imports: [FlagConfigStepComponent],
      providers: [
        provideTranslateService(),
        { provide: UiStateService, useValue: { showJsonMode: signal(false) } },
        { provide: IconService, useValue: {} },
      ],
    }).overrideComponent(FlagConfigStepComponent, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(FlagConfigStepComponent);
    fixture.componentRef.setInput('flagType', 'mount');
    fixture.componentRef.setInput('showWindowsMountTarget', true);
    const field = {
      Name: 'mountType',
      FieldName: 'mountType',
      Help: '',
      Type: 'string',
      DefaultStr: 'mount',
      Examples: [{ Value: 'cmount', Help: 'Windows FUSE' }],
    };
    fixture.componentRef.setInput('dynamicFlagFields', [field]);
    expect(fixture.componentInstance.dynamicFieldBindings()[0].field.Examples).toEqual([
      { Value: 'mount', Help: 'wizards.remoteConfig.defaultMountMethod' },
      ...field.Examples,
    ]);
    expect(field.Examples).toHaveLength(1);
  });

  it('finds camelCase CLI flags and translated titles without changing controls', () => {
    TestBed.configureTestingModule({
      imports: [FlagConfigStepComponent],
      providers: [
        provideTranslateService({ lang: 'tr' }),
        { provide: UiStateService, useValue: { showJsonMode: signal(false) } },
        { provide: IconService, useValue: {} },
      ],
    }).overrideComponent(FlagConfigStepComponent, { set: { template: '', imports: [] } });
    TestBed.inject(TranslateService).setTranslation('tr', {
      create_empty_src_dirs: { title: 'Boş dizinleri oluştur' },
    });
    const fixture = TestBed.createComponent(FlagConfigStepComponent);
    const control = new FormControl(true);
    fixture.componentRef.setInput(
      'form',
      new FormGroup({
        copyConfig: new FormGroup({ options: new FormGroup({ createEmptySrcDirs: control }) }),
      })
    );
    fixture.componentRef.setInput('flagType', 'copy');
    fixture.componentRef.setInput('dynamicFlagFields', [
      {
        Name: 'createEmptySrcDirs',
        FieldName: 'createEmptySrcDirs',
        Help: '',
        Type: 'bool',
        DefaultStr: 'false',
      },
    ]);
    for (const query of ['--create-empty-src-dirs', 'boş dizinleri']) {
      fixture.componentRef.setInput('searchQuery', query);
      expect(fixture.componentInstance.dynamicFieldBindings().map(b => b.controlKey)).toEqual([
        'createEmptySrcDirs',
      ]);
    }
    fixture.componentRef.setInput('searchQuery', 'unrelated  query');
    expect(fixture.componentInstance.dynamicFieldBindings()).toEqual([]);
    expect(control.value).toBe(true);
  });
});
