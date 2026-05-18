import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RcloneFlagsModalComponent } from './rclone-flags-modal.component';

describe('RcloneFlagsModalComponent', () => {
  let component: RcloneFlagsModalComponent;
  let fixture: ComponentFixture<RcloneFlagsModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RcloneFlagsModalComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(RcloneFlagsModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
