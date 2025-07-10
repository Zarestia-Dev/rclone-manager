import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LogsModalComponent } from './logs-modal.component';

describe('LogsModalComponent', () => {
  let component: LogsModalComponent;
  let fixture: ComponentFixture<LogsModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LogsModalComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(LogsModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
