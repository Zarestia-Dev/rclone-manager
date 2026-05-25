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
    const fakeState = {
      status: 'READY_TO_RESTART',
      version: '1.2.3',
    };

    // override the read-only signal by casting to any
    (component['rcloneUpdateService']['_updateState'] as any) = () => fakeState;

    expect(component.rcloneRestartRequired()).toBeTrue();
    expect(component.updateTooltip()).toContain('Restart');

    // badge expression should also evaluate truthy
    const badgeText = component.aboutMenuBadge();
    expect(!!badgeText).toBeTrue();
  });
});
