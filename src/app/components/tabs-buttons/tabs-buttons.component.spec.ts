import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TabsButtonsComponent } from './tabs-buttons.component';

describe('TabsButtonsComponent', () => {
  let component: TabsButtonsComponent;
  let fixture: ComponentFixture<TabsButtonsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TabsButtonsComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TabsButtonsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
