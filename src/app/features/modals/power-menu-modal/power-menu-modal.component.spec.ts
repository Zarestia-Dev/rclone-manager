import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';

import { PowerMenuModalComponent } from './power-menu-modal.component';
import { AppLifecycleService } from '../../../services/infrastructure/system/app-lifecycle.service';
import { NotificationService } from '../../../services/ui/notification.service';
import { JobManagementService } from '../../../services/operations/job-management.service';
import { MountManagementService } from '../../../services/operations/mount-management.service';
import { ServeManagementService } from '../../../services/operations/serve-management.service';
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
  let jobServiceSpy: {
    jobs: ReturnType<typeof signal<JobInfo[]>>;
    stopAllActiveJobs: ReturnType<typeof vi.fn>;
  };
  let mountServiceSpy: {
    mountedRemotes: ReturnType<typeof signal<MountedRemote[]>>;
    unmountAllRemotes: ReturnType<typeof vi.fn>;
  };
  let serveServiceSpy: {
    runningServes: ReturnType<typeof signal<ServeListItem[]>>;
    stopAllServes: ReturnType<typeof vi.fn>;
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
    jobServiceSpy = {
      jobs: signal<JobInfo[]>([]),
      stopAllActiveJobs: vi.fn().mockResolvedValue(undefined),
    };
    mountServiceSpy = {
      mountedRemotes: signal<MountedRemote[]>([]),
      unmountAllRemotes: vi.fn().mockResolvedValue(undefined),
    };
    serveServiceSpy = {
      runningServes: signal<ServeListItem[]>([]),
      stopAllServes: vi.fn().mockResolvedValue(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [PowerMenuModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: AppLifecycleService, useValue: appLifecycleSpy },
        { provide: NotificationService, useValue: notificationServiceSpy },
        { provide: JobManagementService, useValue: jobServiceSpy },
        { provide: MountManagementService, useValue: mountServiceSpy },
        { provide: ServeManagementService, useValue: serveServiceSpy },
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

  it('should allow shutdown-app on native Android while filtering system power and restart', () => {
    component.isNativeMobile.set(true);
    component.isIOS.set(false);
    const actions = component.powerActions();
    expect(actions.length).toBe(2);
    expect(actions.map(a => a.id)).toEqual(['shutdown-app', 'emergency-stop']);
  });

  it('should filter out shutdown-app and restart-app on native iOS', () => {
    component.isNativeMobile.set(true);
    component.isIOS.set(true);
    const actions = component.powerActions();
    expect(actions.length).toBe(1);
    expect(actions.map(a => a.id)).toEqual(['emergency-stop']);
  });

  it('should compute active operations as false when empty', () => {
    expect(component.hasActiveOperations()).toBe(false);
  });

  it('should compute active operations as true when jobs or mounts exist', () => {
    jobServiceSpy.jobs.set([{ id: 1, status: 'Running' } as unknown as JobInfo]);
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
    expect(jobServiceSpy.stopAllActiveJobs).toHaveBeenCalled();
    expect(mountServiceSpy.unmountAllRemotes).toHaveBeenCalledWith('normal');
    expect(serveServiceSpy.stopAllServes).toHaveBeenCalledWith('normal');
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
