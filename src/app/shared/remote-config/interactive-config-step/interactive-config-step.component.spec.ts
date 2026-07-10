import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';

import { InteractiveConfigStepComponent } from './interactive-config-step.component';
import { RcConfigQuestionResponse } from '@app/types';

function makeQuestion(
  overrides: Partial<NonNullable<RcConfigQuestionResponse['Option']>> = {}
): RcConfigQuestionResponse {
  return {
    State: 'state-1',
    Error: '',
    Option: {
      Name: 'storage',
      FieldName: 'storage',
      Help: 'Choose a storage provider or enter one manually.',
      DefaultStr: '',
      Type: 'string',
      Examples: [
        { Value: 's3', Help: 'Amazon S3' },
        { Value: 'gcs', Help: 'Google Cloud Storage' },
      ],
      ...overrides,
    },
  };
}

describe('InteractiveConfigStepComponent', () => {
  let component: InteractiveConfigStepComponent;
  let fixture: ComponentFixture<InteractiveConfigStepComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InteractiveConfigStepComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(InteractiveConfigStepComponent);
    component = fixture.componentInstance;
  });

  it('renders a custom input when examples are not exclusive', () => {
    fixture.componentRef.setInput('question', makeQuestion({ Exclusive: false }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mat-select')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('input')).toBeTruthy();
    expect(component.allowsCustomValue()).toBeTrue();
  });

  it('keeps the selected example in sync with the current answer', () => {
    fixture.componentRef.setInput('question', makeQuestion({ Exclusive: false }));
    fixture.detectChanges();

    expect(component.selectedIndex()).toBeNull();

    component.onSelectionChange(1);
    expect(component.answer()).toBe('gcs');
    expect(component.selectedIndex()).toBe(1);

    component.onAnswerChange('custom-storage');
    expect(component.answer()).toBe('custom-storage');
    expect(component.selectedIndex()).toBeNull();
  });
});
