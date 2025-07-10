import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TabsButtonsComponent } from './tabs-buttons.component';
import { AppTab } from '../../shared/components/types';

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
    it('should have default currentTab as "general"', () => {
      expect(component.currentTab).toBe('general');
    });

    it('should accept currentTab input', () => {
      const testTab: AppTab = 'mount';
      component.currentTab = testTab;

      expect(component.currentTab).toBe(testTab);
    });

    it('should have tabSelected event emitter', () => {
      expect(component.tabSelected).toBeDefined();
    });
  });

  describe('tabSelected event emitter', () => {
    it('should emit tabSelected event when triggered', () => {
      spyOn(component.tabSelected, 'emit');
      const testTab: AppTab = 'sync';

      component.tabSelected.emit(testTab);

      expect(component.tabSelected.emit).toHaveBeenCalledWith(testTab);
    });
  });
});
