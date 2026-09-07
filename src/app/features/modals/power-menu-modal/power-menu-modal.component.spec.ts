import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';

import { PowerMenuModalComponent } from './power-menu-modal.component';
import { AppLifecycleService } from '../../../services/infrastructure/system/app-lifecycle.service';
import { NotificationService } from '../../../services/ui/notification.service';
import { RemoteFacadeService } from '../../../services/facade/remote-facade.service';
import { JobInfo, MountedRemote, ServeListItem } from '@app/types';

describe('PowerMenuModalComponent', () => {
  let fixture: ComponentFixture<PowerMenuModalComponent>;
  let component: PowerMenuModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let appLifecycleSpy: {
    shutdownApp: ReturnType<typeof vi.fn>;
    relaunchApp: ReturnType<typeof vi.fn>;
    executeSystemPower: ReturnType<typeof vi.fn>;
  };
  let notificationServiceSpy: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  let remoteFacadeSpy: {
    jobs: ReturnType<typeof signal<JobInfo[]>>;
    mountedRemotes: ReturnType<typeof signal<MountedRemote[]>>;
    runningServes: ReturnType<typeof signal<ServeListItem[]>>;
    emergencyStopAll: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };
    appLifecycleSpy = {
      shutdownApp: vi.fn().mockResolvedValue(undefined),
      relaunchApp: vi.fn().mockResolvedValue(undefined),
      executeSystemPower: vi.fn().mockResolvedValue(undefined),
    };
    notificationServiceSpy = {
      showSuccess: vi.fn(),
      showError: vi.fn(),
    };
    remoteFacadeSpy = {
      jobs: signal<JobInfo[]>([]),
      mountedRemotes: signal<MountedRemote[]>([]),
      runningServes: signal<ServeListItem[]>([]),
      emergencyStopAll: vi.fn().mockResolvedValue(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [PowerMenuModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: AppLifecycleService, useValue: appLifecycleSpy },
        { provide: NotificationService, useValue: notificationServiceSpy },
        { provide: RemoteFacadeService, useValue: remoteFacadeSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PowerMenuModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
  });

  it('should render all power actions in desktop/headless mode', () => {
    expect(component.powerActions().length).toBe(6);
  });

  it('should allow shutdown-app on native Android while filtering system power', () => {
    component.isNativeMobile.set(true);
    component.isIOS.set(false);
    const actions = component.powerActions();
    expect(actions.length).toBe(3);
    expect(actions.map(a => a.id)).toEqual(['shutdown-app', 'restart-app', 'emergency-stop']);
  });

  it('should filter out shutdown-app on native iOS for App Store compliance', () => {
    component.isNativeMobile.set(true);
    component.isIOS.set(true);
    const actions = component.powerActions();
    expect(actions.length).toBe(2);
    expect(actions.map(a => a.id)).toEqual(['restart-app', 'emergency-stop']);
  });

  it('should compute active operations as false when empty', () => {
    expect(component.hasActiveOperations()).toBe(false);
  });

  it('should compute active operations as true when jobs or mounts exist', () => {
    remoteFacadeSpy.jobs.set([{ id: 1, status: 'Running' } as unknown as JobInfo]);
    expect(component.hasActiveOperations()).toBe(true);
    expect(component.activeJobsCount()).toBe(1);
  });

  it('should manage action selection', () => {
    const action = component.powerActions()[0];
    component.selectAction(action);
    expect(component.selectedAction()).toBe(action);

    component.clearSelection();
    expect(component.selectedAction()).toBeNull();
  });

  it('should execute action when executeAction is called', async () => {
    const action = component.powerActions()[0];
    const actionSpy = vi.spyOn(action, 'action');
    await component.executeAction(action);
    expect(actionSpy).toHaveBeenCalled();
  });

  it('should handle shutdown_app', async () => {
    await component.handleShutdownApp();
    expect(appLifecycleSpy.shutdownApp).toHaveBeenCalled();
  });

  it('should handle relaunch_app on restart', async () => {
    await component.handleRestartApp();
    expect(appLifecycleSpy.relaunchApp).toHaveBeenCalled();
  });

  it('should handle emergency stop', async () => {
    await component.handleEmergencyStop();
    expect(remoteFacadeSpy.emergencyStopAll).toHaveBeenCalled();
    expect(notificationServiceSpy.showSuccess).toHaveBeenCalled();
    expect(dialogRefSpy.close).toHaveBeenCalled();
  });

  it('should handle system power action sleep and lock', async () => {
    await component.handleSystemPower('sleep');
    expect(appLifecycleSpy.executeSystemPower).toHaveBeenCalledWith('sleep');
    expect(dialogRefSpy.close).toHaveBeenCalled();
  });

  it('should handle host shutdown', async () => {
    await component.handleSystemPower('shutdown');
    expect(appLifecycleSpy.executeSystemPower).toHaveBeenCalledWith('shutdown');
  });

  it('should close when not executing', () => {
    component.close();
    expect(dialogRefSpy.close).toHaveBeenCalled();
  });
});
