import { describe, expect, it } from 'vitest';
import {
  buildProfileChanges,
  createProfileBaseline,
  ProfileCollection,
} from './profile-changes.utils';

const draftsFrom = (baseline: ProfileCollection): ProfileCollection =>
  Object.fromEntries(
    Object.entries(baseline).map(([type, profiles]) => [type, structuredClone(profiles)])
  );

describe('profile changes', () => {
  it.each([undefined, null, {}, { syncConfigs: [] }])(
    'does not persist automatically displayed defaults for %j',
    settings => {
      const baseline = createProfileBaseline(settings);
      const request = buildProfileChanges(draftsFrom(baseline), baseline);
      expect(request.settings).toEqual({});
      expect(baseline.sync).toEqual({});
    }
  );

  it('sends complete changed sections including their untouched sibling profiles', () => {
    const old = { rclone: { srcFs: '/old', dstFs: 'drive:' } };
    const baseline = createProfileBaseline({ syncConfigs: { Daily: old, Untouched: {} } });
    const drafts = draftsFrom(baseline);
    drafts.sync = { Daily: { rclone: { srcFs: '/new', dstFs: 'drive:' } }, Untouched: {} };
    const request = buildProfileChanges(drafts, baseline);
    expect(request.settings).toEqual({ syncConfigs: drafts.sync });
    expect(baseline.sync?.['Daily']).toEqual(old);
  });

  it('represents a rename as deletion and addition, including special characters', () => {
    const baseline = createProfileBaseline({
      filterConfigs: { 'Old, name': { include: ['*.txt'] } },
    });
    const drafts = draftsFrom(baseline);
    drafts.filter = { "New 'name'": { include: ['*.txt'] } };
    const request = buildProfileChanges(drafts, baseline);
    expect(request.settings).toEqual({ filterConfigs: drafts.filter });
  });

  it('retains deletion intent until the returned baseline is adopted', () => {
    const baseline = createProfileBaseline({ syncConfigs: { Daily: {} } });
    const drafts = draftsFrom(baseline);
    drafts.sync = {};
    const first = buildProfileChanges(drafts, baseline);
    expect(first.settings).toEqual({ syncConfigs: {} });
    expect(buildProfileChanges(drafts, baseline).settings).toEqual(first.settings);
    expect(buildProfileChanges(drafts, first.nextBaseline).settings).toEqual({});
  });

  it('treats the first edit of a displayed default as a new profile', () => {
    const baseline = createProfileBaseline(null);
    const drafts = draftsFrom(baseline);
    drafts.backend = { Default: { transfers: 2 } };
    const first = buildProfileChanges(drafts, baseline);
    expect(first.settings).toEqual({ backendConfigs: { Default: { transfers: 2 } } });
    drafts.backend = { Default: { transfers: 4 } };
    const second = buildProfileChanges(drafts, first.nextBaseline);
    expect(second.settings).toEqual({ backendConfigs: { Default: { transfers: 4 } } });
  });

  it('keeps absent sections absent after saving another section', () => {
    const baseline = createProfileBaseline({ syncConfigs: { Daily: {} } });
    const drafts = draftsFrom(baseline);
    drafts.sync = { Daily: { app: { autoStart: true } } };
    const first = buildProfileChanges(drafts, baseline);
    drafts.filter = { Default: { include: ['*.jpg'] } };
    const second = buildProfileChanges(drafts, first.nextBaseline);
    expect(second.settings).toEqual({ filterConfigs: drafts.filter });
  });

  it('saves an explicitly created empty Default and can delete a persisted empty Default', () => {
    const baseline = createProfileBaseline(null);
    const drafts = draftsFrom(baseline);
    drafts.filter = { Default: {} };
    const created = buildProfileChanges(drafts, baseline);
    expect(created.settings).toEqual({ filterConfigs: { Default: {} } });
    drafts.filter = {};
    const removed = buildProfileChanges(drafts, created.nextBaseline);
    expect(removed.settings).toEqual({ filterConfigs: {} });
  });

  it('isolates the baseline and submitted values from later draft mutations', () => {
    const initial = { syncConfigs: { Daily: { rclone: { srcFs: '/old' } } } };
    const baseline = createProfileBaseline(initial);
    initial.syncConfigs.Daily.rclone.srcFs = '/external';
    expect(baseline.sync?.['Daily']).toEqual({ rclone: { srcFs: '/old' } });
    const profile = { rclone: { srcFs: '/submitted' } };
    const drafts = draftsFrom(baseline);
    drafts.sync = { Daily: profile };
    const request = buildProfileChanges(drafts, baseline);
    profile.rclone.srcFs = '/later';
    expect(request.settings['syncConfigs']['Daily']).toEqual({ rclone: { srcFs: '/submitted' } });
    expect(request.nextBaseline.sync?.['Daily']).toEqual({
      rclone: { srcFs: '/submitted' },
    });
  });
});
