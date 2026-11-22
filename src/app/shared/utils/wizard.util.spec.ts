import { describe, expect, it } from 'vitest';
import { OPERATION_TYPE_KEYS } from '@app/types';
import type { QuickRunInput } from '@app/types';
import { BASE_ICONS } from 'src/app/services/ui/constants/icon-registry';
import {
  WIZARD_GOALS,
  WIZARD_QUESTIONS,
  WizardAnswers,
  WizardGoalId,
  WizardPlan,
  WizardTargets,
  DAILY_CRON,
  HOURLY_CRON,
  MANUAL_SCHEDULE,
  effectiveSchedule,
  hasScheduleStep,
  DEFAULT_SHARE_PORT,
  humanDuration,
  humanSize,
  isValidSharePort,
  planDetails,
  portOfAddr,
  shareAddr,
  shareUrls,
  PREVIEW_KINDS,
  asDryRun,
  buildPreview,
  baseName,
  describeSetup,
  FLOW_DIRECTION,
  findSameSetup,
  shortPath,
  type SetupSource,
  buildPlanProfile,
  AUTOMATIC_DRIVE,
  buildPlanQuickRun,
  isDrivePath,
  desktopAppProvider,
  fsPath,
  getGoal,
  goalTone,
  incomingBytes,
  isLoopbackHost,
  nextQuestion,
  planAdvice,
  planEffects,
  previewCounts,
  recommendedOption,
  resolveDestination,
  resolvePlan,
  withoutResync,
} from './wizard.util';

const resolved = (goal: WizardGoalId, answers: WizardAnswers): WizardPlan => {
  const plan = resolvePlan(goal, answers);
  if (!plan) throw new Error(`no plan for ${goal}`);
  return plan;
};

const targets = (extra: Partial<WizardTargets> = {}): WizardTargets => ({
  remoteName: 'drive',
  remotePath: 'Docs',
  localPath: '/home/me/Docs',
  ...extra,
});

describe('wizard goals and questions', () => {
  it('only asks questions that exist, and some goals need none', () => {
    for (const goal of WIZARD_GOALS) {
      for (const q of goal.questions) expect(WIZARD_QUESTIONS[q].length).toBeGreaterThan(1);
    }
    expect(getGoal('devices').questions).toEqual([]);
    expect(resolvePlan('devices', {})?.operationType).toBe('bisync');
  });

  it('resolves every combination of answers to a plan with a known operation', () => {
    for (const goal of WIZARD_GOALS) {
      const combos = goal.questions.reduce<WizardAnswers[]>(
        (acc, q) => acc.flatMap(a => WIZARD_QUESTIONS[q].map(o => ({ ...a, [q]: o.id }))),
        [{}]
      );
      for (const answers of combos) {
        const plan = resolved(goal.id, answers);
        if (plan.operationType) expect(OPERATION_TYPE_KEYS.has(plan.operationType)).toBe(true);
        else expect(plan.flow).toBe('browse');
      }
    }
  });

  it('reaches every outcome by exactly one goal and answer', () => {
    const reached: string[] = [];
    for (const goal of WIZARD_GOALS) {
      const combos = goal.questions.reduce<WizardAnswers[]>(
        (acc, q) => acc.flatMap(a => WIZARD_QUESTIONS[q].map(o => ({ ...a, [q]: o.id }))),
        [{}]
      );
      for (const answers of combos) {
        const { operationType, flow, serveType } = resolved(goal.id, answers);
        reached.push([operationType, flow, serveType].join('|'));
      }
    }
    expect(reached.filter((outcome, i) => reached.indexOf(outcome) !== i)).toEqual([]);
  });

  it('throws for an unknown goal', () => {
    expect(() => getGoal('nope' as WizardGoalId)).toThrow();
  });

  it('asks the questions in order and ignores answers that are not options', () => {
    const backup = getGoal('backup');
    expect(nextQuestion(backup, {})).toBe('deleted');
    expect(nextQuestion(backup, { deleted: 'bogus' })).toBe('deleted');
    expect(nextQuestion(backup, { deleted: 'keep' })).toBeNull();
  });

  it('has no plan until every question is answered', () => {
    expect(resolvePlan('backup', {})).toBeNull();
    expect(resolvePlan('migrate', {})).toBeNull();
  });
});

