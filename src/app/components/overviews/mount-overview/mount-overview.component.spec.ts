import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MountOverviewComponent } from './mount-overview.component';

describe('MountOverviewComponent', () => {
  let component: MountOverviewComponent;
  let fixture: ComponentFixture<MountOverviewComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MountOverviewComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MountOverviewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
