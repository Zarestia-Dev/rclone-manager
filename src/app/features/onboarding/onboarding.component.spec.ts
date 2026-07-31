import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OnboardingComponent } from './onboarding.component';

describe('OnboardingComponent', () => {
  let component: OnboardingComponent;
  let fixture: ComponentFixture<OnboardingComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OnboardingComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OnboardingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render at least the welcome and ready cards', () => {
    const keys = component.cards().map(c => c.key);
    expect(keys).toContain('welcome');
    expect(keys).toContain('ready');
  });

  it('should expose a primary button with an action', () => {
    const btn = component.primaryButton();
    expect(typeof btn.action).toBe('function');
    expect(btn.labelKey).not.toBeNull();
  });

  it('should default viewportHeight to null', () => {
    expect(component.viewportHeight()).toBeNull();
  });

  it('should allow navigation backward or staying on current card', () => {
    expect(component.canNavigateToCard(0)).toBe(true);
  });

  it('should prevent forward navigation if primary button is disabled', () => {
    // When installation is in progress or invalid, primaryButton().disabled is true
    component.installationValid.set(false);
    // Find index of installRclone if present
    const installIndex = component.cards().findIndex(c => c.key === 'installRclone');
    if (installIndex !== -1) {
      component.currentCardIndex.set(installIndex);
      expect(component.canNavigateToCard(installIndex + 1)).toBe(false);

      const initialIndex = component.currentCardIndex();
      component.goToCard(installIndex + 1);
      expect(component.currentCardIndex()).toBe(initialIndex);
    }
  });
});
