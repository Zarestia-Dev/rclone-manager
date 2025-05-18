import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RemoteConfigStepComponent } from './remote-config-step.component';

describe('RemoteConfigStepComponent', () => {
  let component: RemoteConfigStepComponent;
  let fixture: ComponentFixture<RemoteConfigStepComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteConfigStepComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(RemoteConfigStepComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
