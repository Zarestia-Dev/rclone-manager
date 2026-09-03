import { describe, it, expect } from 'vitest';
import { getNodeStyleMeta, getNotificationIcon, hasDetailedConfig } from './node-style.util';

describe('getNodeStyleMeta', () => {
  it('returns correct metadata for sync operation', () => {
    const meta = getNodeStyleMeta('sync');
    expect(meta.icon).toBe('refresh');
    expect(meta.cssClass).toBe('primary');
    expect(meta.pillClass).toBe('p-primary');
    expect(meta.titleKey).toBe('dashboard.appDetail.sync');
  });

  it('returns correct metadata for copy operation', () => {
    const meta = getNodeStyleMeta('copy');
    expect(meta.icon).toBe('copy');
    expect(meta.cssClass).toBe('yellow');
    expect(meta.pillClass).toBe('p-yellow');
  });

  it('returns correct metadata for move operation', () => {
    const meta = getNodeStyleMeta('move');
    expect(meta.icon).toBe('move');
    expect(meta.cssClass).toBe('orange');
    expect(meta.pillClass).toBe('p-orange');
  });

  it('returns correct metadata for bisync operation', () => {
    const meta = getNodeStyleMeta('bisync');
    expect(meta.icon).toBe('right-left');
    expect(meta.cssClass).toBe('purple');
    expect(meta.pillClass).toBe('p-purple');
  });

  it('returns correct metadata for delete operation', () => {
    const meta = getNodeStyleMeta('delete');
    expect(meta.icon).toBe('trash');
    expect(meta.cssClass).toBe('warn');
    expect(meta.pillClass).toBe('p-warn');
  });

  it('returns correct metadata for mount operation', () => {
    const meta = getNodeStyleMeta('mount');
    expect(meta.icon).toBe('mount');
    expect(meta.cssClass).toBe('accent');
    expect(meta.pillClass).toBe('p-accent');
  });

  it('returns correct metadata for cron trigger', () => {
    const meta = getNodeStyleMeta('cron');
    expect(meta.icon).toBe('clock');
    expect(meta.cssClass).toBe('purple');
    expect(meta.pillClass).toBe('p-purple');
  });

  it('returns correct metadata for app_start trigger', () => {
    const meta = getNodeStyleMeta('app_start');
    expect(meta.icon).toBe('bolt');
    expect(meta.cssClass).toBe('cyan');
    expect(meta.pillClass).toBe('p-cyan');
  });

  it('returns correct metadata for cleanup task', () => {
    const meta = getNodeStyleMeta('cleanup');
    expect(meta.icon).toBe('broom');
    expect(meta.cssClass).toBe('warn');
  });

  it('returns correct metadata for cryptcheck task', () => {
    const meta = getNodeStyleMeta('cryptcheck');
    expect(meta.icon).toBe('shield');
    expect(meta.cssClass).toBe('accent');
  });

  it('returns correct metadata for exec_script task', () => {
    const meta = getNodeStyleMeta('exec_script');
    expect(meta.icon).toBe('terminal');
    expect(meta.cssClass).toBe('purple');
  });

  it('returns correct metadata for quick_run task', () => {
    const meta = getNodeStyleMeta('quick_run');
    expect(meta.icon).toBe('quick-run');
    expect(meta.cssClass).toBe('orange');
  });

  it('returns correct metadata for stop logic node', () => {
    const meta = getNodeStyleMeta('stop');
    expect(meta.icon).toBe('stop');
    expect(meta.cssClass).toBe('warn');
  });

  it('returns correct metadata for unmount action', () => {
    const meta = getNodeStyleMeta('unmount');
    expect(meta.icon).toBe('eject');
    expect(meta.cssClass).toBe('warn');
  });

  it('returns correct metadata for stop_serve action', () => {
    const meta = getNodeStyleMeta('stop_serve');
    expect(meta.icon).toBe('stop');
    expect(meta.cssClass).toBe('warn');
  });

  it('returns correct metadata for system_power action', () => {
    const meta = getNodeStyleMeta('system_power');
    expect(meta.icon).toBe('power-off');
    expect(meta.cssClass).toBe('yellow');
  });

  it('returns correct metadata for log_audit action', () => {
    const meta = getNodeStyleMeta('log_audit');
    expect(meta.icon).toBe('file-lines');
    expect(meta.cssClass).toBe('dim');
  });

  it('returns fallback for unknown node type', () => {
    const meta = getNodeStyleMeta('unknown_custom_node');
    expect(meta.icon).toBe('workflow');
    expect(meta.cssClass).toBe('dim');
    expect(meta.pillClass).toBe('p-dim');
  });
});

describe('getNotificationIcon', () => {
  it('maps notification channels to proper icons', () => {
    expect(getNotificationIcon('whatsapp')).toBe('whatsapp');
    expect(getNotificationIcon('telegram')).toBe('telegram');
    expect(getNotificationIcon('webhook')).toBe('link');
    expect(getNotificationIcon('email')).toBe('envelope');
    expect(getNotificationIcon('mqtt')).toBe('message');
    expect(getNotificationIcon('script')).toBe('terminal');
    expect(getNotificationIcon('os_toast')).toBe('desktop');
    expect(getNotificationIcon(undefined)).toBe('bell');
  });
});

describe('hasDetailedConfig', () => {
  it('identifies nodes with detailed configuration modals including cryptcheck and archivecreate', () => {
    expect(hasDetailedConfig('sync')).toBe(true);
    expect(hasDetailedConfig('copy')).toBe(true);
    expect(hasDetailedConfig('archivecreate')).toBe(true);
    expect(hasDetailedConfig('cryptcheck')).toBe(true);
    expect(hasDetailedConfig('mount')).toBe(true);
    expect(hasDetailedConfig('cleanup')).toBe(false);
    expect(hasDetailedConfig(undefined)).toBe(false);
  });
});
