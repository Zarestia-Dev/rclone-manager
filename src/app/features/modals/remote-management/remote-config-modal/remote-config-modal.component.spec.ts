import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RemoteConfigModalComponent } from './remote-config-modal.component';

describe('RemoteConfigModalComponent', () => {
  let component: RemoteConfigModalComponent;
  let fixture: ComponentFixture<RemoteConfigModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteConfigModalComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteConfigModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
