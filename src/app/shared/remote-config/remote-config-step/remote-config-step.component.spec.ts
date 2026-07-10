import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';

import { RemoteConfigStepComponent } from './remote-config-step.component';

describe('RemoteConfigStepComponent', () => {
  let component: RemoteConfigStepComponent;
  let fixture: ComponentFixture<RemoteConfigStepComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteConfigStepComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteConfigStepComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should disable name and type controls in remote edit mode', () => {
    fixture.componentRef.setInput(
      'form',
      new FormGroup({
        name: new FormControl('my-remote'),
        type: new FormControl('s3'),
      })
    );
    fixture.componentRef.setInput('isTypeLocked', true);

    fixture.detectChanges();

    expect(component.form().get('name')?.disabled).toBeTrue();
    expect(component.remoteSearchCtrl.disabled).toBeTrue();
  });
});
