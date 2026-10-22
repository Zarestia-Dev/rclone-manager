import { TestBed } from '@angular/core/testing';
import { MatIconRegistry } from '@angular/material/icon';
import { provideTranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { TransferOperationsService } from './transfer-operations.service';

describe('live check rendering', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        {
          provide: MatIconRegistry,
          useValue: {
            getNamedSvgIcon: (): Observable<SVGElement> =>
              of(document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
          },
        },
      ],
    });
    TestBed.overrideComponent(ActiveTransfersTableComponent, {
      set: { providers: [{ provide: TransferOperationsService, useValue: {} }] },
    });
  });

  it('reuses the display row when polling advances to a different checked file', () => {
    const fixture = TestBed.createComponent(ActiveTransfersTableComponent);
    fixture.componentRef.setInput('transfers', []);
    fixture.componentRef.setInput('checks', ['first.txt']);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const originalRow = element.querySelector('.card-row-item');

    fixture.componentRef.setInput('checks', ['folder/Ünicode.txt']);
    fixture.detectChanges();

    expect(element.querySelector('.card-row-item')).toBe(originalRow);
    const title = element.querySelector('.card-title-text');
    expect(title?.textContent?.trim()).toBe('folder/Ünicode.txt');
    expect(title?.getAttribute('title')).toBe('folder/Ünicode.txt');
  });

  it('updates reused slots correctly when checks reorder, filter, and finish', () => {
    const fixture = TestBed.createComponent(ActiveTransfersTableComponent);
    fixture.componentRef.setInput('transfers', []);
    fixture.componentRef.setInput('checks', ['first.txt', 'second.txt']);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const originalRows = Array.from(element.querySelectorAll('.card-row-item'));

    fixture.componentRef.setInput('checks', ['second.txt', 'first.txt']);
    fixture.detectChanges();
    expect(Array.from(element.querySelectorAll('.card-row-item'))).toEqual(originalRows);
    expect(element.querySelector('.card-title-text')?.textContent?.trim()).toBe('second.txt');

    fixture.componentRef.setInput('searchTerm', 'FIRST');
    fixture.detectChanges();
    expect(element.querySelectorAll('.card-row-item')).toHaveLength(1);
    expect(element.querySelector('.card-row-item')).toBe(originalRows[0]);
    expect(element.querySelector('.card-title-text')?.textContent?.trim()).toBe('first.txt');

    fixture.componentRef.setInput('checks', []);
    fixture.detectChanges();
    expect(element.querySelectorAll('.card-row-item')).toHaveLength(0);
    expect(element.querySelector('.empty-state')).not.toBeNull();
  });
});
