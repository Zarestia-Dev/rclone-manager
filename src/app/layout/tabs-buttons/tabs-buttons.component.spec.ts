import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TabsButtonsComponent } from './tabs-buttons.component';
import { provideTranslateService } from '@ngx-translate/core';

describe('TabsButtonsComponent', () => {
  let component: TabsButtonsComponent;
  let fixture: ComponentFixture<TabsButtonsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TabsButtonsComponent],
      providers: [provideTranslateService()],
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

    it('should reflect isEditingLayout state from UiStateService', () => {
      expect(component.isEditingLayout()).toBeFalse();
      component['uiStateService'].startLayoutEdit({
        overviewId: 'general',
      });
      fixture.detectChanges();

      expect(component.isEditingLayout()).toBeTrue();
      component['uiStateService'].endLayoutEdit();
      expect(component.isEditingLayout()).toBeFalse();
    });
  });
});
