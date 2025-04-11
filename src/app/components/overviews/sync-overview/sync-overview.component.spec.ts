import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SyncOverviewComponent } from './sync-overview.component';

describe('SyncOverviewComponent', () => {
  let component: SyncOverviewComponent;
  let fixture: ComponentFixture<SyncOverviewComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SyncOverviewComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(SyncOverviewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
