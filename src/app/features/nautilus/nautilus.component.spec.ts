import { ComponentFixture, TestBed } from '@angular/core/testing';

import { NautilusComponent } from './nautilus.component';

describe('NautilusComponent', () => {
  let component: NautilusComponent;
  let fixture: ComponentFixture<NautilusComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NautilusComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(NautilusComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
