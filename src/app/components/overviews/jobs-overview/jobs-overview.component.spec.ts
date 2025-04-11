import { ComponentFixture, TestBed } from '@angular/core/testing';

import { JobsOverviewComponent } from './jobs-overview.component';

describe('JobsOverviewComponent', () => {
  let component: JobsOverviewComponent;
  let fixture: ComponentFixture<JobsOverviewComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [JobsOverviewComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(JobsOverviewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
