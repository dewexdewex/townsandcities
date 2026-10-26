(() => {
  'use strict';
  
  /* ------------------------------------------------------------------ config */
  const CFG = {
    titleMs: 6000,        // title sequence length
    creditsMs: 9000,      // credits length (music fades out across it)
    clipMin: 4,           // seconds
    clipMax: 12,
    fullLevel: 0.85,      // music level in titles / credits
    duckLevel: 0.2,       // music level under narration (voice is always dominant)
    voiceLevel: 1.0,
    minVideoSeconds: 30   // ignore very short or live videos
  };
  
  const $ = id => document.getElementById(id);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pickOne = a => a[Math.floor(Math.random() * a.length)];
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  
  const S = {
    stories: [], tracks: [], videos: [],
    queue: [], lastStory: null, lastTrack: null,
    paused: false, muted: false, master: 1,
    musicLevel: 0, phase: 'idle', skip: false, subsOn: true, subs: []
  };
  
  /* -------------------------------------------------------------------- data */
  async function loadList(path, key) {
    try {
      const r = await fetch(path + '?v=' + Date.now());
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j[key]) ? j[key] : [];
    } catch { return []; }
  }
  
  /* ------------------------------------------------------------------- audio */
  const voice = new Audio();
  const music = new Audio();
  voice.preload = music.preload = 'auto';
  music.loop = true;
  let ctx, voiceGain, musicGain;
  
  function initAudio() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    voiceGain = ctx.createGain();
    musicGain = ctx.createGain();
    ctx.createMediaElementSource(voice).connect(voiceGain).connect(ctx.destination);
    ctx.createMediaElementSource(music).connect(musicGain).connect(ctx.destination);
    applyMix(0);
  }
  
  function applyMix(ramp = 0.4) {
    if (!ctx) return;
    const m = S.muted ? 0 : S.master, t = ctx.currentTime, tc = Math.max(ramp / 3, 0.001);
    voiceGain.gain.cancelScheduledValues(t);
    voiceGain.gain.setTargetAtTime(m * CFG.voiceLevel, t, tc);
    musicGain.gain.cancelScheduledValues(t);
    musicGain.gain.setTargetAtTime(m * S.musicLevel, t, tc);
  }
  function setMusicLevel(level, ramp) { S.musicLevel = level; applyMix(ramp); }
  
  /* ------------------------------------------------------------------- timer */
  // Pause-aware wait. useSkip: resolves early when Next is pressed.
  function wait(ms, useSkip) {
    return new Promise(res => {
      let acc = 0, last = performance.now();
      const id = setInterval(() => {
        const n = performance.now();
        if (!S.paused) acc += n - last;
        last = n;
        if (acc >= ms || (useSkip && S.skip)) { clearInterval(id); res(); }
      }, 100);
    });
  }
  
  /* ------------------------------------------------------------------- video */
  let ytReady;
  function loadYT() {
    if (ytReady) return ytReady;
    ytReady = new Promise(res => {
      if (window.YT && YT.Player) return res();
      window.onYouTubeIframeAPIReady = res;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => res(); // offline: carry on without video
      document.head.appendChild(s);
    });
    return ytReady;
  }
  
  let lastVid = null;
  function pickVideoId() {
    const pool = S.videos.map(v => v.id);
    let id = pickOne(pool);
    if (pool.length > 1) while (id === lastVid) id = pickOne(pool);
    return (lastVid = id);
  }
  
  class Clip {
    constructor(playerDiv, wrapId) {
      this.wrap = $(wrapId);
      this.len = CFG.clipMin;
      this.ready = new Promise(r => { this._r = r; });
      this.yt = new YT.Player(playerDiv, {
        width: '100%', height: '100%',
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, iv_load_policy: 3, playsinline: 1, fs: 0, mute: 1, origin: location.origin },
        events: {
          onReady: () => { this.yt.mute(); this._r(); },
          onStateChange: e => this.onState && this.onState(e.data),
          onError: e => this.onError && this.onError(e.data)
        }
      });
    }
    // Cue a random video, pick random start + length, begin playing (hidden). Resolves true when playing.
    async prepare() {
      for (let i = 0; i < 8; i++) {
        try { await this._try(pickVideoId()); return true; } catch { /* try another */ }
      }
      return false;
    }
    _try(id) {
      clearTimeout(this._pt);   // cancel the pending "pause after fade-out" so it can't hit the new clip
      return new Promise((resolve, reject) => {
        let stage = 'cue';
        const fail = () => { clearTimeout(to); this.onState = this.onError = null; reject(new Error('x')); };
        const to = setTimeout(fail, 15000);
        this.onError = fail;
        this.onState = s => {
          if (stage === 'cue' && s === 5) {                  // CUED: duration now known
            const d = this.yt.getDuration();
            if (!d || d < CFG.minVideoSeconds) return fail();
            const len = rand(CFG.clipMin, CFG.clipMax);
            const lo = Math.min(8, d * 0.1), hi = Math.max(lo + 1, d - len - 5);
            this.len = len;
            stage = 'play';
            this.yt.loadVideoById({ videoId: id, startSeconds: rand(lo, hi) });
          } else if (stage === 'play' && s === 1) {            // PLAYING
            clearTimeout(to); this.onState = this.onError = null;
            if (S.paused) this.yt.pauseVideo();
            resolve();
          }
        };
        this.yt.mute();
        this.yt.cueVideoById(id);
      });
    }
    show() {
      this.wrap.classList.add('on');
      if (!S.paused) { try { this.yt.playVideo(); } catch {} }   // make sure a shown clip is actually playing
    }
    hide() {
      this.wrap.classList.remove('on');
      clearTimeout(this._pt);
      this._pt = setTimeout(() => { try { this.yt.pauseVideo(); } catch {} }, 1400);
    }
  }
  
  let clips = null, curClip = 0;
  async function startVideo() {
    if (!S.videos.length) return;
    await loadYT();
    if (!(window.YT && YT.Player)) return;
    const A = new Clip('ytA', 'clipA'), B = new Clip('ytB', 'clipB');
    clips = [A, B];
    await Promise.all([A.ready, B.ready]);
    (async function loop() {
      if (!(await A.prepare())) return;
      A.show(); curClip = 0;
      for (;;) {
        const c = clips[curClip], o = clips[1 - curClip];
        const prep = o.prepare();
        await wait(c.len * 1000, false);
        if (await prep) { o.show(); c.hide(); curClip = 1 - curClip; }
        else c.len = rand(CFG.clipMin, CFG.clipMax); // keep current clip a little longer
      }
    })();
  }
  
  /* --------------------------------------------------------------- subtitles */
  function buildSubs(story) {
    const text = (story.transcript || '').replace(/\s+/g, ' ').trim();
    const parts = text.match(/[^.!?…]+[.!?…]+["”’)]*\s*|[^.!?…]+$/g) || [];
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let acc = 0;
    S.subs = parts.map(p => { const a = acc / total; acc += p.length; return { from: a, text: p.trim() }; });
    $('subtitles').textContent = '';
  }
  let subIdx = -1;
  function updateSubs() {
    if (!S.subs.length) return;
    const d = voice.duration || S.curDuration || 1;
    const f = voice.currentTime / d;
    let i = 0;
    while (i + 1 < S.subs.length && S.subs[i + 1].from <= f) i++;
    if (i !== subIdx) { subIdx = i; $('subtitles').textContent = S.subs[i].text; }
  }
  voice.addEventListener('timeupdate', updateSubs);
  
  /* ------------------------------------------------------------------- views */
  function show(name) {
    S.phase = name;
    document.body.dataset.phase = name;
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === 'view-' + name);
  }
  
  function creditRow(label, ...vals) {
    const g = document.createElement('div'); g.className = 'grp';
    const dt = document.createElement('dt'); dt.textContent = label; g.appendChild(dt);
    vals.filter(Boolean).forEach((v, i) => { const dd = document.createElement('dd'); if (i) dd.className = 'small'; dd.textContent = v; g.appendChild(dd); });
    return g;
  }
  const year = d => { const y = d && new Date(d).getFullYear(); return y && !isNaN(y) ? '© ' + y : ''; };
  function fillCredits(story, track) {
    const l = $('creditsList'); l.textContent = '';
    l.appendChild(creditRow('Story', story.title, story.author && 'by ' + story.author, year(story.copyright)));
    if (track) l.appendChild(creditRow('Music', track.title, track.author && 'by ' + track.author, year(track.copyright)));
  }
  
  /* ----------------------------------------------------------------- chapter */
  function nextStory() {
    if (!S.queue.length) {
      S.queue = shuffle(S.stories);
      if (S.queue.length > 1 && S.queue[0] === S.lastStory) S.queue.push(S.queue.shift());
    }
    return (S.lastStory = S.queue.shift());
  }
  function nextTrack() {
    if (!S.tracks.length) return null;
    let t = pickOne(S.tracks);
    if (S.tracks.length > 1) while (t === S.lastTrack) t = pickOne(S.tracks);
    return (S.lastTrack = t);
  }
  
  function playVoice() {
    return new Promise(res => {
      let poll;
      const done = () => { clearInterval(poll); voice.onended = voice.onerror = null; res(); };
      voice.onended = done; voice.onerror = done;
      poll = setInterval(() => { if (S.skip) done(); }, 100);
      voice.currentTime = 0;
      if (!S.paused) voice.play().catch(done);
    });
  }
  
  async function runChapter(story) {
    S.skip = false; subIdx = -1; S.curDuration = story.duration;
    const track = nextTrack();
  
    voice.src = story.file; voice.load();
    if (track) { music.src = track.file; music.currentTime = 0; }
    buildSubs(story);
  
    // 1. Titles
    $('titleText').textContent = story.title;
    $('titleText').style.animation = 'none'; void $('titleText').offsetWidth; $('titleText').style.animation = '';
    show('title');
    setMusicLevel(0, 0.01);
    if (track && !S.paused) music.play().catch(() => {});
    setMusicLevel(CFG.fullLevel, 2);
    await wait(CFG.titleMs, true);
  
    // 2. Story
    if (!S.skip) {
      show('main');
      setMusicLevel(CFG.duckLevel, 2.5);
      await playVoice();
    }
    voice.pause();
  
    // 3. Credits
    if (!S.skip) {
      fillCredits(story, track);
      show('credits');
      setMusicLevel(CFG.fullLevel, 1.5);
      await wait(2000, true);
      if (!S.skip) setMusicLevel(0, Math.max(1, (CFG.creditsMs - 2000) / 1000));
      await wait(CFG.creditsMs - 2000, true);
    }
    if (S.skip) { setMusicLevel(0, 0.5); await wait(600, false); }
    music.pause();
  }
  
  async function run() {
    for (;;) {
      try { await runChapter(nextStory()); }
      catch (e) { console.error(e); await wait(2000, false); }
    }
  }
  
  /* ---------------------------------------------------------------- controls */
  function setPaused(p) {
    S.paused = p;
    $('playBtn').innerHTML = p ? '&#9654;' : '&#10074;&#10074;';
    $('playBtn').setAttribute('aria-label', p ? 'Play' : 'Pause');
    if (p) {
      voice.pause(); music.pause();
      if (clips) clips.forEach(c => { try { c.yt.pauseVideo(); } catch {} });
    } else {
      if (ctx && ctx.state === 'suspended') ctx.resume();
      if (music.src) music.play().catch(() => {});
      if (S.phase === 'main' && voice.src) voice.play().catch(() => {});
      if (clips) { try { clips[curClip].yt.playVideo(); } catch {} }
    }
  }
  function setMuted(m) {
    S.muted = m; applyMix(0.2);
    $('muteBtn').innerHTML = m || S.master === 0 ? '&#128263;' : '&#128266;';
  }
  
  $('playBtn').onclick = () => setPaused(!S.paused);
  $('nextBtn').onclick = () => { if (S.paused) setPaused(false); S.skip = true; };
  $('muteBtn').onclick = () => setMuted(!S.muted);
  $('volume').oninput = e => { S.master = +e.target.value; if (S.muted && S.master > 0) S.muted = false; setMuted(S.muted); };
  $('ccBtn').onclick = () => { S.subsOn = !S.subsOn; $('subtitles').classList.toggle('off', !S.subsOn); $('ccBtn').classList.toggle('on', S.subsOn); };
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); if (ctx) setPaused(!S.paused); }
    else if (e.key === 'n' || e.key === 'ArrowRight') $('nextBtn').click();
    else if (e.key === 'm') $('muteBtn').click();
  });
  
  // Fade controls out when idle
  let idleT;
  function wake() { const c = $('controls'); c.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => c.classList.add('idle'), 3500); }
  ['mousemove', 'touchstart', 'keydown', 'click'].forEach(ev => document.addEventListener(ev, wake, { passive: true }));
  
  /* -------------------------------------------------------------------- boot */
  (async function boot() {
    const [stories, tracks, videos] = await Promise.all([
      loadList('data/stories.json', 'stories'),
      loadList('data/tracks.json', 'tracks'),
      loadList('data/videos.json', 'videos')
    ]);
    S.stories = stories.filter(s => s.file);
    S.tracks = tracks.filter(t => t.file);
    S.videos = videos.filter(v => /^[A-Za-z0-9_-]{11}$/.test(v.id || ''));
  
    const msg = $('startMsg'), btn = $('beginBtn');
    if (!S.stories.length) { msg.textContent = 'No stories have been published yet.'; return; }
    msg.textContent = 'Narrated stories, with sound. Headphones recommended.';
    btn.disabled = false;
  
    btn.onclick = async () => {
      btn.disabled = true;
      initAudio();
      try { await ctx.resume(); } catch {}
      // Unlock both media elements inside this user gesture (needed on iOS/Android)
      const silent = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=';
      for (const a of [voice, music]) { a.src = silent; a.play().catch(() => {}); }
      try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch {}
      $('controls').classList.remove('hidden'); wake();
      startVideo();
      run();
    };
  })();
  
  })();