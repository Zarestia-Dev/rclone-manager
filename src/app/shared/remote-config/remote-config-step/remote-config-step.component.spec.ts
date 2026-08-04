import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { FormControl, FormGroup } from '@angular/forms';
import { signal } from '@angular/core';

import { RemoteConfigStepComponent } from './remote-config-step.component';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

// The spec tests form-disable behavior in remote edit mode. None of the
// injected services are exercised, so we stub them to avoid pulling in
// HttpClient, MatSnackBar, MatDialog, MatIconRegistry, etc.
function stubRemoteManagement(): Partial<RemoteManagementService> {
  return {
    isInteractiveRemote: () => false,
    getRemoteTypes: () => Promise.resolve([]),
  };
}

function stubIconService(): Partial<IconService> {
  return {
    getIconName: () => 'cloud',
  };
}

function stubUiStateService(): Partial<UiStateService> {
  const showJsonMode = signal(false);
  return {
    showJsonMode,
    toggleShowJsonMode: () => showJsonMode.update(v => !v),
  } as unknown as Partial<UiStateService>;
}

function createForm(): FormGroup {
  return new FormGroup({
    name: new FormControl('my-remote'),
    type: new FormControl('s3'),
  });
}

describe('RemoteConfigStepComponent', () => {
  let component: RemoteConfigStepComponent;
  let fixture: ComponentFixture<RemoteConfigStepComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteConfigStepComponent],
      providers: [
        provideTranslateService(),
        { provide: RemoteManagementService, useValue: stubRemoteManagement() },
        { provide: IconService, useValue: stubIconService() },
        { provide: UiStateService, useValue: stubUiStateService() },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteConfigStepComponent);
    component = fixture.componentInstance;
    // form is input.required — must set before first detectChanges.
    fixture.componentRef.setInput('form', createForm());
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should disable name and type controls in remote edit mode', () => {
    fixture.componentRef.setInput('isTypeLocked', true);
    fixture.componentRef.setInput('isNameLocked', true);

    fixture.detectChanges();

    expect(component.form().get('name')?.disabled).toBe(true);
    expect(component.remoteSearchCtrl.disabled).toBe(true);
  });
});
