import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MascotComponent } from './mascot.component';

describe('MascotComponent', () => {
  let fixture: ComponentFixture<MascotComponent>;
  let component: MascotComponent;
  let reducedMotion: boolean;
  let hidden: boolean;
  let now: number;
  let random: ReturnType<typeof vi.spyOn>;

  // Math.random() answers, in the order the component asks for them.
  const NO_DELAY = 0; // timer delay: 2400ms
  const SHAKE = 0.05;
  const BLINK = 0.3;
  const TURN = 0.6;
  const TWITCH = 0.8;
  const HOP = 0.95;
  const LEFT = 0.2;
  const RIGHT = 0.7;
  const SINGLE = 0.9; // one blink, not two
  const DOUBLE = 0.1;
  const NO_BLINK = 0.9; // no blink while turning

  /** Create the component, with Math.random answering `values` in order and then 0. */
  const create = (...values: number[]): void => {
    values.forEach(value => random.mockReturnValueOnce(value));
    fixture = TestBed.createComponent(MascotComponent);
    component = fixture.componentInstance;
  };

  /** Queue the next Math.random answers. */
  const answer = (...values: number[]): void => {
    values.forEach(value => random.mockReturnValueOnce(value));
  };

  /** Let exactly one pending timer fire: its delay is 2400ms while Math.random() answers 0. */
  const tick = (): void => {
    vi.advanceTimersByTime(2400);
  };

  /** Show or hide the window. */
  const setHidden = (value: boolean): void => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  const svg = (): SVGSVGElement => fixture.nativeElement.querySelector('svg');

  beforeEach(() => {
    vi.useFakeTimers();
    reducedMotion = false;
    hidden = false;
    now = 1000;
    random = vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    TestBed.configureTestingModule({ imports: [MascotComponent] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts calm and is hidden from assistive technology', () => {
    create();
    fixture.detectChanges();

    expect(component.body()).toBe('still');
    expect(component.blinks()).toBe(0);
    expect(component.twitch()).toBeNull();
    expect(component.look()).toBe('ahead');
    expect(fixture.nativeElement.getAttribute('aria-hidden')).toBe('true');
  });

  describe('shaking', () => {
    it('starts on a low roll and stops when the body animation ends', () => {
      create(NO_DELAY, SHAKE);
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      expect(component.body()).toBe('shake');
      expect(svg().classList).toContain('shaking');

      const motion = fixture.nativeElement.querySelector('.motion') as SVGGElement;
      motion.dispatchEvent(new Event('animationend'));
      expect(component.body()).toBe('still');
    });

    it('blinks once as the squeezed eyes open again', () => {
      create(NO_DELAY, SHAKE);
      fixture.detectChanges();
      tick();
      expect(component.blinks()).toBe(0);

      (fixture.nativeElement.querySelector('.motion') as SVGGElement).dispatchEvent(
        new Event('animationend')
      );
      expect(component.blinks()).toBe(1);
    });

    it('ignores animations that end inside the body', () => {
      create(NO_DELAY, SHAKE);
      fixture.detectChanges();
      tick();

      for (const selector of ['.ear', '.eyes']) {
        const part = fixture.nativeElement.querySelector(selector) as SVGGElement;
        part.dispatchEvent(new Event('animationend', { bubbles: true }));
      }
      expect(component.body()).toBe('shake');
    });

    it('turns back to the front first', () => {
      create(NO_DELAY, TURN, 0.99, NO_BLINK);
      tick();
      expect(component.look()).toBe('up-right');

      now += 15000;
      answer(SHAKE);
      tick();

      expect(component.body()).toBe('shake');
      expect(component.look()).toBe('ahead');
    });

    it('does not happen twice within the cooldown; the mascot blinks instead', () => {
      create(NO_DELAY, SHAKE);
      tick();
      component.body.set('still');

      answer(SHAKE, SINGLE);
      tick();

      expect(component.body()).toBe('still');
      expect(component.blinks()).toBe(1);
    });

    it('happens again once the cooldown has passed', () => {
      create(NO_DELAY, SHAKE);
      tick();
      component.body.set('still');
      now += 15000;

      answer(SHAKE);
      tick();

      expect(component.body()).toBe('shake');
    });

    it('blocks any other action while it runs', () => {
      create(NO_DELAY, SHAKE);
      tick();

      answer(BLINK, SINGLE);
      tick();
      expect(component.blinks()).toBe(0);
    });
  });

  describe('blinking', () => {
    it('blinks once on a middle roll and opens the eyes when the animation ends', () => {
      create(NO_DELAY, BLINK, SINGLE);
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      expect(component.blinks()).toBe(1);
      expect(svg().classList).toContain('blinking');
      expect(svg().style.getPropertyValue('--blinks')).toBe('1');

      (fixture.nativeElement.querySelector('.eyes') as SVGGElement).dispatchEvent(
        new Event('animationend')
      );
      fixture.detectChanges();
      expect(component.blinks()).toBe(0);
      expect(svg().classList).not.toContain('blinking');
    });

    it('sometimes blinks twice in a row', () => {
      create(NO_DELAY, BLINK, DOUBLE);
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      expect(component.blinks()).toBe(2);
      expect(svg().style.getPropertyValue('--blinks')).toBe('2');
    });
  });

  describe('looking around', () => {
    it('turns to a direction other than the current one on a high roll', () => {
      create(NO_DELAY, TURN, 0, NO_BLINK);
      tick();
      expect(component.look()).toBe('left');

      answer(TURN, 0.99, NO_BLINK);
      tick();
      expect(component.look()).toBe('up-right');

      answer(TURN, 0, NO_BLINK);
      tick();
      expect(component.look()).toBe('ahead');

      answer(TURN, 0.3, NO_BLINK);
      tick();
      expect(component.look()).toBe('right');

      answer(TURN, 0.6, NO_BLINK);
      tick();
      expect(component.look()).toBe('up-left');
    });

    it('exposes the direction to the stylesheet', () => {
      create(NO_DELAY, TURN, 0.99, NO_BLINK);
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      expect(svg().getAttribute('data-look')).toBe('up-right');
    });

    it('sometimes blinks while turning', () => {
      create(NO_DELAY, TURN, 0, 0.2, SINGLE);
      tick();

      expect(component.look()).toBe('left');
      expect(component.blinks()).toBe(1);
    });

    it('keeps the eyes open on most turns', () => {
      create(NO_DELAY, TURN, 0, NO_BLINK);
      tick();

      expect(component.look()).toBe('left');
      expect(component.blinks()).toBe(0);
    });
  });

  describe('ear twitch', () => {
    it('twitches the left or the right ear and stops when its animation ends', () => {
      create(NO_DELAY, TWITCH, LEFT);
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      const ears = fixture.nativeElement.querySelectorAll('.ear') as NodeListOf<SVGGElement>;
      expect(component.twitch()).toBe('left');
      expect(ears[0].classList).toContain('twitching');
      expect(ears[1].classList).not.toContain('twitching');

      ears[0].dispatchEvent(new Event('animationend', { bubbles: true }));
      fixture.detectChanges();
      expect(component.twitch()).toBeNull();
      expect(ears[0].classList).not.toContain('twitching');
      expect(component.body()).toBe('still');

      answer(TWITCH, RIGHT);
      tick();
      fixture.detectChanges();
      expect(component.twitch()).toBe('right');
      expect(ears[1].classList).toContain('twitching');
    });
  });

  describe('hopping', () => {
    it('hops on the highest roll and lands when the body animation ends', () => {
      create(NO_DELAY, HOP);
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      expect(component.body()).toBe('hop');
      expect(svg().classList).toContain('hopping');
      expect(svg().classList).not.toContain('shaking');

      (fixture.nativeElement.querySelector('.motion') as SVGGElement).dispatchEvent(
        new Event('animationend')
      );
      expect(component.body()).toBe('still');
    });

    it('does not blink when it lands', () => {
      create(NO_DELAY, HOP);
      fixture.detectChanges();
      tick();

      (fixture.nativeElement.querySelector('.motion') as SVGGElement).dispatchEvent(
        new Event('animationend')
      );
      expect(component.blinks()).toBe(0);
    });

    it('blocks any other action while in the air', () => {
      create(NO_DELAY, HOP);
      tick();

      answer(BLINK, SINGLE);
      tick();
      expect(component.body()).toBe('hop');
      expect(component.blinks()).toBe(0);
    });
  });

  describe('pressing', () => {
    let capture: ReturnType<typeof vi.fn>;

    // jsdom has no pointer capture.
    beforeEach(() => {
      capture = vi.fn();
      Object.defineProperty(Element.prototype, 'setPointerCapture', {
        value: capture,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      delete (Element.prototype as Partial<Element>).setPointerCapture;
    });

    const bodyShape = (): SVGPathElement => fixture.nativeElement.querySelector('.body');
    const motion = (): SVGGElement => fixture.nativeElement.querySelector('.motion');
    const pointer = (type: string, target: Element = bodyShape()): void => {
      target.dispatchEvent(new Event(type, { bubbles: true }));
      fixture.detectChanges();
    };

    it('squashes while held and captures the pointer on the body', () => {
      create();
      fixture.detectChanges();
      pointer('pointerdown');

      expect(component.body()).toBe('pressed');
      expect(svg().classList).toContain('pressed');
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.contexts[0]).toBe(bodyShape());
    });

    it('bounces back on release, looks at the user and then stands still', () => {
      create(NO_DELAY, TURN, 0, NO_BLINK);
      fixture.detectChanges();
      tick();
      expect(component.look()).toBe('left');

      pointer('pointerdown');
      // A turned head stays turned while pressed.
      expect(component.look()).toBe('left');

      pointer('pointerup');
      expect(component.body()).toBe('bounce');
      expect(svg().classList).toContain('bouncing');
      expect(component.look()).toBe('ahead');

      motion().dispatchEvent(new Event('animationend'));
      expect(component.body()).toBe('still');
      expect(component.blinks()).toBe(0);
    });

    for (const type of ['pointercancel', 'lostpointercapture']) {
      it(`bounces back on ${type}`, () => {
        create();
        fixture.detectChanges();
        pointer('pointerdown');
        pointer(type);

        expect(component.body()).toBe('bounce');
      });
    }

    it('cancels a running blink and ear twitch', () => {
      create(NO_DELAY, BLINK, DOUBLE);
      fixture.detectChanges();
      tick();
      component.twitch.set('left');
      expect(component.blinks()).toBe(2);

      pointer('pointerdown');
      expect(component.blinks()).toBe(0);
      expect(component.twitch()).toBeNull();
    });

    it('waits for a shake or a hop to finish', () => {
      create(NO_DELAY, SHAKE);
      fixture.detectChanges();
      tick();
      pointer('pointerdown');
      expect(component.body()).toBe('shake');
      expect(capture).not.toHaveBeenCalled();

      component.body.set('hop');
      pointer('pointerdown');
      expect(component.body()).toBe('hop');
    });

    it('holds back the random actions while pressed', () => {
      create(NO_DELAY);
      fixture.detectChanges();
      pointer('pointerdown');

      answer(BLINK, SINGLE);
      tick();
      expect(component.blinks()).toBe(0);
      expect(component.body()).toBe('pressed');
    });

    it('ignores a release without a press', () => {
      create();
      fixture.detectChanges();
      pointer('pointerup');

      expect(component.body()).toBe('still');
    });

    it('keeps the long-press menu of touch screens away', () => {
      create();
      fixture.detectChanges();
      const event = new Event('contextmenu', { bubbles: true, cancelable: true });
      bodyShape().dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    });

    describe('held long', () => {
      /** Move the clock on to `ms` after the press, which happened at time 0 of the test. */
      let elapsed: number;
      const holdUntil = (ms: number): void => {
        vi.advanceTimersByTime(ms - elapsed);
        elapsed = ms;
        fixture.detectChanges();
      };
      const press = (): void => {
        create();
        fixture.detectChanges();
        pointer('pointerdown');
        elapsed = 0;
      };
      const lastHeart = (): SVGGElement =>
        fixture.nativeElement.querySelectorAll('.heart')[2] as SVGGElement;

      it('stays a plain press for the first moment', () => {
        press();
        holdUntil(699);

        expect(component.hold()).toBeNull();
        expect(svg().hasAttribute('data-hold')).toBe(false);
      });

      it('melts into a cuddle, then sends up hearts that clear when the last one fades', () => {
        press();
        holdUntil(700);
        expect(component.hold()).toBe('cuddle');
        expect(svg().getAttribute('data-hold')).toBe('cuddle');
        expect(component.hearts()).toBe(false);

        holdUntil(1600);
        expect(component.hearts()).toBe(true);
        expect(svg().classList).toContain('loving');

        lastHeart().dispatchEvent(new Event('animationend', { bubbles: true }));
        fixture.detectChanges();
        expect(component.hearts()).toBe(false);
        expect(svg().classList).not.toContain('loving');
        // A heart's animation does not end the press.
        expect(component.body()).toBe('pressed');
      });

      it('has had enough later and looks round one way and then the other', () => {
        press();
        holdUntil(4199);
        expect(component.hold()).toBe('cuddle');

        holdUntil(4200);
        expect(component.hold()).toBe('sated');
        expect(component.look()).toBe('left');

        holdUntil(4600);
        expect(component.look()).toBe('right');
      });

      it('glances away from the side it already faces', () => {
        create(NO_DELAY, TURN, 0, NO_BLINK);
        fixture.detectChanges();
        tick();
        expect(component.look()).toBe('left');

        pointer('pointerdown');
        vi.advanceTimersByTime(4200);
        expect(component.look()).toBe('right');
        vi.advanceTimersByTime(400);
        expect(component.look()).toBe('left');
      });

      it('squirms, then shakes itself free while still held', () => {
        press();
        holdUntil(5000);
        expect(component.hold()).toBe('squirm');
        // The squirm's own end does not let go.
        motion().dispatchEvent(new Event('animationend'));
        expect(component.body()).toBe('pressed');

        holdUntil(5900);
        expect(component.hold()).toBeNull();
        expect(component.body()).toBe('shake');
        expect(component.look()).toBe('ahead');

        // The press is over: lifting the finger later changes nothing.
        pointer('pointerup');
        expect(component.body()).toBe('shake');
      });

      it('starts the shake cooldown when it frees itself', () => {
        press();
        holdUntil(5900);
        motion().dispatchEvent(new Event('animationend'));
        expect(component.body()).toBe('still');
        expect(component.blinks()).toBe(1);
        component.blinks.set(0);

        // The next idle roll is a shake, which the cooldown turns into a blink.
        answer(SHAKE, SINGLE);
        holdUntil(7200);
        expect(component.body()).toBe('still');
        expect(component.blinks()).toBe(1);
      });

      it('bounces back happily when let go during the cuddle', () => {
        press();
        holdUntil(2000);
        pointer('pointerup');

        expect(component.hold()).toBeNull();
        expect(component.body()).toBe('bounce');
        // The hearts float on after the release.
        expect(component.hearts()).toBe(true);

        motion().dispatchEvent(new Event('animationend'));
        expect(component.body()).toBe('still');
      });

      for (const [moment, ms] of [
        ['it has had enough', 4300],
        ['it squirms', 5200],
      ] as const) {
        it(`shakes the cuddle off after the bounce when let go while ${moment}`, () => {
          press();
          holdUntil(ms);
          pointer('pointerup');
          expect(component.body()).toBe('bounce');
          expect(component.look()).toBe('ahead');

          motion().dispatchEvent(new Event('animationend'));
          expect(component.body()).toBe('shake');

          motion().dispatchEvent(new Event('animationend'));
          expect(component.body()).toBe('still');
          expect(component.blinks()).toBe(1);
        });
      }

      it('forgets the hold once let go', () => {
        press();
        holdUntil(500);
        pointer('pointerup');
        motion().dispatchEvent(new Event('animationend'));

        holdUntil(7000);
        expect(component.hold()).toBeNull();
        expect(component.hearts()).toBe(false);
      });

      it('only changes the face when the user prefers reduced motion', () => {
        reducedMotion = true;
        press();
        holdUntil(700);
        expect(component.hold()).toBe('cuddle');

        holdUntil(10000);
        expect(component.hold()).toBe('cuddle');
        expect(component.hearts()).toBe(false);
        expect(component.body()).toBe('pressed');

        pointer('pointerup');
        expect(component.body()).toBe('bounce');
        motion().dispatchEvent(new Event('animationend'));
        expect(component.body()).toBe('still');
      });

      it('stops when the window is hidden, and still lets go', () => {
        press();
        holdUntil(700);
        setHidden(true);
        holdUntil(7000);
        expect(component.hold()).toBe('cuddle');
        expect(component.body()).toBe('pressed');

        pointer('pointerup');
        expect(component.body()).toBe('bounce');
      });

      it('stops when destroyed', () => {
        press();
        fixture.destroy();
        vi.advanceTimersByTime(7000);

        expect(component.hold()).toBeNull();
        expect(component.body()).toBe('pressed');
      });
    });
  });

  // Timer counts would include Angular's own change-detection timers, so these tests watch what
  // the mascot does instead.
  describe('hidden window', () => {
    it('does nothing while hidden and starts again when shown', () => {
      hidden = true;
      create(NO_DELAY, SHAKE);
      vi.advanceTimersByTime(60000);
      expect(component.body()).toBe('still');

      setHidden(false);
      tick();
      expect(component.body()).toBe('shake');
    });

    it('stops the timer when the window is hidden', () => {
      create(NO_DELAY, SHAKE);
      setHidden(true);
      tick();

      expect(component.body()).toBe('still');
    });

    it('keeps a single timer when shown twice', () => {
      // A second timer would act again on the default answer 0, which is a shake.
      create(NO_DELAY, BLINK, SINGLE);
      setHidden(false);
      setHidden(false);
      tick();

      expect(component.blinks()).toBe(1);
      expect(component.body()).toBe('still');
    });

    it('stops listening when destroyed', () => {
      hidden = true;
      create(NO_DELAY, SHAKE);
      fixture.destroy();

      setHidden(false);
      tick();
      expect(component.body()).toBe('still');
    });
  });

  it('stays still when the user prefers reduced motion', () => {
    reducedMotion = true;
    create(NO_DELAY, SHAKE);
    tick();

    expect(component.body()).toBe('still');
  });

  it('stops its timer when destroyed', () => {
    create(NO_DELAY, SHAKE);
    fixture.destroy();
    tick();

    expect(component.body()).toBe('still');
  });
});
