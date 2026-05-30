import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';
import { FlagType, RcConfigOption } from '@app/types';

import { FlagConfigStepComponent } from './flag-config-step.component';

describe('FlagConfigStepComponent', () => {
  let component: FlagConfigStepComponent;
  let fixture: ComponentFixture<FlagConfigStepComponent>;

  const buildForm = (flagType: FlagType, typeValue = ''): FormGroup => {
    return new FormGroup({
      [`${flagType}Config`]: new FormGroup({
        options: new FormGroup({
          type: new FormControl(typeValue),
          test_option: new FormControl(''),
          test_option_two: new FormControl(''),
        }),
      }),
    });
  };

  const setRequiredInputs = (flagType: FlagType, form: FormGroup): void => {
    fixture.componentRef.setInput('form', form);
    fixture.componentRef.setInput('flagType', flagType);
    fixture.componentRef.setInput('currentRemoteName', 'demo-remote');
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FlagConfigStepComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(FlagConfigStepComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    setRequiredInputs('vfs', buildForm('vfs'));
    fixture.detectChanges();

    expect(component).toBeTruthy();
  });

  it('should filter dynamic fields and build stable bindings', () => {
    setRequiredInputs('vfs', buildForm('vfs'));

    fixture.componentRef.setInput('dynamicFlagFields', [
      {
        Name: 'Test Option',
        FieldName: 'test_option',
        Help: 'This controls test behavior',
        DefaultStr: '',
        Type: 'string',
      } as RcConfigOption,
      {
        Name: 'Another Field',
        FieldName: 'test_option_two',
        Help: 'Another value',
        DefaultStr: '',
        Type: 'string',
      } as RcConfigOption,
    ]);
    fixture.componentRef.setInput('searchQuery', 'controls test');
    fixture.detectChanges();

    const bindings = component.dynamicFieldBindings();
    expect(bindings.length).toBe(1);
    expect(bindings[0].controlKey).toBe('test_option');
    expect(bindings[0].trackKey).toBe('test_option');
  });

  it('should sync serve trigger display with form control value', () => {
    setRequiredInputs('serve', buildForm('serve', 'ftp'));
    fixture.componentRef.setInput('selectedServeType', 'http');
    fixture.detectChanges();

    expect(component.serveTypeValue()).toBe('ftp');
  });
});
