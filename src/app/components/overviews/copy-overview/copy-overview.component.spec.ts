import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CopyOverviewComponent } from './copy-overview.component';

describe('CopyOverviewComponent', () => {
  let component: CopyOverviewComponent;
  let fixture: ComponentFixture<CopyOverviewComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CopyOverviewComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(CopyOverviewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
