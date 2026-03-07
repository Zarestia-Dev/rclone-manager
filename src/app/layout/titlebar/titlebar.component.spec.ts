import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TitlebarComponent } from './titlebar.component';

describe('TitlebarComponent', () => {
  let component: TitlebarComponent;
  let fixture: ComponentFixture<TitlebarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TitlebarComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TitlebarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('computes rcloneRestartRequired from service state', () => {
    // simulate a state where the rclone service reports a pending restart
    const fakeStatus = {
      available: false,
      updating: false,
      readyToRestart: true,
      checking: false,
      error: null,
      lastCheck: null,
      updateInfo: null,
    };

    // override the readonly signal by casting to any; the component only calls it
    (component.rcloneUpdateService.updateStatus as any) = () => fakeStatus;

    expect(component.rcloneRestartRequired()).toBeTrue();
    expect(component.updateTooltip()).toContain('Restart');

    // badge expression should also evaluate truthy
    const badgeText =
      component.restartRequired() ||
      component.rcloneRestartRequired() ||
      component.updateAvailable() ||
      component.rcloneUpdateAvailable();
    expect(!!badgeText).toBeTrue();
  });
});
