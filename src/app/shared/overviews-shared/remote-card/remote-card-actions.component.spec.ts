import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RemoteCardActionsComponent } from './remote-card-actions.component';
import { ProfilePickerGroup } from './remote-card.types';
import { OpenableFolder, QuickActionButton } from '@app/types';

describe('RemoteCardActionsComponent', () => {
  let fixture: ComponentFixture<RemoteCardActionsComponent>;
  let component: RemoteCardActionsComponent;

  const mountButton: QuickActionButton = {
    id: 'mount',
    icon: 'mount',
    tooltipKey: 'overviews.remoteCard.actions.mount',
    tone: 'accent',
  };

  const buttons = (): HTMLButtonElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('button'));

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteCardActionsComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteCardActionsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders nothing but the row when there are no buttons and no folders', () => {
    expect(buttons()).toHaveLength(0);
  });

  it('emits the operation of a clicked button without letting the click reach the card', () => {
    const emitted = vi.fn();
    const cardClick = vi.fn();
    component.actionClick.subscribe(emitted);
    fixture.nativeElement.addEventListener('click', cardClick);
    fixture.componentRef.setInput('actionButtons', [mountButton]);
    fixture.detectChanges();

    buttons()[0].click();

    expect(emitted).toHaveBeenCalledWith('mount');
    expect(cardClick).not.toHaveBeenCalled();
  });

  it('appends the profile to the tooltip of a running operation', () => {
    fixture.componentRef.setInput('actionButtons', [{ ...mountButton, tooltipProfile: 'nas' }]);
    fixture.detectChanges();

    expect(buttons()[0].getAttribute('title')).toBe('overviews.remoteCard.actions.mount (nas)');
  });

  it('disables a button that has no profile to run', () => {
    fixture.componentRef.setInput('actionButtons', [{ ...mountButton, isDisabled: true }]);
    fixture.detectChanges();

    expect(buttons()[0].disabled).toBe(true);
  });

  it('replaces the plain button by a counted profile menu when several profiles exist', () => {
    const picker: ProfilePickerGroup = {
      operation: 'mount',
      tone: 'accent',
      triggerTooltipKey: 'overviews.remoteCard.actions.mount',
      triggerIcon: 'mount',
      isActive: false,
      isBusy: false,
      entries: [
        {
          operation: 'mount',
          profile: 'a',
          isActive: false,
          isBusy: false,
          startIcon: 'mount',
          stopIcon: 'eject',
          tone: 'accent',
        },
        {
          operation: 'mount',
          profile: 'b',
          isActive: false,
          isBusy: false,
          startIcon: 'mount',
          stopIcon: 'eject',
          tone: 'accent',
        },
      ],
    };
    const emitted = vi.fn();
    component.actionClick.subscribe(emitted);
    fixture.componentRef.setInput('actionButtons', [mountButton]);
    fixture.componentRef.setInput('profilePickers', { mount: picker });
    fixture.detectChanges();

    expect(buttons()).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.folder-badge').textContent.trim()).toBe('2');
    buttons()[0].click();
    expect(emitted).not.toHaveBeenCalled();
  });

  it('emits profilePick with the operation and profile of a menu entry', () => {
    const emitted = vi.fn();
    component.profilePick.subscribe(emitted);

    component['onPick']('sync', 'daily', new MouseEvent('click'));

    expect(emitted).toHaveBeenCalledWith({ operation: 'sync', profile: 'daily' });
  });

  it('forwards a folder chosen on the browse button', () => {
    const folder: OpenableFolder = {
      key: 'mount:default:/mnt/test',
      operation: 'mount',
      profile: 'default',
      path: '/mnt/test',
      tone: 'accent',
      detail: 'test',
      isOpening: false,
      icon: 'folder',
    };
    const emitted = vi.fn();
    component.openFolder.subscribe(emitted);
    fixture.componentRef.setInput('openableFolders', [folder]);
    fixture.detectChanges();

    buttons()[0].click();

    expect(emitted).toHaveBeenCalledWith(folder);
  });

  describe('browse button (shared folder-browse-button)', () => {
    const folder = (over: Partial<OpenableFolder> = {}): OpenableFolder => ({
      key: 'k',
      operation: 'sync',
      profile: 'daily',
      path: '/data/a',
      tone: 'accent',
      label: 'daily',
      detail: 'a',
      isOpening: false,
      icon: 'folder',
      ...over,
    });
    const set = (folders: OpenableFolder[]): void => {
      fixture.componentRef.setInput('openableFolders', folders);
      fixture.detectChanges();
    };

    it('renders nothing without folders', () => {
      set([]);
      expect(buttons()).toHaveLength(0);
    });

    it('names the single folder by label and short name in its tooltip', () => {
      set([folder()]);
      expect(buttons()[0].getAttribute('title')).toBe('overviews.remoteCard.browse: daily (a)');
    });

    it('uses a translated label key instead of the raw label when there is one', () => {
      set([folder({ labelKey: 'detailShared.pathDisplay.source', label: undefined })]);
      expect(buttons()[0].getAttribute('title')).toBe(
        'overviews.remoteCard.browse: detailShared.pathDisplay.source (a)'
      );
    });

    it('disables the single button and shows a spinner while its folder opens', () => {
      set([folder({ isOpening: true })]);
      expect(buttons()[0].disabled).toBe(true);
      expect(
        fixture.nativeElement.querySelector('mat-icon')?.getAttribute('data-mat-icon-name')
      ).toBe('spinner');
    });

    it('collapses several folders into one counted menu button', () => {
      set([folder({ key: '1' }), folder({ key: '2', path: '/data/b' })]);
      expect(buttons()).toHaveLength(1);
      expect(fixture.nativeElement.querySelector('.folder-badge').textContent.trim()).toBe('2');
      expect(buttons()[0].getAttribute('title')).toBe('overviews.remoteCard.browse');
    });

    it('takes the tone of its folders when they agree', () => {
      set([folder({ key: '1' }), folder({ key: '2' })]);
      expect(buttons()[0].getAttribute('data-tone')).toBe('accent');
      expect(buttons()[0].style.background).toBe('');
    });

    it('draws a gradient across the tones of its folders when they differ', () => {
      set([folder({ key: '1', tone: 'accent' }), folder({ key: '2', tone: 'orange' })]);
      expect(buttons()[0].hasAttribute('data-tone')).toBe(false);
      expect(buttons()[0].style.background).toContain('linear-gradient');
    });

    it('disables the menu button while any folder opens', () => {
      set([folder({ key: '1' }), folder({ key: '2', isOpening: true })]);
      expect(buttons()[0].disabled).toBe(true);
    });
  });
});
