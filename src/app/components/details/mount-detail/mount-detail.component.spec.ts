import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MountDetailComponent } from './mount-detail.component';

describe('MountDetailComponent', () => {
  let component: MountDetailComponent;
  let fixture: ComponentFixture<MountDetailComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MountDetailComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MountDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
