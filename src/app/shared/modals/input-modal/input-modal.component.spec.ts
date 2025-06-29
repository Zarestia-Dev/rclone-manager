import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InputModalComponent } from './input-modal.component';

describe('InputModalComponent', () => {
  let component: InputModalComponent;
  let fixture: ComponentFixture<InputModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InputModalComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(InputModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
