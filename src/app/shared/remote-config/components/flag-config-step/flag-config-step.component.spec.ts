import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FlagConfigStepComponent } from './flag-config-step.component';

describe('FlagConfigStepComponent', () => {
  let component: FlagConfigStepComponent;
  let fixture: ComponentFixture<FlagConfigStepComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FlagConfigStepComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(FlagConfigStepComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
