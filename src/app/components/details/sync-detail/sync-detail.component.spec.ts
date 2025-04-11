import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SyncDetailComponent } from './sync-detail.component';

describe('SyncDetailComponent', () => {
  let component: SyncDetailComponent;
  let fixture: ComponentFixture<SyncDetailComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SyncDetailComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(SyncDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
