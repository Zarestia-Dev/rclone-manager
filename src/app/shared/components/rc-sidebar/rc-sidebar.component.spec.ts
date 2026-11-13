import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RcCommandInfo } from '@app/types';
import { RcSidebarComponent } from './rc-sidebar.component';

const command = (Path: string, Title = ''): RcCommandInfo => ({ Path, Title, Help: '' });

describe('RcSidebarComponent', () => {
  let fixture: ComponentFixture<RcSidebarComponent>;
  let component: RcSidebarComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RcSidebarComponent],
      providers: [provideTranslateService()],
    }).compileComponents();
    fixture = TestBed.createComponent(RcSidebarComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('commands', [
      command('core/version', 'Shows the version'),
      command('core/quit', 'Exit rclone'),
      command('operations/list', 'List files'),
      command('operations/purge', 'Remove a directory'),
      command('vfs/list', 'List the VFSes'),
    ]);
    fixture.detectChanges();
  });

  it('groups the calls by module in the order they come', () => {
    expect(component.groups().map(g => [g.module, g.commands.length])).toEqual([
      ['core', 2],
      ['operations', 2],
      ['vfs', 1],
    ]);
  });

  it('opens a module on click and closes it again', () => {
    expect(component.isOpen('core')).toBe(false);
    component.toggle('core');
    expect(component.isOpen('core')).toBe(true);
    component.toggle('core');
    expect(component.isOpen('core')).toBe(false);
  });

  it('opens the module of the typed call, which a click then closes', () => {
    fixture.componentRef.setInput('selected', 'operations/list');
    expect(component.isOpen('operations')).toBe(true);
    expect(component.isOpen('core')).toBe(false);
    component.toggle('operations');
    expect(component.isOpen('operations')).toBe(false);
  });

  it('filters by path or title and opens every match', () => {
    component.filter.set('purge');
    expect(component.groups().map(g => g.commands.map(c => c.Path))).toEqual([
      ['operations/purge'],
    ]);
    expect(component.isOpen('operations')).toBe(true);

    component.filter.set('vfses');
    expect(component.groups().map(g => g.module)).toEqual(['vfs']);
    component.filter.set('nothing');
    expect(component.groups()).toEqual([]);
  });

  it('marks dangerous calls, and calls read-only mode blocks', () => {
    expect(component.flag('core/quit')).toBe('shield-xmark');
    expect(component.flag('sync/copy')).toBeNull();

    fixture.componentRef.setInput('readOnly', true);
    expect(component.flag('operations/list')).toBeNull();
    expect(component.flag('sync/copy')).toBe('lock');

    fixture.componentRef.setInput('readOnly', false);
    expect(component.flag('sync/copy')).toBeNull();
    expect(component.flag('core/quit')).toBe('shield-xmark');
  });

  it('emits the picked call and the clear request', () => {
    const picked: string[] = [];
    let cleared = 0;
    component.pick.subscribe(p => picked.push(p));
    component.clearRequested.subscribe(() => cleared++);

    component.toggle('core');
    fixture.detectChanges();
    const items: HTMLButtonElement[] = [...fixture.nativeElement.querySelectorAll('.command')];
    items[0].click();
    expect(picked).toEqual(['core/version']);

    fixture.componentRef.setInput('canClear', true);
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelectorAll('.sidebar-footer button')[1] as HTMLButtonElement
    ).click();
    expect(cleared).toBe(1);
  });

  it('starts with the search hidden, and hiding it drops the filter', () => {
    expect(component.searchVisible()).toBe(false);
    component.setSearchVisible(true);
    component.filter.set('purge');
    expect(component.groups()).toHaveLength(1);

    component.setSearchVisible(false);
    expect(component.filter()).toBe('');
    expect(component.groups()).toHaveLength(3);
  });

  it('shows and hides the search from the footer item', () => {
    const toggle = (): HTMLButtonElement =>
      fixture.nativeElement.querySelector('.sidebar-footer button');
    toggle().click();
    fixture.detectChanges();
    expect(component.searchVisible()).toBe(true);
    expect(fixture.nativeElement.querySelector('.search-container.visible')).not.toBeNull();

    toggle().click();
    fixture.detectChanges();
    expect(component.searchVisible()).toBe(false);
  });

  it('filters from the search box', () => {
    component.setSearchVisible(true);
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector(
      'app-search-container input'
    );
    input.value = 'vfs';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(component.filter()).toBe('vfs');
    expect(component.groups().map(g => g.module)).toEqual(['vfs']);
  });

  it('names a call without its module', () => {
    expect(component.name('operations/list')).toBe('list');
    expect(component.name('pluginsctl/addPlugin')).toBe('addPlugin');
  });
});
