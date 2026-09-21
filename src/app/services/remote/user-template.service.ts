import { Injectable, signal, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UserPresetTemplate } from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { generatePrefixedId } from 'src/app/shared/utils';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';

@Injectable({ providedIn: 'root' })
export class UserTemplateService extends TauriBaseService {
  private readonly _templates = signal<UserPresetTemplate[]>([]);
  private readonly _loaded = signal<boolean>(false);
  private readonly eventListeners = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);

  readonly userTemplates = this._templates.asReadonly();
  readonly loaded = this._loaded.asReadonly();

  constructor() {
    super();
    void this.syncFromBackend();

    this.eventListeners
      .listenToSettingsCategory('templates')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.syncFromBackend();
      });
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
    const id = generatePrefixedId('usr-tpl');
    const newTemplate: UserPresetTemplate = { id, ...input };
    const previous = this._templates();

    this._templates.set([newTemplate, ...previous]);

    this.invokeWithNotification(
      'save_user_template',
      { id, template: input },
      {
        successKey: 'templates.savedSuccess',
        successParams: { name: newTemplate.name },
      }
    ).catch(err => {
      console.warn('[UserTemplateService] Failed to save template to rcman backend:', err);
      this._templates.set(previous);
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
    this.invokeWithNotification(
      'update_user_template',
      { id, template },
      {
        successKey: 'templates.savedSuccess',
        successParams: { name: updated.name },
      }
    ).catch(err => {
      console.warn('[UserTemplateService] Failed to update template on rcman backend:', err);
      this._templates.set(previous);
    });
  }

  deleteTemplate(id: string): void {
    const previous = this._templates();
    const updated = previous.filter(t => t.id !== id);
    this._templates.set(updated);

    this.invokeWithNotification(
      'delete_user_template',
      { id },
      {
        successKey: 'templates.deletedSuccess',
      }
    ).catch(err => {
      console.warn('[UserTemplateService] Failed to delete template on rcman backend:', err);
      this._templates.set(previous);
    });
  }
}
