import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AppOverviewComponent } from './app-overview.component';

describe('AppOverviewComponent', () => {
  let component: AppOverviewComponent;
  let fixture: ComponentFixture<AppOverviewComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppOverviewComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(AppOverviewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
