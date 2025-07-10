import { ComponentFixture, TestBed } from '@angular/core/testing';

import { KeyboardShortcutsModalComponent } from './keyboard-shortcuts-modal.component';

describe('KeyboardShortcutsModalComponent', () => {
  let component: KeyboardShortcutsModalComponent;
  let fixture: ComponentFixture<KeyboardShortcutsModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KeyboardShortcutsModalComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(KeyboardShortcutsModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
