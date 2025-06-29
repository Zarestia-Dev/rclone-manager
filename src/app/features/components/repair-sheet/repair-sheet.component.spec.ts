import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RepairSheetComponent } from './repair-sheet.component';

describe('RepairSheetComponent', () => {
  let component: RepairSheetComponent;
  let fixture: ComponentFixture<RepairSheetComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RepairSheetComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(RepairSheetComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
