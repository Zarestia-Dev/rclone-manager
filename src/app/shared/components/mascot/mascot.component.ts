import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';

/** Shortest gap between two body shakes, so the mascot does not shiver all the time. */
const SHAKE_COOLDOWN_MS = 15000;

/** Where the mascot looks; the stylesheet reads it from data-look. */
type MascotLook = 'ahead' | 'left' | 'right' | 'up-left' | 'up-right';
const LOOK_DIRECTIONS: readonly MascotLook[] = ['ahead', 'left', 'right', 'up-left', 'up-right'];

/**
 * What the whole body is doing; a new action waits until it is still again. 'pressed' holds while
 * a pointer is down on Tia, 'bounce' is the spring back after it lets go.
 */
type MascotBodyMove = 'still' | 'shake' | 'hop' | 'pressed' | 'bounce';

/**
 * How Tia feels about a long press; the stylesheet reads it from data-hold. It melts into a cuddle,
 * has had enough, then squirms to get free.
 */
type MascotHoldMood = 'cuddle' | 'sated' | 'squirm';

type MascotHoldStep = MascotHoldMood | 'hearts' | 'glance' | 'escape';

/**
 * A long press, by milliseconds since it began. The hearts and the moment Tia has had enough are
 * far apart, so the cuddle and the wish to get away read as two separate moods.
 */
const HOLD_TIMELINE: readonly (readonly [number, MascotHoldStep])[] = [
  [700, 'cuddle'],
  [1600, 'hearts'],
  [4200, 'sated'],
  [4600, 'glance'],
  [5000, 'squirm'],
  [5900, 'escape'],
];

/**
 * Tia, the small decorative mascot: it blinks, turns its head, twitches an ear, hops, and now and
 * then shakes itself like a pet, which sends green wind round its body and throws off a few leaves.
 * Pressing it squashes it until the pointer lets go, and it springs back with a happy face. Held
 * longer, it melts into a cuddle and sends up a few hearts, then has had enough, squirms and shakes
 * itself free (see HOLD_TIMELINE).
 * Motion is plain CSS that runs only for an action; the component sets a few signals from one
 * timer chain, which stops while the window is hidden and does nothing when the user asks for
 * reduced motion.
 */
@Component({
  selector: 'app-mascot',
  templateUrl: './mascot.component.html',
  styleUrl: './mascot.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
})
export class MascotComponent {
  readonly look = signal<MascotLook>('ahead');
  /** Blinks the running blink animation plays in a row; 0 while the eyes are open. */
  readonly blinks = signal(0);
  /** The ear that twitches, if any. */
  readonly twitch = signal<'left' | 'right' | null>(null);
  readonly body = signal<MascotBodyMove>('still');
  /** The mood of a long press; null while not held long enough, and after it. */
  readonly hold = signal<MascotHoldMood | null>(null);
  /** The hearts of a cuddle are floating up; cleared when the last one has faded. */
  readonly hearts = signal(false);

  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** Let go after it had enough: shake the cuddle off once the bounce lands. */
  private shakeOff = false;
  /** performance.now() of the last shake; monotonic, so a clock change cannot block shakes. */
  private lastShake = -SHAKE_COOLDOWN_MS;

