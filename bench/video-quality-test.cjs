const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'video-quality.js');
const STATE_UNSTARTED = -1;
const STATE_PLAYING = 1;
const STATE_BUFFERING = 3;

function boot({
  force = true, quality = 'small', levels = ['hd1080', 'small'], videoId = 'first',
  state = STATE_PLAYING, applies = true, throws = false
} = {}) {
  const events = [];
  const writes = [];
  const toasts = [];
  const timers = [];
  let pauses = 0;
  let handler;
  let onConfigChange;
  const player = {
    isConnected: true,
    getVideoData: () => ({ video_id: videoId }),
    getPlayerState: () => state,
    getPlaybackQuality: () => quality,
    getPlaybackQualityLabel: () => quality,
    getAvailableQualityLevels: () => levels,
    setPlaybackQualityRange: (...args) => {
      if (throws) throw new Error('player not ready');
      writes.push(args);
      if (applies) quality = args[0];
    },
    setPlaybackQuality: () => {},
    addEventListener: (_name, fn) => { handler = fn; },
    removeEventListener: () => {},
    pauseVideo: () => { pauses++; }, playVideo: () => {}
  };
  const source = fs.readFileSync(SRC, 'utf8')
    // Strip ESM syntax; the deps are injected as sandbox globals instead.
    .replace(/^import[^;]+;\s*$/gm, '')
    .replace(/^export (?=function|const|let|class)/gm, '');
  const context = {
    configRead: () => force,
    configAddChangeListener: (_key, fn) => { onConfigChange = fn; return () => {}; },
    configRemoveChangeListener: () => {}, showNotification: (msg) => toasts.push(msg),
    isWebOS25: () => false, sendKey: () => {}, REMOTE_KEYS: {},
    SELECTORS: { PLAYER_ID: 'player' }, isWatchPage: () => true,
    document: { getElementById: () => player },
    window: { addEventListener: () => {}, dispatchEvent: (e) => events.push(e.detail), localStorage: { getItem: () => null, setItem: () => {} } },
    CustomEvent: class { constructor(_name, opts) { this.detail = opts.detail; } },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {}, console
  };
  vm.runInNewContext(source + '\ninitVideoQuality();', context, { filename: 'video-quality.js' });
  return {
    events, writes, toasts,
    get pauses() { return pauses; },
    set: (opts) => {
      ({ quality = quality, levels = levels, applies = applies, throws = throws } = opts);
    },
    change(next = {}) {
      ({ videoId = videoId, state = state } = next);
      handler(state);
    },
    toggleForce(value) {
      force = value;
      onConfigChange({ detail: { newValue: value } });
    },
    flushTimers() { timers.splice(0).forEach(fn => fn()); }
  };
}

test('low quality is upgraded to the best available level', () => {
  const app = boot();
  assert.deepEqual(app.writes, [['hd1080', 'hd1080']]);
});

test('highest available quality is not needlessly upgraded', () => {
  const app = boot({ quality: 'hd1080', levels: ['hd1080', 'small'] });
  assert.equal(app.writes.length, 0);
  assert.equal(app.pauses, 0);
});

test('nothing is forced or marked done before quality levels load', () => {
  const app = boot({ levels: [] });
  assert.equal(app.writes.length, 0);
  assert.equal(app.pauses, 0);

  app.set({ levels: ['hd1080', 'small'] });
  app.change({ state: STATE_BUFFERING });
  assert.deepEqual(app.writes, [['hd1080', 'hd1080']]);
});

test('an auto-only level list is left alone', () => {
  const app = boot({ levels: ['auto'] });
  assert.equal(app.writes.length, 0);
  assert.equal(app.pauses, 0);
});

test('hd2880 counts as the best level when offered', () => {
  const maxed = boot({ quality: 'hd2880', levels: ['hd2880', 'hd2160', 'small'] });
  assert.equal(maxed.writes.length, 0);

  const below = boot({ quality: 'hd2160', levels: ['hd2880', 'hd2160', 'small'] });
  assert.deepEqual(below.writes, [['hd2880', 'hd2880']]);
});

test('buffering upgrades quietly, without pausing', () => {
  const app = boot({ state: STATE_UNSTARTED, levels: [] });
  app.set({ levels: ['hd1080', 'small'] });
  app.change({ state: STATE_BUFFERING });
  assert.deepEqual(app.writes, [['hd1080', 'hd1080']]);
  assert.equal(app.pauses, 0);

  app.change({ state: STATE_PLAYING });
  assert.equal(app.writes.length, 1);
  assert.equal(app.pauses, 0);
});

test('the upgrade toast only appears once the quality actually changed', () => {
  const moved = boot();
  moved.flushTimers();
  assert.deepEqual(moved.toasts, ['Video quality upgraded to hd1080']);

  const stuck = boot({ applies: false });
  stuck.flushTimers();
  assert.deepEqual(stuck.toasts, []);
});

test('a failed upgrade is retried on the next state change', () => {
  const app = boot({ state: STATE_BUFFERING, throws: true });
  assert.equal(app.writes.length, 0);

  app.set({ throws: false });
  app.change({ state: STATE_BUFFERING });
  assert.deepEqual(app.writes, [['hd1080', 'hd1080']]);
});

test('enabling forcing mid-video upgrades on the next buffering event', () => {
  const app = boot({ force: false, state: STATE_BUFFERING });
  app.change({ state: STATE_PLAYING });
  assert.equal(app.writes.length, 0);

  app.toggleForce(true);
  app.change({ state: STATE_BUFFERING });
  assert.deepEqual(app.writes, [['hd1080', 'hd1080']]);
  assert.equal(app.pauses, 0);
});

test('state events carry the current video id with quality forcing disabled', () => {
  const app = boot({ force: false });
  assert.equal(app.events[0].videoId, 'first');
  app.change({ videoId: 'second' });
  assert.equal(app.events[1].videoId, 'second');
});

test('state events carry the current video id when videos change with forcing enabled', () => {
  const app = boot();
  app.change({ videoId: 'second' });
  assert.equal(app.events[1].videoId, 'second');
});
