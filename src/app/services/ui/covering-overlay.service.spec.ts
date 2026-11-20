import { TestBed } from '@angular/core/testing';
import { OverlayRef } from '@angular/cdk/overlay';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoveringOverlayService } from './covering-overlay.service';

describe('CoveringOverlayService', () => {
  let service: CoveringOverlayService;
  let app: HTMLElement;
  let appButton: HTMLButtonElement;
  let announcer: HTMLElement;
  let container: HTMLElement;

  const addOverlay = (): { overlayRef: OverlayRef; host: HTMLElement } => {
    const wrapper = document.createElement('div');
    const host = document.createElement('section');
    host.append(document.createElement('button'));
    wrapper.append(host);
    container.append(wrapper);
    return { overlayRef: { hostElement: wrapper } as unknown as OverlayRef, host };
  };

  beforeEach(() => {
    app = document.createElement('div');
    appButton = document.createElement('button');
    app.append(appButton);
    announcer = document.createElement('div');
    announcer.setAttribute('aria-live', 'polite');
    container = document.createElement('div');
    document.body.append(app, announcer, container);
    service = TestBed.inject(CoveringOverlayService);
  });

  afterEach(() => {
    app.remove();
    announcer.remove();
    container.remove();
  });

  it('makes the content behind an overlay inert and moves focus into it', () => {
    appButton.focus();
    const { overlayRef, host } = addOverlay();
    service.cover(overlayRef, host);
    expect(app.hasAttribute('inert')).toBe(true);
    expect(container.hasAttribute('inert')).toBe(false);
    expect(announcer.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(host);

    service.uncover(overlayRef);
    expect(app.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(appButton);
  });

  it('keeps focus that the overlay already moved inside it', () => {
    const { overlayRef, host } = addOverlay();
    const inner = host.querySelector('button');
    inner?.focus();
    service.cover(overlayRef, host);
    expect(document.activeElement).toBe(inner);
    expect(host.hasAttribute('tabindex')).toBe(false);
  });

  it('leaves only the top overlay and later ones interactive', () => {
    const below = addOverlay();
    service.cover(below.overlayRef, below.host);
    const top = addOverlay();
    service.cover(top.overlayRef, top.host);
    const menu = document.createElement('div');
    container.append(menu);
    expect(below.overlayRef.hostElement.hasAttribute('inert')).toBe(true);
    expect(top.overlayRef.hostElement.hasAttribute('inert')).toBe(false);
    expect(menu.hasAttribute('inert')).toBe(false);

    service.uncover(top.overlayRef);
    expect(below.overlayRef.hostElement.hasAttribute('inert')).toBe(false);
    expect(app.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(below.host);
  });

  it('keeps the content covered while a newer workspace replaces an older one', () => {
    appButton.focus();
    const older = addOverlay();
    service.cover(older.overlayRef, older.host);
    const newer = addOverlay();
    service.cover(newer.overlayRef, newer.host);
    service.uncover(older.overlayRef);
    expect(app.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(newer.host);

    service.uncover(newer.overlayRef);
    expect(app.hasAttribute('inert')).toBe(false);
    // Focus goes back to where it was before the first workspace, not into the closed one.
    expect(document.activeElement).toBe(appButton);
  });

  it('does not clear inert that something else set', () => {
    app.setAttribute('inert', '');
    const { overlayRef, host } = addOverlay();
    service.cover(overlayRef, host);
    service.uncover(overlayRef);
    expect(app.hasAttribute('inert')).toBe(true);
  });
});
