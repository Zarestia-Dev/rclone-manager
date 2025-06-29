import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PreferencesModalComponent } from './preferences-modal.component';

describe('PreferencesModalComponent', () => {
  let component: PreferencesModalComponent;
  let fixture: ComponentFixture<PreferencesModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PreferencesModalComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(PreferencesModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
