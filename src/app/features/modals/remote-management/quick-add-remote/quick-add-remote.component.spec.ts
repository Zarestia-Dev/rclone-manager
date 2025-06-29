import { ComponentFixture, TestBed } from '@angular/core/testing';

import { QuickAddRemoteComponent } from './quick-add-remote.component';

describe('QuickAddRemoteComponent', () => {
  let component: QuickAddRemoteComponent;
  let fixture: ComponentFixture<QuickAddRemoteComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [QuickAddRemoteComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(QuickAddRemoteComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
