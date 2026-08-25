import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { UserTemplateService } from './user-template.service';
import { UserPresetTemplate } from '@app/types';
import { NotificationService } from '../ui/notification.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';

describe('UserTemplateService', () => {
  let service: UserTemplateService;
  let notificationSpy: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showInfo: ReturnType<typeof vi.fn>;
  };
  let invokeSpy: ReturnType<typeof vi.fn>;

  const mockTemplates: Record<string, Omit<UserPresetTemplate, 'id'>> = {
    'tpl-1': {
      name: 'Fast Sync',
      description: 'Fast sync profile',
      values: {
        vfs: { vfs_cache_mode: 'full' },
        backend: { transfers: 8 },
      },
    },
  };

  beforeEach(() => {
    notificationSpy = {
      showSuccess: vi.fn(),
      showError: vi.fn(),
      showInfo: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        UserTemplateService,
        { provide: NotificationService, useValue: notificationSpy },
        {
          provide: TranslateService,
          useValue: { instant: vi.fn((k: string) => k), get: vi.fn(() => of('')) },
        },
        {
          provide: BackendTranslationService,
          useValue: { translateError: vi.fn((k: string) => k) },
        },
        {
          provide: ApiClientService,
          useValue: { invoke: vi.fn(), get: vi.fn(), post: vi.fn() },
        },
        {
          provide: SseClientService,
          useValue: { listen: vi.fn(() => of()) },
        },
      ],
    });

    service = TestBed.inject(UserTemplateService);
    invokeSpy = vi.spyOn(
      service as unknown as { invokeCommand: (...args: unknown[]) => Promise<unknown> },
      'invokeCommand'
    ) as unknown as ReturnType<typeof vi.fn>;
  });

  describe('syncFromBackend', () => {
    it('should populate userTemplates from backend map', async () => {
      invokeSpy.mockResolvedValue(mockTemplates);

      await service.syncFromBackend();

      expect(service.loaded()).toBe(true);
      expect(service.userTemplates().length).toBe(1);
      expect(service.userTemplates()[0]).toEqual({
        id: 'tpl-1',
        name: 'Fast Sync',
        description: 'Fast sync profile',
        values: {
          vfs: { vfs_cache_mode: 'full' },
          backend: { transfers: 8 },
        },
      });
    });

    it('should handle backend error gracefully', async () => {
      invokeSpy.mockRejectedValue(new Error('Backend error'));

      await service.syncFromBackend();

      expect(service.loaded()).toBe(true);
      expect(service.userTemplates()).toEqual([]);
    });
  });

  describe('saveTemplate', () => {
    it('should optimistically add a template and notify on success', async () => {
      invokeSpy.mockResolvedValue(undefined);

      const input = {
        name: 'New Template',
        description: 'Testing save',
        values: { vfs: { vfs_cache_mode: 'writes' } },
      };

      const result = service.saveTemplate(input);

      expect(result.id).toMatch(/^usr-tpl-/);
      expect(result.name).toBe('New Template');
      expect(service.userTemplates().length).toBe(1);
      expect(service.userTemplates()[0].id).toBe(result.id);

      // Wait for async backend resolution
      await Promise.resolve();

      expect(invokeSpy).toHaveBeenCalledWith('save_user_template', {
        id: result.id,
        template: input,
      });
      expect(notificationSpy.showSuccess).toHaveBeenCalled();
    });

    it('should roll back local state and notify error on backend failure', async () => {
      const error = new Error('Disk full');
      invokeSpy.mockRejectedValue(error);

      const input = {
        name: 'Failed Template',
        values: {},
      };

      service.saveTemplate(input);
      expect(service.userTemplates().length).toBe(1);

      // Wait for async backend rejection
      await Promise.resolve();
      await Promise.resolve();

      expect(service.userTemplates().length).toBe(0);
      expect(notificationSpy.showError).toHaveBeenCalledWith(error);
    });
  });

  describe('updateTemplate', () => {
    it('should update existing template and notify on success', async () => {
      invokeSpy.mockResolvedValue(mockTemplates);
      await service.syncFromBackend();

      invokeSpy.mockResolvedValue(undefined);

      const updated: UserPresetTemplate = {
        id: 'tpl-1',
        name: 'Updated Fast Sync',
        description: 'New description',
        values: { backend: { transfers: 16 } },
      };

      service.updateTemplate(updated);

      expect(service.userTemplates()[0]).toEqual(updated);

      await Promise.resolve();

      expect(invokeSpy).toHaveBeenCalledWith('update_user_template', {
        id: 'tpl-1',
        template: {
          name: 'Updated Fast Sync',
          description: 'New description',
          values: { backend: { transfers: 16 } },
        },
      });
      expect(notificationSpy.showSuccess).toHaveBeenCalled();
    });

    it('should roll back to previous template state on backend failure', async () => {
      invokeSpy.mockResolvedValue(mockTemplates);
      await service.syncFromBackend();

      const error = new Error('Update failed');
      invokeSpy.mockRejectedValue(error);

      const updated: UserPresetTemplate = {
        id: 'tpl-1',
        name: 'Failed Update',
        values: {},
      };

      service.updateTemplate(updated);
      expect(service.userTemplates()[0].name).toBe('Failed Update');

      await Promise.resolve();
      await Promise.resolve();

      expect(service.userTemplates()[0].name).toBe('Fast Sync');
      expect(notificationSpy.showError).toHaveBeenCalledWith(error);
    });

    it('should ignore update for non-existent template ID', () => {
      const nonExistent: UserPresetTemplate = {
        id: 'unknown-id',
        name: 'Does not exist',
        values: {},
      };

      service.updateTemplate(nonExistent);

      expect(invokeSpy).not.toHaveBeenCalledWith('update_user_template', expect.anything());
    });
  });

  describe('deleteTemplate', () => {
    it('should remove template and notify info on success', async () => {
      invokeSpy.mockResolvedValue(mockTemplates);
      await service.syncFromBackend();

      invokeSpy.mockResolvedValue(undefined);

      service.deleteTemplate('tpl-1');

      expect(service.userTemplates().length).toBe(0);

      await Promise.resolve();

      expect(invokeSpy).toHaveBeenCalledWith('delete_user_template', { id: 'tpl-1' });
      expect(notificationSpy.showInfo).toHaveBeenCalled();
    });

    it('should roll back template state on backend failure', async () => {
      invokeSpy.mockResolvedValue(mockTemplates);
      await service.syncFromBackend();

      const error = new Error('Delete failed');
      invokeSpy.mockRejectedValue(error);

      service.deleteTemplate('tpl-1');
      expect(service.userTemplates().length).toBe(0);

      await Promise.resolve();
      await Promise.resolve();

      expect(service.userTemplates().length).toBe(1);
      expect(service.userTemplates()[0].id).toBe('tpl-1');
      expect(notificationSpy.showError).toHaveBeenCalledWith(error);
    });
  });
});
