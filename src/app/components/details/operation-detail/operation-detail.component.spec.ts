import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OperationDetailComponent } from './operation-detail.component';

describe('OperationDetailComponent', () => {
  let component: OperationDetailComponent;
  let fixture: ComponentFixture<OperationDetailComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OperationDetailComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(OperationDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
