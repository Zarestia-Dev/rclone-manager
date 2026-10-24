import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RemoteCardActionsComponent } from './remote-card-actions.component';
import {
  ActionButtonClickEvent,
  OpenFolderClickEvent,
  ProfilePickerClickEvent,
} from './remote-card.types';
import { OpenableFolder } from '@app/types';

describe('RemoteCardActionsComponent', () => {
  let fixture: ComponentFixture<RemoteCardActionsComponent>;
  let component: RemoteCardActionsComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteCardActionsComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteCardActionsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('emits actionClick when onActionButtonClick is called', () => {
    let emitted: ActionButtonClickEvent | undefined;
    component.actionClick.subscribe((val: ActionButtonClickEvent) => {
      emitted = val;
    });

    const event = new MouseEvent('click');
    component.onActionButtonClick({ id: 'mount', event });

    expect(emitted).toBeDefined();
    expect(emitted?.id).toBe('mount');
  });

  it('emits profilePickerClick when onProfilePickerClick is called', () => {
    let emitted: ProfilePickerClickEvent | undefined;
    component.profilePickerClick.subscribe((val: ProfilePickerClickEvent) => {
      emitted = val;
    });

    const event = new MouseEvent('click');
    component.onProfilePickerClick('sync', 'daily', event);

    expect(emitted).toBeDefined();
    expect(emitted?.operation).toBe('sync');
    expect(emitted?.profile).toBe('daily');
  });

  it('emits openFolderClick when onOpenFolderClick is called', () => {
    let emitted: OpenFolderClickEvent | undefined;
    component.openFolderClick.subscribe((val: OpenFolderClickEvent) => {
      emitted = val;
    });

    const folder: OpenableFolder = {
      operation: 'mount',
      profile: 'default',
      path: '/mnt/test',
      cssClass: 'mounted',
      tooltip: 'Open folder',
      isLocal: false,
      icon: 'folder',
    };
    const event = new MouseEvent('click');
    component.onOpenFolderClick(folder, event);

    expect(emitted).toBeDefined();
    expect(emitted?.folder.path).toBe('/mnt/test');
  });
});
