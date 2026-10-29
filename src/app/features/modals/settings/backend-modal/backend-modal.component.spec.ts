import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { BackendModalComponent } from './backend-modal.component';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { BackendInfo } from '@app/types';

const backend = (overrides: Partial<BackendInfo>): BackendInfo => ({
  name: 'NAS',
  isLocal: false,
  isAuthGenerated: false,
  host: '10.0.0.5',
  port: 51900,
  isActive: false,
  hasAuth: false,
  hasConfigPassword: false,
  ...overrides,
});

describe('BackendModalComponent', () => {
  let fixture: ComponentFixture<BackendModalComponent>;
  let component: BackendModalComponent;
  let backends: ReturnType<typeof signal<BackendInfo[]>>;
  let service: Record<string, ReturnType<typeof vi.fn>>;
  let notifications: { showSuccess: ReturnType<typeof vi.fn>; showError: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    backends = signal([
      backend({ name: 'Local', isLocal: true, isActive: true, host: '127.0.0.1' }),
      backend({ status: { type: 'connected' }, os: 'Linux', version: 'v1.76.0' }),
    ]);
    service = {
      loadBackends: vi.fn().mockResolvedValue(undefined),
      refreshStatuses: vi.fn().mockResolvedValue(undefined),
      switchBackend: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn(),
      testConnectionDetails: vi.fn().mockResolvedValue({ success: true, version: 'v1' }),
      updateBackend: vi.fn().mockResolvedValue(undefined),
      addBackend: vi.fn().mockResolvedValue(undefined),
      mapFormToConfig: vi.fn().mockReturnValue({ mapped: true }),
    };
    notifications = { showSuccess: vi.fn(), showError: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [BackendModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
        { provide: NotificationService, useValue: notifications },
        { provide: FileSystemService, useValue: {} },
        {
          provide: BackendService,
          useValue: {
            ...service,
            backends,
            activeBackend: signal('Local'),
            isLoading: signal(false),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BackendModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('loads the list and then probes the remotes', () => {
    expect(service['loadBackends']).toHaveBeenCalledOnce();
    expect(service['refreshStatuses']).toHaveBeenCalledOnce();
  });

  it('derives icon, status class and tooltip key from the backend state', () => {
    const [local, nas] = component.backendsWithMetadata();
    expect(local).toMatchObject({
      icon: 'home',
      statusClass: 'unknown',
      statusKey: 'modals.backend.status.notTested',
    });
    expect(nas).toMatchObject({
      icon: 'linux',
      statusClass: 'connected',
      statusKey: 'modals.backend.status.connected',
    });

    backends.set([backend({ status: { type: 'error', message: 'refused' }, os: 'windows' })]);
    expect(component.backendsWithMetadata()[0]).toMatchObject({
      icon: 'windows',
      statusClass: 'error',
      statusKey: 'modals.backend.status.error',
      statusMessage: 'refused',
    });
  });

  describe('editing', () => {
    it('never prefills the stored password and lets an empty field keep it', () => {
      component.startEdit(backend({ hasAuth: true, username: 'admin' }));

      const form = component.backendForm;
      expect(form.get('username')?.value).toBe('admin');
      expect(form.get('password')?.value).toBe('');
      expect(form.get('has_auth')?.value).toBe(true);
      expect(component.keepsStoredPassword()).toBe(true);
      expect(form.get('password')?.hasError('required')).toBe(false);
      expect(form.valid).toBe(true);
    });

    it('requires a password when custom authentication is newly enabled', () => {
      component.startEdit(backend({ hasAuth: true, isAuthGenerated: true, username: 'gen' }));

      expect(component.keepsStoredPassword()).toBe(false);
      component.setAuthStatus(true);

      expect(component.backendForm.get('password')?.hasError('required')).toBe(true);
    });

    it('saves an edit through the shared form mapping and reports it once', async () => {
      component.startEdit(backend({ hasAuth: false }));

      await component.saveBackend();

      expect(service['mapFormToConfig']).toHaveBeenCalledWith(
        expect.objectContaining({ host: '10.0.0.5', name: 'NAS' }),
        false,
        'NAS'
      );
      expect(service['updateBackend']).toHaveBeenCalledWith({ mapped: true });
      expect(notifications.showSuccess).toHaveBeenCalledOnce();
      expect(component.formMode()).toBeNull();
    });

    it('clears the form state when closed', () => {
      component.startEdit(backend({ hasAuth: true, username: 'admin' }));
      component.cancelEdit();

      expect(component.formMode()).toBeNull();
      expect(component.keepsStoredPassword()).toBe(false);
      expect(component.backendForm.get('name')?.enabled).toBe(true);
      expect(component.backendForm.get('host')?.value).toBe('localhost');
    });
  });

  describe('testing the form', () => {
    it('sends no credentials while custom authentication is off', async () => {
      component.backendForm.patchValue({
        host: 'nas',
        port: 51900,
        has_auth: false,
        username: 'stale',
        password: 'stale',
      });

      await component.testFormConnection();

      expect(service['testConnectionDetails']).toHaveBeenCalledWith({
        host: 'nas',
        port: 51900,
        username: undefined,
        password: undefined,
        name: undefined,
      });
    });

    it('names the edited backend so its stored password can stand in', async () => {
      component.startEdit(backend({ hasAuth: true, username: 'admin' }));

      await component.testFormConnection();

      expect(service['testConnectionDetails']).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'admin', password: undefined, name: 'NAS' })
      );
      expect(component.formTestResult()).toEqual({ success: true, version: 'v1' });
    });

    it('drops a result that finishes after a field changed', async () => {
      let finish!: (value: { success: boolean }) => void;
      service['testConnectionDetails'].mockReturnValue(new Promise(resolve => (finish = resolve)));

      const test = component.testFormConnection();
      expect(component.testingForm()).toBe(true);
      component.onConnectionFieldChange();
      finish({ success: true });
      await test;

      expect(component.formTestResult()).toBeNull();
      expect(component.testingForm()).toBe(false);
    });
  });

  describe('switching and testing', () => {
    it('ignores a second switch while one is running and the active backend', async () => {
      let finish!: () => void;
      service['switchBackend'].mockReturnValue(new Promise<void>(resolve => (finish = resolve)));

      const first = component.switchToBackend('NAS');
      await component.switchToBackend('Other');
      await component.switchToBackend('Local');
      finish();
      await first;

      expect(service['switchBackend']).toHaveBeenCalledExactlyOnceWith('NAS');
      expect(component.switchingTo()).toBeNull();
    });

    it('leaves reporting a failed switch to the service and reloads the list', async () => {
      service['switchBackend'].mockRejectedValue(new Error('unreachable'));

      await component.switchToBackend('NAS');

      expect(notifications.showError).not.toHaveBeenCalled();
      expect(service['loadBackends']).toHaveBeenCalledTimes(2);
      expect(component.switchingTo()).toBeNull();
    });

    it('shows the result of a connection test', async () => {
      service['testConnection'].mockResolvedValueOnce({ success: true, version: 'v1.76.0' });
      await component.testBackend('NAS');
      expect(notifications.showSuccess).toHaveBeenCalledWith(expect.stringContaining('(v1.76.0)'));

      service['testConnection'].mockResolvedValueOnce({ success: false, message: 'refused' });
      await component.testBackend('NAS');
      expect(notifications.showError).toHaveBeenCalledExactlyOnceWith('refused');
      expect(component.testingBackend()).toBeNull();
    });
  });
});
