import { Injectable, signal } from '@angular/core';
import { UserPresetTemplate } from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

@Injectable({ providedIn: 'root' })
export class UserTemplateService extends TauriBaseService {
  private readonly _templates = signal<UserPresetTemplate[]>([]);
  private readonly _loaded = signal<boolean>(false);

  readonly userTemplates = this._templates.asReadonly();
  readonly loaded = this._loaded.asReadonly();

  constructor() {
    super();
    void this.syncFromBackend();
  }

  async syncFromBackend(): Promise<void> {
    try {
      const map =
        await this.invokeCommand<Record<string, Omit<UserPresetTemplate, 'id'>>>(
          'list_user_templates'
        );
      if (map && typeof map === 'object') {
        const templates: UserPresetTemplate[] = Object.entries(map).map(([id, tpl]) => ({
          id,
          ...tpl,
        }));
        this._templates.set(templates);
      }
    } catch (err) {
      console.warn('[UserTemplateService] Failed to load templates from backend:', err);
    } finally {
      this._loaded.set(true);
    }
  }

  saveTemplate(input: Omit<UserPresetTemplate, 'id'>): UserPresetTemplate {
    const id = `usr-tpl-${crypto.randomUUID()}`;
    const newTemplate: UserPresetTemplate = { id, ...input };
    const previous = this._templates();

    this._templates.set([newTemplate, ...previous]);

    this.invokeCommand('save_user_template', { id, template: input })
      .then(() => {
        this.notificationService.showSuccess(
          this.translate.instant('templates.savedSuccess', { name: newTemplate.name })
        );
      })
      .catch(err => {
        console.warn('[UserTemplateService] Failed to save template to rcman backend:', err);
        this._templates.set(previous);
        this.notificationService.showError(err);
      });

    return newTemplate;
  }

  updateTemplate(updated: UserPresetTemplate): void {
    const previous = this._templates();
    const index = previous.findIndex(t => t.id === updated.id);
    if (index < 0) {
      console.warn(`[UserTemplateService] Cannot update unknown template: ${updated.id}`);
      return;
    }

    const list = [...previous];
    list[index] = updated;
    this._templates.set(list);

    const { id, ...template } = updated;
    this.invokeCommand('update_user_template', { id, template })
      .then(() => {
        this.notificationService.showSuccess(
          this.translate.instant('templates.savedSuccess', { name: updated.name })
        );
      })
      .catch(err => {
        console.warn('[UserTemplateService] Failed to update template on rcman backend:', err);
        this._templates.set(previous);
        this.notificationService.showError(err);
      });
  }

  deleteTemplate(id: string): void {
    const previous = this._templates();
    const updated = previous.filter(t => t.id !== id);
    this._templates.set(updated);

    this.invokeCommand('delete_user_template', { id })
      .then(() => {
        this.notificationService.showInfo(this.translate.instant('templates.deletedSuccess'));
      })
      .catch(err => {
        console.warn('[UserTemplateService] Failed to delete template on rcman backend:', err);
        this._templates.set(previous);
        this.notificationService.showError(err);
      });
  }
}
