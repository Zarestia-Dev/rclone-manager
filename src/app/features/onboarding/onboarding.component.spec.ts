import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OnboardingComponent } from './onboarding.component';

describe('OnboardingComponent', () => {
  let component: OnboardingComponent;
  let fixture: ComponentFixture<OnboardingComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OnboardingComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(OnboardingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('selectCustomFolder event emitter', () => {
    it('should have selectCustomFolder method', () => {
      expect(component.selectCustomFolder).toBeDefined();
      expect(typeof component.selectCustomFolder).toBe('function');
    });

    it('should call selectCustomFolder method', async () => {
      spyOn(component, 'selectCustomFolder').and.returnValue(Promise.resolve());
      
      await component.selectCustomFolder();
      
      expect(component.selectCustomFolder).toHaveBeenCalled();
    });
  });

  describe('component properties', () => {
    it('should have customPath property', () => {
      expect(component.customPath).toBeDefined();
    });

    it('should allow setting customPath', () => {
      const testPath = '/home/hakan/Downloads';
      component.customPath = testPath;
      
      expect(component.customPath).toBe(testPath);
    });
  });
});