describe('goalTone', () => {
  it('uses the colour role of the goal operation and dim for browsing', () => {
    expect(goalTone(getGoal('access'))).toBe('accent');
    expect(goalTone(getGoal('devices'))).toBe('purple');
    expect(goalTone(getGoal('migrate'))).toBe('orange');
    expect(goalTone(getGoal('explore'))).toBe('dim');
  });

  it('gives every goal a different icon', () => {
    const icons = WIZARD_GOALS.map(g => g.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('resolvePlan', () => {
  it('streams the cloud as a folder and keeps a two-way copy for several devices', () => {
    expect(resolved('access', {})).toMatchObject({
      operationType: 'mount',
      flow: 'stream',
      schedule: { ...MANUAL_SCHEDULE, startup: true },
      canPreview: false,
    });
    expect(resolved('devices', {})).toMatchObject({
      operationType: 'bisync',
      flow: 'twoWay',
      schedule: { ...MANUAL_SCHEDULE, watch: true, cron: HOURLY_CRON },
      firstRunResync: true,
      canPreview: true,
    });
  });

  it('copies a backup unless the user wants deletions mirrored', () => {
    expect(resolved('backup', { deleted: 'keep' })).toMatchObject({
      operationType: 'copy',
      schedule: { ...MANUAL_SCHEDULE, cron: DAILY_CRON },
    });
    expect(resolved('backup', { deleted: 'mirror' })).toMatchObject({
      operationType: 'sync',
      schedule: { ...MANUAL_SCHEDULE, cron: DAILY_CRON },
    });
  });

  it('maps a one-time download to a manual copy', () => {
    expect(resolved('download', {})).toMatchObject({
      operationType: 'copy',
      flow: 'download',
      schedule: MANUAL_SCHEDULE,
    });
  });

  it('copies or moves between clouds and needs a second remote', () => {
    expect(resolved('migrate', { keepOld: 'keep' })).toMatchObject({
      operationType: 'copy',
      needsSecondRemote: true,
      needsLocal: false,
    });
    expect(resolved('migrate', { keepOld: 'move' }).operationType).toBe('move');
  });

  it('shares a web page, a network folder or a TV, each as a different kind of share', () => {
    expect(resolved('share', { device: 'browser' })).toMatchObject({
      serveType: 'http',
      needsLocal: false,
    });
    expect(resolved('share', { device: 'folder' }).serveType).toBe('webdav');
    expect(resolved('share', { device: 'tv' }).serveType).toBe('dlna');
  });

  it('shares over DLNA for a TV and WebDAV otherwise', () => {
    expect(resolved('share', { device: 'tv' })).toMatchObject({
      serveType: 'dlna',
      needsLocal: false,
    });
    expect(resolved('share', { device: 'folder' }).serveType).toBe('webdav');
  });

  it('browses without an operation or checks a folder', () => {
    expect(resolved('explore', { explore: 'browse' }).operationType).toBeUndefined();
    expect(resolved('explore', { explore: 'compare' })).toMatchObject({
      operationType: 'check',
      needsLocal: true,
      canPreview: false,
    });
  });

  it('checks one cloud against another with the second remote, not a local folder', () => {
    expect(resolved('explore', { explore: 'compareClouds' })).toMatchObject({
      operationType: 'check',
      flow: 'cloudCompare',
      needsLocal: false,
      needsSecondRemote: true,
      canPreview: false,
    });
  });
});

describe('planEffects', () => {
  it('warns about deletions for a mirror but not for a copy', () => {
    const mirror = planEffects(resolved('backup', { deleted: 'mirror' }));
    expect(mirror.some(e => e.key === 'mirrorDelete' && e.tone === 'warn')).toBe(true);
    const copy = planEffects(resolved('backup', { deleted: 'keep' }));
    expect(copy.some(e => e.tone === 'warn')).toBe(false);
  });

  it('describes every goal', () => {
    for (const goal of WIZARD_GOALS) {
      const first = Object.fromEntries(goal.questions.map(q => [q, WIZARD_QUESTIONS[q][0].id]));
      expect(planEffects(resolved(goal.id, first)).length).toBeGreaterThan(0);
    }
  });
});

describe('registered icons', () => {
  it('only uses icons the icon registry knows, so none fails at runtime', () => {
    const answers = (goal: (typeof WIZARD_GOALS)[number]): WizardAnswers[] =>
      goal.questions.reduce<WizardAnswers[]>(
        (acc, q) => acc.flatMap(a => WIZARD_QUESTIONS[q].map(o => ({ ...a, [q]: o.id }))),
        [{}]
      );
    const icons = new Set<string>();
    for (const goal of WIZARD_GOALS) {
      icons.add(goal.icon);
      for (const q of goal.questions) WIZARD_QUESTIONS[q].forEach(o => icons.add(o.icon));
      for (const a of answers(goal))
        planEffects(resolved(goal.id, a)).forEach(e => icons.add(e.icon));
    }
    expect([...icons].filter(icon => !(icon in BASE_ICONS))).toEqual([]);
  });
});

describe('planAdvice', () => {
  const offline = resolved('devices', {});
  const stream = resolved('access', {});
  const upload = resolved('backup', { deleted: 'keep' });
  const GB = 1024 ** 3;

  it('gives no advice without measured numbers', () => {
    expect(planAdvice(offline, {})).toBeNull();
    expect(planAdvice(stream, { cloudUsed: 10 })).toBeNull();
    expect(planAdvice(upload, { localFolderSize: 5 })).toBeNull();
  });

  it('prefers the measured folder over the whole cloud', () => {
    expect(incomingBytes(offline, { cloudUsed: 100, remoteFolderSize: 5 })).toBe(5);
    expect(incomingBytes(offline, { cloudUsed: 100 })).toBe(100);
    expect(incomingBytes(upload, { cloudUsed: 100 })).toBeUndefined();
  });

  it('warns when an offline copy does not fit, is tight, or says it fits', () => {
    expect(planAdvice(offline, { cloudUsed: 80 * GB, localFree: 60 * GB })?.key).toBe(
      'tooBigForDisk'
    );
    expect(planAdvice(offline, { cloudUsed: 55 * GB, localFree: 60 * GB })?.key).toBe(
      'tightOnDisk'
    );
    expect(planAdvice(offline, { cloudUsed: 10 * GB, localFree: 60 * GB })).toEqual({
      key: 'fitsOnDisk',
      tone: 'safe',
      bytes: { size: 10 * GB, free: 60 * GB },
    });
  });

  it('praises streaming only when the cloud is larger than the free space', () => {
    expect(planAdvice(stream, { cloudUsed: 180 * GB, localFree: 60 * GB })?.key).toBe(
      'streamSavesSpace'
    );
    expect(planAdvice(stream, { cloudUsed: 1 * GB, localFree: 60 * GB })).toBeNull();
  });

  it('warns when a backup does not fit in the cloud', () => {
    expect(planAdvice(upload, { localFolderSize: 20, cloudFree: 10 })?.key).toBe('cloudTooFull');
    expect(planAdvice(upload, { localFolderSize: 5, cloudFree: 10 })).toBeNull();
  });
});

describe('recommendedOption', () => {
  it('recommends keeping files on the safety questions only', () => {
    expect(recommendedOption('deleted')).toBe('keep');
    expect(recommendedOption('keepOld')).toBe('keep');
    expect(recommendedOption('device')).toBe('folder');
    expect(recommendedOption('explore')).toBeUndefined();
  });
});

describe('desktopAppProvider', () => {
  it('names providers with a desktop app, case-insensitively', () => {
    expect(desktopAppProvider('drive')).toBe('Google Drive');
    expect(desktopAppProvider('OneDrive')).toBe('OneDrive');
    expect(desktopAppProvider('s3')).toBeUndefined();
    expect(desktopAppProvider(undefined)).toBeUndefined();
    expect(desktopAppProvider('')).toBeUndefined();
  });
});

describe('isDrivePath', () => {
  it('knows a drive letter and the automatic drive from a folder', () => {
    expect(isDrivePath('Z:')).toBe(true);
    expect(isDrivePath('z:\\')).toBe(true);
    expect(isDrivePath(AUTOMATIC_DRIVE)).toBe(true);
    expect(isDrivePath('C:\\Users\\me\\drive')).toBe(false);
    expect(isDrivePath('/home/me/drive')).toBe(false);
    expect(isDrivePath('')).toBe(false);
  });
});

describe('buildPlanQuickRun', () => {
  it('returns null for browsing and for a cloud-to-cloud copy without a target', () => {
    expect(
      buildPlanQuickRun(resolved('explore', { explore: 'browse' }), targets(), 'n')
    ).toBeNull();
    expect(buildPlanQuickRun(resolved('migrate', { keepOld: 'keep' }), targets(), 'n')).toBeNull();
  });

  it('mounts with the presets and starts with the app', () => {
    const run = buildPlanQuickRun(resolved('access', {}), targets(), 'm', {
      vfs: { vfs_cache_mode: 'full' },
      mount: { attr_timeout: '10s', mountType: 'mount' },
    });
    expect(run?.operationType).toBe('mount');
    expect(run?.config.app).toEqual({ autoStart: true });
    expect(run?.config.rclone).toEqual({
      fs: 'drive:Docs',
      mountPoint: '/home/me/Docs',
      attr_timeout: '10s',
      vfs: { vfs_cache_mode: 'full' },
    });
  });

  it('shows a Windows mount as a network drive or a disk, with the name the user gave it', () => {
    const win = (mountNetworkMode?: boolean, mountVolumeName?: string): unknown =>
      buildPlanQuickRun(
        resolved('access', {}),
        targets({ localPath: 'Z:', mountNetworkMode, mountVolumeName }),
        'm',
        { mount: { network_mode: true } }
      )?.config.rclone;
    expect(win(false, ' My cloud ')).toMatchObject({
      mountPoint: 'Z:',
      network_mode: false,
      volname: 'My cloud',
    });
    expect(win(true)).toMatchObject({ network_mode: true });
    // Left out, the OS preset decides and no name is made up.
    const preset = win() as Record<string, unknown>;
    expect(preset['network_mode']).toBe(true);
    expect(preset).not.toHaveProperty('volname');
  });

  it('mounts into the Android Files app with the SAF preset', () => {
    const run = buildPlanQuickRun(resolved('access', {}), targets(), 'm', {
      mount: { mountType: 'saf' },
    });
    expect(run?.config.rclone).toMatchObject({ mountPoint: 'saf://drive', mountType: 'saf' });
  });

  it('puts the local folder on the right side of each flow', () => {
    const upload = buildPlanQuickRun(resolved('backup', { deleted: 'keep' }), targets(), 'b');
    expect(upload?.config.rclone).toEqual({ srcFs: '/home/me/Docs', dstFs: 'drive:Docs' });

    const download = buildPlanQuickRun(resolved('download', {}), targets(), 'd');
    expect(download?.config.rclone).toEqual({ srcFs: 'drive:Docs', dstFs: '/home/me/Docs' });

    const check = buildPlanQuickRun(resolved('explore', { explore: 'compare' }), targets(), 'c');
    expect(check?.config.rclone).toEqual({ srcFs: '/home/me/Docs', dstFs: 'drive:Docs' });
  });

  it('checks between two clouds without a local folder', () => {
    const plan = resolved('explore', { explore: 'compareClouds' });
    const check = buildPlanQuickRun(
      plan,
      targets({ remotePath: 'a', targetRemote: 'box', targetPath: '/b' }),
      'c'
    );
    expect(check?.operationType).toBe('check');
    expect(check?.config.rclone).toEqual({ srcFs: 'drive:a', dstFs: 'box:b' });
    expect(buildPlanQuickRun(plan, targets({ targetRemote: undefined }), 'c')).toBeNull();
  });

  it('starts a two-way copy with resync and the schedule the plan starts with', () => {
    const run = buildPlanQuickRun(resolved('devices', {}), targets(), 't');
    expect(run?.config.rclone).toEqual({
      path1: '/home/me/Docs',
      path2: 'drive:Docs',
      resync: true,
    });
    expect(run?.config.app).toEqual({
      watchEnabled: true,
      cronEnabled: true,
      cronExpression: HOURLY_CRON,
    });
  });

  it('applies a schedule the user picked, any combination of the triggers', () => {
    const backup = resolved('backup', { deleted: 'keep' });
    const daily = buildPlanQuickRun(backup, targets(), 'd');
    expect(daily?.config.app).toEqual({ cronEnabled: true, cronExpression: DAILY_CRON });

    const all = buildPlanQuickRun(
      backup,
      targets(),
      'a',
      {},
      { startup: true, watch: true, cron: '0 8,20 * * *', watchDelay: 30, startupDelay: 15 }
    );
    expect(all?.config.app).toEqual({
      autoStart: true,
      autoStartDelay: 15,
      watchEnabled: true,
      watchDelay: 30,
      cronEnabled: true,
      cronExpression: '0 8,20 * * *',
    });

    // The defaults are left out, like the editor leaves them out.
    const defaults = buildPlanQuickRun(
      backup,
      targets(),
      'e',
      {},
      { ...MANUAL_SCHEDULE, watch: true, startup: true }
    );
    expect(defaults?.config.app).toEqual({ autoStart: true, watchEnabled: true });

    const manual = buildPlanQuickRun(backup, targets(), 'm', {}, MANUAL_SCHEDULE);
    expect(manual?.config.app).toEqual({});
  });

  it('copies between clouds into the target folder', () => {
    const run = buildPlanQuickRun(
      resolved('migrate', { keepOld: 'move' }),
      targets({ remotePath: '', targetRemote: 'onedrive', targetPath: '/from-drive' }),
      'm'
    );
    expect(run?.operationType).toBe('move');
    expect(run?.config.rclone).toEqual({ srcFs: 'drive:', dstFs: 'onedrive:from-drive' });
  });

  it('shares over the network with a login, a port and read-only access for WebDAV', () => {
    const webdav = buildPlanQuickRun(
      resolved('share', { device: 'folder' }),
      targets({ shareUser: 'me', sharePassword: 'secret' }),
      's'
    );
    expect(webdav?.config.rclone).toEqual({
      fs: 'drive:Docs',
      type: 'webdav',
      addr: shareAddr(DEFAULT_SHARE_PORT),
      user: 'me',
      pass: 'secret',
    });

    const custom = buildPlanQuickRun(
      resolved('share', { device: 'folder' }),
      targets({ shareUser: 'me', sharePassword: 'x', sharePort: 9090, shareReadOnly: true }),
      's'
    );
    expect(custom?.config.rclone).toMatchObject({ addr: ':9090', vfs: { read_only: true } });
    expect(webdav?.config.rclone['vfs']).toBeUndefined();
  });

  it('shares a web page with a login and a port, and never asks for read-only access', () => {
    const page = buildPlanQuickRun(
      resolved('share', { device: 'browser' }),
      targets({ shareUser: 'me', sharePassword: 'secret', sharePort: 9090, shareReadOnly: true }),
      's'
    );
    expect(page?.config.rclone).toEqual({
      fs: 'drive:Docs',
      type: 'http',
      addr: ':9090',
      user: 'me',
      pass: 'secret',
    });
  });

  it('names a DLNA share for the TV and sends no WebDAV options', () => {
    const plain = buildPlanQuickRun(resolved('share', { device: 'tv' }), targets(), 's');
    expect(plain?.config.rclone).toEqual({ fs: 'drive:Docs', type: 'dlna' });

    const named = buildPlanQuickRun(
      resolved('share', { device: 'tv' }),
      targets({ shareName: '  Living room  ', shareUser: 'me', sharePort: 9090 }),
      's'
    );
    expect(named?.config.rclone).toEqual({ fs: 'drive:Docs', type: 'dlna', name: 'Living room' });
  });
});

describe('sharing helpers', () => {
  it('accepts a port a normal user can bind', () => {
    for (const port of [1024, 8080, 65535]) expect(isValidSharePort(port)).toBe(true);
    for (const port of [0, 80, 1023, 65536, 80.5, NaN, -1])
      expect(isValidSharePort(port)).toBe(false);
  });

  it('reads the port of an address rclone reports', () => {
    expect(portOfAddr('[::]:8080')).toBe(8080);
    expect(portOfAddr('127.0.0.1:9090')).toBe(9090);
    expect(portOfAddr(':7879')).toBe(7879);
    expect(portOfAddr('no-port')).toBeUndefined();
    expect(portOfAddr(undefined)).toBeUndefined();
    expect(portOfAddr(':0')).toBeUndefined();
    expect(portOfAddr(':99999')).toBeUndefined();
  });

  it('builds the addresses to type: each network address, then the host name', () => {
    expect(shareUrls({ hostName: 'my-pc', addresses: ['192.168.1.20', '10.0.0.5'] }, 8080)).toEqual(
      ['http://192.168.1.20:8080', 'http://10.0.0.5:8080', 'http://my-pc:8080']
    );
    expect(shareUrls({ hostName: '  ', addresses: ['192.168.1.20'] }, 9090)).toEqual([
      'http://192.168.1.20:9090',
    ]);
    expect(shareUrls(null, 8080)).toEqual([]);
    expect(shareUrls({ addresses: [] }, 8080)).toEqual([]);
  });

  it('puts an IPv6 address in brackets and leaves names and IPv4 alone', () => {
    expect(shareUrls({ addresses: ['fd00::5', 'nas.example.com'] }, 8080)).toEqual([
      'http://[fd00::5]:8080',
      'http://nas.example.com:8080',
    ]);
  });

  it('knows the names only this machine can use', () => {
    for (const host of [
      'localhost',
      'LocalHost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
      ' localhost ',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      '192.168.1.5',
      'nas.local',
      'fd00::5',
      '1127.0.0.1',
      '127.0.0.1.example.com',
      '',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('writes sizes and durations the way a person reads them', () => {
    expect(humanSize('250G')).toBe('250 GB');
    expect(humanSize('10Gi')).toBe('10 GB');
    expect(humanSize('1.5T')).toBe('1.5 TB');
    expect(humanSize('off')).toBe('off');
    expect(humanSize(undefined)).toBeUndefined();
    expect(humanDuration('48h')).toBe('48 h');
    expect(humanDuration('15s')).toBe('15 s');
    expect(humanDuration('1h30m')).toBe('1h30m');
    expect(humanDuration(null)).toBeUndefined();
  });
});

describe('planDetails', () => {
  const mount = resolved('access', {});
  const share = resolved('share', { device: 'folder' });
  const tv = resolved('share', { device: 'tv' });
  const presets = {
    vfs: {
      vfs_cache_mode: 'full',
      vfs_cache_max_size: '250G',
      vfs_cache_max_age: '48h',
      vfs_write_back: '15s',
      vfs_cache_min_free_space: '10G',
    },
  };
  const keys = (details: ReturnType<typeof planDetails>): string[] => details.map(d => d.key);

  it('tells a mount how much disk its cache may take, how long a change waits and what stays free', () => {
    const details = planDetails(mount, { presets, targets: targets() });
    expect(keys(details)).toEqual(['cache', 'writeBack', 'minFree']);
    expect(details[0].params).toEqual({ size: '250 GB', age: '48 h' });
    expect(details[1].params).toEqual({ time: '15 s' });
    expect(details[2].params).toEqual({ size: '10 GB' });
  });

  it('says nothing about a cache the mount does not use', () => {
    expect(
      keys(planDetails(mount, { presets: { vfs: { vfs_cache_mode: 'off' } }, targets: targets() }))
    ).toEqual([]);
    expect(keys(planDetails(mount, { presets: {}, targets: targets() }))).toEqual([]);
  });

  it('lists every address, the port and the user; what devices may do is in the effects', () => {
    const details = planDetails(share, {
      presets: {},
      targets: targets({ shareUser: 'me', sharePort: 9090, shareReadOnly: true }),
      network: { hostName: 'my-pc', addresses: ['192.168.1.20'] },
    });
    expect(keys(details)).toEqual(['address', 'address', 'port', 'user']);
    expect(details[0]).toMatchObject({ value: 'http://192.168.1.20:9090', copy: true, code: true });
    expect(details[2].value).toBe('9090');
  });

  it('lists the same details for a web page', () => {
    const page = resolved('share', { device: 'browser' });
    const details = planDetails(page, {
      presets: {},
      targets: targets({ shareUser: 'me', shareReadOnly: false }),
      network: { addresses: ['192.168.1.20'] },
    });
    expect(keys(details)).toEqual(['address', 'port', 'user']);
  });

  it('shows the port alone when no address is known', () => {
    const details = planDetails(share, { presets: {}, targets: targets({ shareUser: 'me' }) });
    expect(keys(details)).toEqual(['addressUnknown', 'port', 'user']);
    expect(details[0].value).toBe(':8080');
  });

  it('says an address taken from a remote backend is the one the app uses', () => {
    const details = planDetails(share, {
      presets: {},
      targets: targets({ shareUser: 'me' }),
      network: { addresses: ['nas.example.com'], viaBackend: true },
    });
    expect(keys(details)).toEqual(['address', 'addressViaBackend', 'port', 'user']);
    expect(details[0].value).toBe('http://nas.example.com:8080');
  });

  it('names a DLNA share and shows nothing for the other flows', () => {
    expect(
      keys(planDetails(tv, { presets: {}, targets: targets({ shareName: 'Living room' }) }))
    ).toEqual(['tvName']);
    expect(keys(planDetails(tv, { presets: {}, targets: targets() }))).toEqual([]);
    expect(keys(planDetails(resolved('download', {}), { presets, targets: targets() }))).toEqual(
      []
    );
  });

  it('shows the read-only effect for a read-only share and the warning otherwise', () => {
    const readOnly = planEffects(share, { shareReadOnly: true }).map(e => e.key);
    expect(readOnly).toContain('shareReadOnly');
    expect(readOnly).not.toContain('shareWrite');
    expect(planEffects(share).map(e => e.key)).toContain('shareWrite');
  });
});

describe('schedule options', () => {
  it('offers each flow only the triggers that make sense', () => {
    expect(resolved('access', {}).scheduleOptions).toEqual({
      startup: true,
      watch: false,
      cron: false,
    });
    expect(resolved('backup', { deleted: 'keep' }).scheduleOptions).toEqual({
      startup: true,
      watch: true,
      cron: true,
    });
    // A download has no local source to watch.
    expect(resolved('download', {}).scheduleOptions.watch).toBe(false);
    expect(resolved('migrate', { keepOld: 'keep' }).scheduleOptions).toEqual({
      startup: false,
      watch: false,
      cron: false,
    });
  });

  it('has a "when" step only when something can run on its own', () => {
    expect(hasScheduleStep(resolved('backup', { deleted: 'keep' }))).toBe(true);
    expect(hasScheduleStep(resolved('access', {}))).toBe(true);
    expect(hasScheduleStep(resolved('share', { device: 'tv' }))).toBe(false);
    expect(hasScheduleStep(resolved('explore', { explore: 'compare' }))).toBe(false);
  });

  it('drops the triggers a plan does not offer', () => {
    const everything = { ...MANUAL_SCHEDULE, startup: true, watch: true, cron: DAILY_CRON };
    expect(effectiveSchedule(resolved('download', {}), everything)).toEqual({
      ...everything,
      watch: false,
    });
    expect(effectiveSchedule(resolved('access', {}), everything)).toEqual({
      ...everything,
      watch: false,
      cron: null,
    });
    expect(effectiveSchedule(resolved('share', { device: 'tv' }), everything)).toEqual(
      MANUAL_SCHEDULE
    );
  });
});

describe('dry run helpers', () => {
  const run = buildPlanQuickRun(resolved('devices', {}), targets(), 'x');
  if (!run) throw new Error('no run');

  it('turns a run into a dry run without schedules and out of the tray', () => {
    const dry = asDryRun(run);
    expect(dry.config.app).toEqual({ showOnTray: false });
    expect(dry.config.rclone).toMatchObject({ dryRun: true, resync: true });
    expect(run.config.rclone['dryRun']).toBeUndefined();
  });

  it('asks a sync, copy or move for the file report and no other operation', () => {
    for (const operationType of ['sync', 'copy', 'move'] as const) {
      expect(asDryRun({ ...run, operationType }).config.rclone['combined']).toBe(true);
    }
    expect(asDryRun(run).config.rclone['combined']).toBeUndefined();
  });

  it('drops resync once the listings exist and leaves the rest alone', () => {
    const kept = withoutResync(run.config);
    expect(kept.rclone['resync']).toBeUndefined();
    expect(kept.rclone['path1']).toBe('/home/me/Docs');
    expect(run.config.rclone['resync']).toBe(true);
  });

  it('reads the counts of a dry run, with zero for missing stats', () => {
    expect(previewCounts({ transfers: 3, bytes: 10, deletes: 1, errors: 0 })).toEqual({
      transfers: 3,
      bytes: 10,
      deletes: 1,
      errors: 0,
    });
    expect(previewCounts({})).toEqual({ transfers: 0, bytes: 0, deletes: 0, errors: 0 });
  });
});

describe('buildPreview', () => {
  const stats = { transfers: 3, bytes: 300, deletes: 1, errors: 0 };
  const report = {
    combined: [
      '+ new/a.txt',
      '+ b.txt',
      '* changed.doc',
      '- only-in-cloud.txt',
      '= same1',
      '= same2',
      '! broken.bin',
    ],
  };
  const completed = [
    { name: 'new/a.txt', size: 100 },
    { name: 'b.txt', size: 200 },
  ] as never;
  const byKind = (
    result: ReturnType<typeof buildPreview>,
    kind: string
  ): ReturnType<typeof buildPreview>['groups'][number] | undefined =>
    result.groups.find(g => g.kind === kind);

  it('lists what a sync adds, replaces and deletes, with sizes', () => {
    const result = buildPreview('sync', { ...stats, completed }, report);
    expect(result.fileLevel).toBe(true);
    expect(result.matched).toBe(2);
    expect(byKind(result, 'add')?.files).toEqual([
      { path: 'new/a.txt', size: 100 },
      { path: 'b.txt', size: 200 },
    ]);
    expect(byKind(result, 'add')?.bytes).toBe(300);
    expect(byKind(result, 'replace')?.files.map(f => f.path)).toEqual(['changed.doc']);
    expect(byKind(result, 'delete')?.files.map(f => f.path)).toEqual(['only-in-cloud.txt']);
    expect(byKind(result, 'error')?.files.map(f => f.path)).toEqual(['broken.bin']);
    expect(byKind(result, 'untouched')).toBeUndefined();
  });

  it('never calls a file that only exists in the destination deleted for a copy or a move', () => {
    for (const op of ['copy', 'move'] as const) {
      const result = buildPreview(op, stats, report);
      expect(byKind(result, 'delete')).toBeUndefined();
      expect(byKind(result, 'untouched')?.files.map(f => f.path)).toEqual(['only-in-cloud.txt']);
    }
  });

  it('lists the groups in the order the user should look at them, deletions first', () => {
    const result = buildPreview('sync', stats, report);
    const order = result.groups.map(g => g.kind);
    expect(order).toEqual(PREVIEW_KINDS.filter(kind => order.includes(kind)));
    expect(order[0]).toBe('delete');
  });

  it('leaves the size out of a file rclone did not transfer', () => {
    const result = buildPreview('sync', stats, report);
    expect(byKind(result, 'replace')?.files[0].size).toBeUndefined();
    expect(byKind(result, 'replace')?.bytes).toBe(0);
  });

  it('says nothing changes when the report only has matching files', () => {
    const result = buildPreview('copy', { transfers: 0 }, { combined: ['= a', '= b'] });
    expect(result.groups).toEqual([]);
    expect(result.matched).toBe(2);
    expect(result.counts).toEqual({ transfers: 0, bytes: 0, deletes: 0, errors: 0 });
  });

  it('ignores report lines it does not know', () => {
    const result = buildPreview('sync', {}, { combined: ['? mystery', 'plain', '+ ok.txt'] });
    expect(result.groups.map(g => g.kind)).toEqual(['add']);
  });

  it('falls back to the transfers rclone counted when there is no report', () => {
    const result = buildPreview(
      'bisync',
      {
        transfers: 2,
        completed: [
          { name: 'a.txt', size: 5, checked: false, what: 'transferring', error: '' },
          { name: 'old.txt', size: 7, checked: true, what: 'deleting', error: '' },
          { name: 'bad.txt', size: 0, checked: false, error: 'denied' },
          { name: 'seen.txt', size: 1, checked: true, what: 'checking', error: '' },
        ] as never,
      },
      null
    );
    expect(result.fileLevel).toBe(true);
    expect(result.groups.map(g => [g.kind, g.files.map(f => f.path)])).toEqual([
      ['delete', ['old.txt']],
      ['copy', ['a.txt']],
      ['error', ['bad.txt']],
    ]);
  });

  it('keeps only the counts when rclone listed no files at all', () => {
    const result = buildPreview('bisync', { transfers: 4, deletes: 1 }, null);
    expect(result.fileLevel).toBe(false);
    expect(result.groups).toEqual([]);
    expect(result.counts.transfers).toBe(4);
  });
});

describe('path helpers', () => {
  it('builds rclone paths without a leading slash', () => {
    expect(fsPath('drive')).toBe('drive:');
    expect(fsPath('drive', '/a/b')).toBe('drive:a/b');
  });

  it('takes the last segment of local, Windows and remote paths', () => {
    expect(baseName('/home/me/Notes/')).toBe('Notes');
    expect(baseName('C:\\Users\\me\\Docs')).toBe('Docs');
    expect(baseName('C:')).toBe('C');
    expect(baseName('')).toBe('');
  });
});

describe('where the wizard keeps its setups', () => {
  it('uses the destination the settings name', () => {
    expect(resolveDestination('profile', 'flow')).toBe('profile');
    expect(resolveDestination('quick_run', 'main_menu')).toBe('quick_run');
  });

  it('follows the startup view when automatic or unknown', () => {
    expect(resolveDestination('auto', 'main_menu')).toBe('profile');
    expect(resolveDestination('auto', 'flow')).toBe('quick_run');
    expect(resolveDestination('auto', 'nautilus')).toBe('quick_run');
    expect(resolveDestination(undefined, undefined)).toBe('profile');
  });

  const quickRun = (over: Partial<QuickRunInput> = {}): QuickRunInput => ({
    name: 'Drive mount',
    operationType: 'mount',
    remoteName: 'drive',
    config: {
      app: { autoStart: true, showOnTray: true },
      rclone: { fs: 'drive:', mountPoint: '/m', vfs: { vfs_cache_mode: 'full' } },
    },
    ...over,
  });

  it('builds a profile with the schedule in app and the VFS options in a VFS profile', () => {
    expect(buildPlanProfile(quickRun())).toEqual({
      name: 'Drive mount',
      settings: {
        vfsConfigs: { 'Drive mount': { vfs_cache_mode: 'full' } },
        mountConfigs: {
          'Drive mount': {
            app: { autoStart: true, vfsProfile: 'Drive mount' },
            rclone: { fs: 'drive:', mountPoint: '/m' },
          },
        },
      },
    });
  });

  it('adds no VFS profile when there are no VFS options', () => {
    const input = quickRun({ config: { app: {}, rclone: { fs: 'drive:', mountPoint: '/m' } } });
    expect(Object.keys(buildPlanProfile(input)?.settings ?? {})).toEqual(['mountConfigs']);
  });

  it('keeps the profiles that exist and numbers a name that is taken', () => {
    const save = buildPlanProfile(quickRun(), {
      mountConfigs: { 'Drive mount': { rclone: {} }, 'Drive mount-2': { rclone: {} } },
      vfsConfigs: { 'Drive mount-3': { a: 1 } },
    });
    expect(save?.name).toBe('Drive mount-3');
    expect(Object.keys(save?.settings['mountConfigs'] ?? {})).toEqual([
      'Drive mount',
      'Drive mount-2',
      'Drive mount-3',
    ]);
    expect(Object.keys(save?.settings['vfsConfigs'] ?? {})).toEqual([
      'Drive mount-3',
      'Drive mount-3-2',
    ]);
    expect(save?.settings['mountConfigs']['Drive mount-3']).toMatchObject({
      app: { vfsProfile: 'Drive mount-3-2' },
    });
  });

  it('gives nothing for an operation without profiles', () => {
    expect(buildPlanProfile(quickRun({ operationType: 'nothing' as never }))).toBeNull();
  });
});

describe('describeSetup', () => {
  const remotes = ['drive', 'box'];
  const source = (operationType: string, rclone: Record<string, unknown>): SetupSource => ({
    kind: 'quick_run',
    id: 'qr-1',
    name: 'My setup',
    remoteName: 'drive',
    operationType: operationType as SetupSource['operationType'],
    config: { app: {}, rclone },
  });

  const signature = (operationType: string, rclone: Record<string, unknown>): string | undefined =>
    describeSetup(source(operationType, rclone), remotes)?.signature;

  it('reads a backup back as an upload', () => {
    const setup = describeSetup(
      source('copy', { srcFs: '/home/me/Docs', dstFs: 'drive:Backup/Docs' }),
      remotes
    );
    expect(setup).toMatchObject({
      key: 'quick_run:qr-1',
      name: 'My setup',
      remoteName: 'drive',
      operationType: 'copy',
      signature: 'upload|/home/me/Docs|drive|Backup/Docs||',
    });
    expect(signature('sync', { srcFs: '/a', dstFs: 'drive:' })).toBe('upload|/a|drive|||');
  });

  it('reads mounts, two-way folders and shares', () => {
    expect(signature('mount', { fs: 'drive:', mountPoint: '/mnt/d' })).toBe(
      'stream|/mnt/d|drive|||'
    );
    expect(signature('mount', { fs: 'drive:', mountPoint: 'saf://drive' })).toBe(
      'stream|saf://drive|drive|||'
    );
    expect(signature('bisync', { path1: 'drive:Notes', path2: '/home/me/Notes' })).toBe(
      'twoWay|/home/me/Notes|drive|Notes||'
    );
    expect(signature('bisync', { path1: '/home/me/Notes', path2: 'drive:Notes' })).toBe(
      'twoWay|/home/me/Notes|drive|Notes||'
    );
  });

  it('tells shares of different types apart', () => {
    expect(signature('serve', { fs: 'drive:', type: 'dlna' })).toBe('share||drive|||dlna');
    expect(signature('serve', { fs: 'drive:', type: 'http' })).toBe('share||drive|||http');
    expect(signature('serve', { fs: 'drive:', type: 'ftp' })).toBe('share||drive|||ftp');
  });

  it('reads downloads, comparisons and moves between clouds', () => {
    expect(signature('copy', { srcFs: 'drive:Pics', dstFs: '/home/me/Pics' })).toBe(
      'download|/home/me/Pics|drive|Pics||'
    );
    expect(signature('check', { srcFs: '/a', dstFs: 'drive:a' })).toBe('compare|/a|drive|a||');
    expect(signature('move', { srcFs: 'drive:', dstFs: 'box:old' })).toBe(
      'cloudToCloud||drive||box:old|'
    );
  });

  it('also reads what the full editor makes: other directions of a sync, move or check', () => {
    // The wizard makes only some of these; the others are told apart so that a plan is never
    // reported as already set up because of a setup that does something else.
    expect(signature('sync', { srcFs: 'drive:a', dstFs: '/local' })).toBe(
      'download|/local|drive|a||sync'
    );
    expect(signature('move', { srcFs: 'drive:a', dstFs: '/local' })).toBe(
      'download|/local|drive|a||move'
    );
    expect(signature('move', { srcFs: '/a', dstFs: 'drive:' })).toBe('upload|/a|drive|||move');
    expect(signature('sync', { srcFs: 'drive:', dstFs: 'box:mirror' })).toBe(
      'cloudToCloud||drive||box:mirror|sync'
    );
    expect(signature('check', { srcFs: 'drive:a', dstFs: 'box:b' })).toBe(
      'cloudCompare||drive|a|box:b|'
    );
  });

  it('leaves out what has no cloud or folder to name', () => {
    expect(describeSetup(source('copy', { srcFs: '', dstFs: 'drive:' }), remotes)).toBeNull();
    expect(describeSetup(source('sync', { srcFs: '/a', dstFs: '/b' }), remotes)).toBeNull();
    expect(describeSetup(source('serve', { fs: 'drive:', type: '' }), remotes)).toBeNull();
    expect(describeSetup(source('copy', { srcFs: '/a', dstFs: 'other:x' }), remotes)).toBeNull();
    expect(describeSetup({ ...source('copy', {}), config: null }, remotes)).toBeNull();
  });

  it('keys a profile by remote, operation and name', () => {
    const setup = describeSetup(
      { ...source('copy', { srcFs: '/a', dstFs: 'drive:a' }), kind: 'profile', id: undefined },
      remotes
    );
    expect(setup?.key).toBe('profile:drive:copy:My setup');
  });
});

describe('findSameSetup', () => {
  const remotes = ['drive', 'box'];
  const existing = describeSetup(
    {
      kind: 'quick_run',
      id: 'qr-1',
      name: 'Docs backup',
      remoteName: 'drive',
      operationType: 'copy',
      config: { rclone: { srcFs: '/home/me/Docs/', dstFs: 'drive:Docs' } },
    },
    remotes
  );
  const targets = { remoteName: 'drive', remotePath: '/Docs', localPath: '/home/me/Docs' };

  it('finds a backup of the same folders, whichever way it deletes', () => {
    const copy = resolvePlan('backup', { deleted: 'keep' });
    const mirror = resolvePlan('backup', { deleted: 'mirror' });
    if (!existing || !copy || !mirror) throw new Error('no setup');
    expect(findSameSetup([existing], copy, targets)).toBe(existing);
    expect(findSameSetup([existing], mirror, targets)).toBe(existing);
  });

  it('ignores the target fields of a goal that has no second cloud', () => {
    const copy = resolvePlan('backup', { deleted: 'keep' });
    if (!existing || !copy) throw new Error('no setup');
    expect(
      findSameSetup([existing], copy, { ...targets, targetRemote: 'box', targetPath: 'drive' })
    ).toBe(existing);
  });

  it('tells two copies between clouds apart by their target', () => {
    const migrate = resolvePlan('migrate', { keepOld: 'keep' });
    const between = describeSetup(
      {
        kind: 'quick_run',
        id: 'qr-2',
        name: 'Move',
        remoteName: 'drive',
        operationType: 'copy',
        config: { rclone: { srcFs: 'drive:', dstFs: 'box:old' } },
      },
      remotes
    );
    if (!migrate || !between) throw new Error('no setup');
    const same = { remoteName: 'drive', remotePath: '', localPath: '', targetRemote: 'box' };
    expect(findSameSetup([between], migrate, { ...same, targetPath: '/old/' })).toBe(between);
    expect(findSameSetup([between], migrate, { ...same, targetPath: 'new' })).toBeNull();
  });

  it('finds a saved check between two clouds, and not one with another cloud', () => {
    const plan = resolved('explore', { explore: 'compareClouds' });
    const saved = describeSetup(
      {
        kind: 'quick_run',
        id: 'qr-3',
        name: 'Check',
        remoteName: 'drive',
        operationType: 'check',
        config: { rclone: { srcFs: 'drive:a', dstFs: 'box:b' } },
      },
      remotes
    );
    if (!saved) throw new Error('no setup');
    const same = { remoteName: 'drive', remotePath: 'a', localPath: '', targetRemote: 'box' };
    expect(findSameSetup([saved], plan, { ...same, targetPath: 'b' })).toBe(saved);
    expect(
      findSameSetup([saved], plan, { ...same, targetRemote: 'onedrive', targetPath: 'b' })
    ).toBeNull();
  });

  it('does not call a mirrored download or a move to the cloud the same as a plan', () => {
    const download = resolvePlan('download', {});
    const backup = resolvePlan('backup', { deleted: 'keep' });
    const mirroredDownload = describeSetup(
      {
        kind: 'quick_run',
        id: 'qr-3',
        name: 'Mirror down',
        remoteName: 'drive',
        operationType: 'sync',
        config: { rclone: { srcFs: 'drive:Docs', dstFs: '/home/me/Docs' } },
      },
      remotes
    );
    const moved = describeSetup(
      {
        kind: 'quick_run',
        id: 'qr-4',
        name: 'Move up',
        remoteName: 'drive',
        operationType: 'move',
        config: { rclone: { srcFs: '/home/me/Docs', dstFs: 'drive:Docs' } },
      },
      remotes
    );
    if (!download || !backup || !mirroredDownload || !moved) throw new Error('no setup');
    expect(findSameSetup([mirroredDownload], download, targets)).toBeNull();
    expect(findSameSetup([moved], backup, targets)).toBeNull();
  });

  it('finds nothing for other folders, other goals or the file browser', () => {
    const copy = resolvePlan('backup', { deleted: 'keep' });
    const download = resolvePlan('download', {});
    const browse = resolvePlan('explore', { explore: 'browse' });
    if (!existing || !copy || !download || !browse) throw new Error('no setup');
    expect(findSameSetup([existing], copy, { ...targets, localPath: '/home/me/Other' })).toBeNull();
    expect(findSameSetup([existing], copy, { ...targets, remotePath: 'Other' })).toBeNull();
    expect(findSameSetup([existing], download, targets)).toBeNull();
    expect(findSameSetup([existing], browse, targets)).toBeNull();
    expect(findSameSetup([], copy, targets)).toBeNull();
  });
});

describe('FLOW_DIRECTION', () => {
  it('moves files toward the cloud for a backup, toward this computer for a download', () => {
    expect(FLOW_DIRECTION.upload).toBe('right');
    expect(FLOW_DIRECTION.download).toBe('left');
    expect(FLOW_DIRECTION.cloudToCloud).toBe('right');
  });

  it('broadcasts a share from this machine to the network', () => {
    expect(FLOW_DIRECTION.share).toBe('broadcast');
  });

  it('goes both ways for a two-way copy, is a link for a mount, and nowhere for a check', () => {
    expect(FLOW_DIRECTION.twoWay).toBe('both');
    expect(FLOW_DIRECTION.stream).toBe('link');
    expect(FLOW_DIRECTION.compare).toBe('none');
    expect(FLOW_DIRECTION.cloudCompare).toBe('none');
  });
});

describe('shortPath', () => {
  it('leaves a short path alone', () => {
    expect(shortPath('/home/me/Docs')).toBe('/home/me/Docs');
  });

  it('keeps the start and the last two folders, and drops the middle', () => {
    expect(shortPath('/home/hakan/rclone-manager/drive-7')).toBe('/home/…/rclone-manager/drive-7');
  });

  it('keeps only the last folder when two do not fit', () => {
    expect(shortPath('/home/hakan/Documents/Photos/2024/Holiday')).toBe('/home/…/2024/Holiday');
    expect(shortPath('/home/hakan/a-very-long-folder-name/another-very-long-folder-name')).toBe(
      '…/another-very-long-folder-name'
    );
  });

  it('writes Windows paths with backslashes', () => {
    expect(shortPath('C:\\Users\\hakan\\Documents\\Photos\\Holiday', 28)).toBe(
      'C:\\…\\Photos\\Holiday'
    );
  });

  it('cuts a path with too few folders at the end', () => {
    expect(shortPath('/a-folder-with-a-very-long-name-indeed', 20)).toBe('/a-folder-with-a-ve…');
  });
});
