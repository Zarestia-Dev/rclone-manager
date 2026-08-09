import { Injectable, signal, computed } from '@angular/core';
import { UserPresetTemplate } from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

@Injectable({ providedIn: 'root' })
export class UserTemplateService extends TauriBaseService {
  private readonly _templates = signal<UserPresetTemplate[]>([]);

  readonly userTemplates = this._templates.asReadonly();
  readonly allTemplates = computed(() => this._templates());

  constructor() {
    super();
    void this.syncFromBackend();
  }

  private async syncFromBackend(): Promise<void> {
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
    }
  }

  saveTemplate(input: Omit<UserPresetTemplate, 'id'>): UserPresetTemplate {
    const id = `usr-tpl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newTemplate: UserPresetTemplate = { id, ...input };

    const updated = [newTemplate, ...this._templates()];
    this._templates.set(updated);

    void this.invokeCommand('save_user_template', { id, template: input }).catch(err => {
      console.warn('[UserTemplateService] Failed to save template to rcman backend:', err);
    });

    this.notificationService.showSuccess(
      this.translate.instant('templates.savedSuccess', { name: newTemplate.name })
    );

    return newTemplate;
  }

  updateTemplate(updated: UserPresetTemplate): void {
    const current = this._templates();
    const index = current.findIndex(t => t.id === updated.id);
    if (index >= 0) {
      const list = [...current];
      list[index] = updated;
      this._templates.set(list);

      const { id, ...template } = updated;
      void this.invokeCommand('update_user_template', { id, template }).catch(err => {
        console.warn('[UserTemplateService] Failed to update template on rcman backend:', err);
      });

      this.notificationService.showSuccess(
        this.translate.instant('templates.savedSuccess', { name: updated.name })
      );
    }
  }

  deleteTemplate(id: string): void {
    if (id.startsWith('builtin-')) return;

    const updated = this._templates().filter(t => t.id !== id);
    this._templates.set(updated);

    void this.invokeCommand('delete_user_template', { id }).catch(err => {
      console.warn('[UserTemplateService] Failed to delete template on rcman backend:', err);
    });

    this.notificationService.showInfo(this.translate.instant('templates.deletedSuccess'));
  }
}
