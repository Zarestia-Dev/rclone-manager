import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatIconRegistry } from '@angular/material/icon';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { FileBrowserItem } from '@app/types';
import { IconService } from 'src/app/services/ui/icon.service';
import { NautilusTabOverviewComponent, TabPreview } from './nautilus-tab-overview.component';

const entry = (name: string, isDir = false): FileBrowserItem =>
  ({
    entry: { ID: '', Name: name, Path: name, IsDir: isDir, Size: 1, MimeType: '', ModTime: '' },
    meta: {},
  }) as FileBrowserItem;

describe('NautilusTabOverviewComponent', () => {
  let fixture: ComponentFixture<NautilusTabOverviewComponent>;
  let element: HTMLElement;
  const tabs: TabPreview[] = [
    { id: 1, title: 'Downloads', files: [entry('go', true), entry('app.apk')] },
    { id: 2, title: 'Empty', files: [] },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NautilusTabOverviewComponent],
      providers: [
        provideTranslateService(),
        { provide: IconService, useValue: { getIconForEntry: (): string => 'file' } },
        {
          provide: MatIconRegistry,
          useValue: {
            getNamedSvgIcon: vi.fn(() =>
              of(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
            ),
            getDefaultFontSetClass: (): string[] => ['material-icons'],
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(NautilusTabOverviewComponent);
    fixture.componentRef.setInput('tabs', tabs);
    fixture.componentRef.setInput('activeTabIndex', 1);
    fixture.detectChanges();
    element = fixture.nativeElement;
  });

  const cards = (): HTMLElement[] => Array.from(element.querySelectorAll('.tab-card'));

  it('shows each tab with its entries and marks the active one', () => {
    expect(cards().map(card => card.querySelector('.card-title')?.textContent?.trim())).toEqual([
      'Downloads',
      'Empty',
    ]);
    expect(
      Array.from(cards()[0].querySelectorAll('.preview-row')).map(row => row.textContent?.trim())
    ).toEqual(['go', 'app.apk']);
    // A folder without entries, or one still loading, shows an empty card.
    expect(cards()[1].querySelector('.empty-state')).not.toBeNull();
    expect(cards().map(card => card.classList.contains('active'))).toEqual([false, true]);
  });

  it('switches to a tab on tap or its main action, and closes one without switching', () => {
    const switched = vi.fn();
    const closed = vi.fn();
    fixture.componentInstance.switchTab.subscribe(switched);
    fixture.componentInstance.closeTab.subscribe(closed);

    cards()[0].click();
    cards()[1].querySelector<HTMLButtonElement>('.card-primary-action')?.click();
    cards()[1].querySelector<HTMLButtonElement>('.close-card')?.click();

    expect(switched.mock.calls).toEqual([[0], [1]]);
    expect(closed).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('asks for a new tab and for the overview to close', () => {
    const created = vi.fn();
    const dismissed = vi.fn();
    fixture.componentInstance.newTab.subscribe(created);
    fixture.componentInstance.closeOverview.subscribe(dismissed);

    element.querySelector<HTMLButtonElement>('footer button')?.click();
    element.querySelector<HTMLButtonElement>('header button')?.click();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(created).toHaveBeenCalledOnce();
    expect(dismissed).toHaveBeenCalledTimes(2);
  });
});
