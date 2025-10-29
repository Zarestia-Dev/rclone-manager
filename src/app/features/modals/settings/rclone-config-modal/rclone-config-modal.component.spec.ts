import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RcloneConfigModalComponent } from './rclone-config-modal.component';

describe('RcloneConfigModalComponent', () => {
  let component: RcloneConfigModalComponent;
  let fixture: ComponentFixture<RcloneConfigModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RcloneConfigModalComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(RcloneConfigModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
