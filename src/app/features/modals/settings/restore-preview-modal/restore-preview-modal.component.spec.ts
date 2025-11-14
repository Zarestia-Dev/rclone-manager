import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RestorePreviewModalComponent } from './restore-preview-modal.component';

describe('RestorePreviewModalComponent', () => {
  let component: RestorePreviewModalComponent;
  let fixture: ComponentFixture<RestorePreviewModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RestorePreviewModalComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(RestorePreviewModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
