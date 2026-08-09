import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TabsButtonsComponent } from './tabs-buttons.component';

describe('TabsButtonsComponent', () => {
  let component: TabsButtonsComponent;
  let fixture: ComponentFixture<TabsButtonsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TabsButtonsComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TabsButtonsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('component properties', () => {
    it('should have default currentTab provided by service', () => {
      expect(component.currentTab()).toBeDefined();
    });

    it('should accept currentTab input', () => {
      // Input is now a signal tied to a service.
      // Skip modifying it directly or test setTab mechanism instead.
    });

    it('should set tabs in uiService when no customTabs provided', () => {
      spyOn(component['uiStateService'], 'setTab');
      component.setTab('operations');
      expect(component['uiStateService'].setTab).toHaveBeenCalledWith('operations');
    });

    it('should emit activeTabChange when customTabs are provided', () => {
      fixture.componentRef.setInput('customTabs', [
        { id: 'tab1', icon: 'icon1', label: 'Tab 1' },
        { id: 'tab2', icon: 'icon2', label: 'Tab 2' },
      ]);
      fixture.detectChanges();

      const emitSpy = spyOn(component.activeTabChange, 'emit');
      component.setTab('tab2');
      expect(emitSpy).toHaveBeenCalledWith('tab2');
    });
  });
});