  constructor() {
    // A hidden window (in the tray, minimised) gets no timer wake-ups at all.
    const onVisibilityChange = (): void => {
      if (document.hidden) this.stop();
      else if (this.timer === undefined) this.schedule();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      this.stop();
    });
    if (!document.hidden) this.schedule();
  }

  /**
   * A press squashes Tia until the pointer lets go. It waits for a shake or hop to finish, and
   * cancels a running blink or ear twitch, which would otherwise replay after the press. Holding on
   * walks through HOLD_TIMELINE.
   */
  onPress(event: PointerEvent): void {
    if (this.body() !== 'still') return;
    // Keep receiving the release even if the pointer slides off the body.
    (event.target as Element).setPointerCapture(event.pointerId);
    this.blinks.set(0);
    this.twitch.set(null);
    this.body.set('pressed');
    this.holdFrom(0);
  }

  /**
   * Spring back and look at whoever pressed. Also runs when the browser cancels the press or the
   * capture is lost without a pointerup, so Tia never stays squashed. Let go after it had enough,
   * it shakes the cuddle off once it lands.
   */
  onRelease(): void {
    if (this.body() !== 'pressed') return;
    this.stopHold();
    const mood = this.hold();
    this.shakeOff = mood === 'sated' || mood === 'squirm';
    this.hold.set(null);
    this.look.set('ahead');
    this.body.set('bounce');
  }

  /**
   * The body animation ended; ignore animations that bubbled up from inside it, and the purr and
   * squirm of a press, which ends on the pointer instead.
   */
  onBodyEnd(event: AnimationEvent): void {
    if (event.target !== event.currentTarget || this.body() === 'pressed') return;
    if (this.body() === 'bounce' && this.shakeOff) {
      this.shakeOff = false;
      this.shake();
      return;
    }
    // The eyes were squeezed shut for the shake: blink the dizziness away as they open.
    if (this.body() === 'shake') this.blinks.set(1);
    this.body.set('still');
  }

  private schedule(): void {
    // Nothing to wake up for when the user asks for reduced motion; the next time the window is
    // shown the preference is read again.
    if (this.reducedMotion.matches) {
      this.timer = undefined;
      return;
    }
    this.timer = setTimeout(
      () => {
        this.act();
        this.schedule();
      },
      2400 + Math.random() * 3200
    );
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stopHold();
  }

  /**
   * Wait for the step at `index` of HOLD_TIMELINE. With reduced motion only the cuddle's face
   * changes: no hearts, no squirm and no shake.
   */
  private holdFrom(index: number): void {
    const [at, step] = HOLD_TIMELINE[index];
    const since = index === 0 ? 0 : HOLD_TIMELINE[index - 1][0];
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      this.holdStep(step);
      if (index + 1 < HOLD_TIMELINE.length && !this.reducedMotion.matches) {
        this.holdFrom(index + 1);
      }
    }, at - since);
  }

  private holdStep(step: MascotHoldStep): void {
    switch (step) {
      case 'hearts':
        this.hearts.set(true);
        break;
      // Had enough: look round for a way out, one side and then the other.
      case 'sated':
        this.hold.set(step);
        this.look.set(this.look().endsWith('left') ? 'right' : 'left');
        break;
      case 'glance':
        this.look.set(this.look() === 'left' ? 'right' : 'left');
        break;
      // The squirm ends unsquashed, where the shake starts.
      case 'escape':
        this.hold.set(null);
        this.shake();
        break;
      default:
        this.hold.set(step);
    }
  }

  private stopHold(): void {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
  }

  private shake(): void {
    this.lastShake = performance.now();
    this.look.set('ahead');
    this.body.set('shake');
  }

  private act(): void {
    if (this.reducedMotion.matches || this.body() !== 'still') return;

    const roll = Math.random();
    if (roll < 0.1 && performance.now() - this.lastShake >= SHAKE_COOLDOWN_MS) {
      this.shake();
    } else if (roll < 0.42) {
      this.blink();
    } else if (roll < 0.76) {
      const others = LOOK_DIRECTIONS.filter(direction => direction !== this.look());
      this.look.set(others[Math.floor(Math.random() * others.length)]);
      // Pets often blink as they turn their head.
      if (Math.random() < 0.35) this.blink();
    } else if (roll < 0.92) {
      this.twitch.set(Math.random() < 0.5 ? 'left' : 'right');
    } else {
      this.body.set('hop');
    }
  }

  /** One blink, or now and then two in a row. */
  private blink(): void {
    this.blinks.set(Math.random() < 0.25 ? 2 : 1);
  }
}
