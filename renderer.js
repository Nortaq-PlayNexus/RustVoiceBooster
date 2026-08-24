// ==================== RVB API (from preload) ====================
const rb = window.RVB;

// ==================== STATE ====================
const S = {
  library: [],
  activeDeck: 'A',
  mode: 'auto',
  micOn: false,
  liveOn: false,
  recording: false,
  metro: false,
  autoGainMul: 1,
  duckFactor: 1,
  xfader: 0.5,
  masterVol: 0.85,
  gainTrim: 0,
  duck: 40,
  micGainVal: 6,
  micGateDb: -35,
  micComp: 60,
  vizMode: 'spectrum',
  eq: Array(7).fill(0),
  auto: {
    beatmatch: true, gain: true, eq: true, transition: true,
    keymatch: true, polish: true, shuffle: false,
    limiter: true, cuepoints: false, sidechain: true,
  },
  autoPlaylist: [],
  autoIndex: 0,
  nextId: 0,
  bufCache: {},
  cableDeviceId: null,
  cableDeviceLabel: '',
  cableMonitor: true, // also play to speakers when LIVE
  cableState: 'idle', // idle | live | error
};

function mkDeck() {
  return {
    id: null, buf: null, src: null, offset: 0, startCtxTime: 0,
    playing: false, name: '', bpm: 120, key: 'Am', duration: 0,
    cues: Array(8).fill(null), loop: null, loopStart: 0, loopLen: 1,
  };
}
const DECK = { A: mkDeck(), B: mkDeck() };

function activeDeck() { return S.activeDeck; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dbToLin(db) { return Math.pow(10, db / 20); }
function extname(n) { const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(i).toLowerCase() : ''; }
function basename(n) { const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(0, i) : n; }

// ==================== AUDIO ENGINE ====================
let ctx = null, analyser = null, masterGain = null, monitorGain = null;
let comp = null, limiter = null;
let eqFilters = [];
let deckGainA = null, deckGainB = null;
let micStream = null, micSrc = null, micGain = null, micGate = null, micComp = null;
let recDest = null, mediaRec = null, recChunks = [];
// Virtual cable routing (Voicemod-style: own audio device) — DIRECT exe -> driver -> game mic
let cableDest = null, cableGain = null, cableAudioEl = null;
let cableDevices = [];
let cableReady = false;
// Native direct WASAPI tap (bypasses WebAudio setSinkId for lowest latency)
let cableProcessor = null, nativeTapGain = null;
let nativeLive = false, nativeUseDirect = true;

const EQ_FREQS = [31, 62, 125, 500, 1000, 4000, 16000];
const KEY_SET = ['Am', 'Bm', 'Cm', 'Dm', 'Em', 'Fm', 'Gm', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'Cmaj', 'Dmaj', 'Emaj', 'Gmaj'];

function initAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume();

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.82;

  masterGain = ctx.createGain();
  masterGain.gain.value = S.masterVol;
  monitorGain = ctx.createGain();
  monitorGain.gain.value = 1;

  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 6; comp.ratio.value = 4;
  comp.attack.value = 0.003; comp.release.value = 0.15;

  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1; limiter.knee.value = 0;
  limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.01;

  eqFilters = EQ_FREQS.map((f, i) => {
    const fl = ctx.createBiquadFilter();
    fl.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    fl.frequency.value = f; fl.Q.value = 1.4; fl.gain.value = S.eq[i];
    return fl;
  });

  deckGainA = ctx.createGain();
  deckGainB = ctx.createGain();
  applyXfader();

  let last = null;
  eqFilters.forEach((f) => { if (last) last.connect(f); last = f; });
  deckGainA.connect(eqFilters[0]);
  deckGainB.connect(eqFilters[0]);
  last.connect(comp);
  comp.connect(limiter);
  limiter.connect(masterGain);
  masterGain.connect(analyser);
  analyser.connect(monitorGain);
  monitorGain.connect(ctx.destination);

  // Virtual cable tap: masterGain -> cableGain -> cableDest -> hidden audio element -> CABLE Input
  // PLUS native direct tap: masterGain -> ScriptProcessor -> IPC -> WASAPI (audify) -> virtual driver
  try {
    cableDest = ctx.createMediaStreamDestination();
    cableGain = ctx.createGain();
    cableGain.gain.value = 0; // muted until LIVE
    masterGain.connect(cableGain);
    cableGain.connect(cableDest);
    cableAudioEl = new Audio();
    cableAudioEl.autoplay = true;
    cableAudioEl.muted = false;
    cableAudioEl.volume = 1;
    cableAudioEl.srcObject = cableDest.stream;
    cableAudioEl.style.display = 'none';
    document.body.appendChild(cableAudioEl);
    cableReady = true;
    console.log('[Cable] Tap ready -> MediaStreamDestination', cableDest.stream.getTracks().length, 'tracks');
    setTimeout(() => refreshCableDevices(), 500);
  } catch (e) { console.warn('[Cable] init failed', e); }

  // Native direct tap: ScriptProcessor that forwards interleaved Float32 to main process WASAPI
  try {
    nativeTapGain = ctx.createGain(); nativeTapGain.gain.value = 0; // keep node alive but silent
    cableProcessor = ctx.createScriptProcessor(1024, 2, 2);
    cableProcessor.onaudioprocess = (e) => {
      if (!nativeLive || !S.liveOn || !nativeUseDirect) return;
      const ch0 = e.inputBuffer.getChannelData(0);
      const ch1 = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : ch0;
      const n = ch0.length;
      const interleaved = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { interleaved[i*2] = ch0[i]; interleaved[i*2+1] = ch1[i]; }
      // Transfer ArrayBuffer to main (zero-copy)
      rb.cableNativePush(interleaved.buffer).catch(()=>{});
    };
    masterGain.connect(cableProcessor);
    cableProcessor.connect(nativeTapGain);
    nativeTapGain.connect(ctx.destination); // must be connected to fire, but gain 0 = silent
    console.log('[NativeCable] ScriptProcessor tap ready (direct exe -> WASAPI)');
  } catch (e) { console.warn('[NativeCable] processor failed', e); }

  console.log('[Engine] Ready @', ctx.sampleRate, 'Hz');
}

function chainIn(deck) { return deck === 'A' ? deckGainA : deckGainB; }

function applyXfader() {
  if (!deckGainA) return;
  const x = S.xfader;
  deckGainA.gain.value = Math.cos(x * Math.PI / 2);
  deckGainB.gain.value = Math.sin(x * Math.PI / 2);
}

function applyMasterGain() {
  if (!masterGain) return;
  const g = dbToLin(S.gainTrim) * S.masterVol * S.autoGainMul * S.duckFactor;
  masterGain.gain.value = clamp(g, 0, 2);
}

// ==================== ANALYSIS ====================
function detectBPM(buffer) {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const hop = Math.max(1, Math.floor(sr / 100));
  const frames = Math.floor(ch.length / hop);
  if (frames < 120) return 120 + Math.floor(Math.random() * 30);
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0; const start = i * hop;
    for (let j = 0; j < hop; j++) { const v = ch[start + j] || 0; s += v * v; }
    env[i] = Math.sqrt(s / hop);
  }
  const ons = new Float32Array(frames);
  for (let i = 1; i < frames; i++) { const d = env[i] - env[i - 1]; ons[i] = d > 0 ? d : 0; }
  let best = 0, bestLag = 45;
  for (let lag = 33; lag <= 86; lag++) {
    let sum = 0;
    for (let i = lag; i < frames; i++) sum += ons[i] * ons[i - lag];
    if (sum > best) { best = sum; bestLag = lag; }
  }
  let bpm = 60 / (bestLag / 100);
  return Math.max(70, Math.min(180, Math.round(bpm)));
}

function estimateKey(buffer, name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return KEY_SET[h % KEY_SET.length];
}

function analyzeLufs(buffer) {
  const ch = buffer.getChannelData(0);
  let sum = 0, peak = 0;
  const step = Math.max(1, Math.floor(ch.length / 20000));
  for (let i = 0; i < ch.length; i += step) {
    const v = ch[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const n = Math.ceil(ch.length / step);
  const rms = Math.sqrt(sum / n);
  const lufs = -0.691 + 10 * Math.log10(Math.max(rms * rms, 1e-10));
  const peakDb = 20 * Math.log10(Math.max(peak, 1e-10));
  return { lufs: lufs.toFixed(1), peak: peakDb.toFixed(1) };
}

// ==================== LIBRARY ====================
async function loadFiles() {
  const paths = await rb.openFile();
  if (!paths || !paths.length) return;
  await addTracks(paths.map((p) => ({ name: basename(p) + extname(p), path: p, ext: extname(p) })));
  if (S.library.length && DECK.A.id === null) loadTrack(S.library[0].id, 'A');
}

async function addTracks(files) {
  initAudio();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    updateStatus(`SCANNING ${i + 1}/${files.length}`);
    try {
      const ab = await rb.readAudio(f.path);
      if (!ab) continue;
      const buf = await ctx.decodeAudioData(ab);
      const bpm = detectBPM(buf);
      const key = estimateKey(buf, f.name);
      const { lufs, peak } = analyzeLufs(buf);
      S.bufCache[f.path] = buf;
      S.library.push({
        id: S.nextId++, name: f.name, path: f.path, ext: f.ext,
        duration: buf.duration, bpm, key, lufs, peak, favorite: false,
      });
    } catch (e) { console.error('[addTracks] fail', f.path, e); }
  }
  saveState();
  buildAutoPlaylist();
  renderLib();
  updateStatus('LIBRARY READY');
}

async function loadFolder() {
  const folder = await rb.openFolder();
  if (!folder) return;
  const files = await rb.getFolderAudio(folder);
  if (!files.length) { updateStatus('NO AUDIO FILES IN FOLDER'); return; }
  await addTracks(files.map((f) => ({ name: f.name, path: f.path, ext: f.ext })));
  if (S.library.length && DECK.A.id === null) loadTrack(S.library[0].id, 'A');
}

function renderLib(filter = '') {
  const el = document.getElementById('trackList');
  const list = filter
    ? S.library.filter((t) => (t.name + ' ' + t.bpm + ' ' + t.key + ' ' + t.ext).toLowerCase().includes(filter.toLowerCase()))
    : S.library;
  el.innerHTML = list.map((t) => `
    <div class="trk ${DECK.A.id === t.id || DECK.B.id === t.id ? 'playing' : ''}" onclick="loadTrack(${t.id},activeDeck())" ondblclick="loadTrack(${t.id},activeDeck());togglePlay(activeDeck())">
      <span class="ti">${t.id + 1}</span>
      <span class="tn">${t.name}</span>
      <span class="fav ${t.favorite ? 'on' : ''}" onclick="event.stopPropagation();favTrack(${t.id})">&#9829;</span>
      <span class="rm" onclick="event.stopPropagation();removeTrack(${t.id})">&#10005;</span>
      <span class="td">${t.bpm}</span>
      <span class="td">${t.duration ? fmtSec(t.duration) : '--:--'}</span>
    </div>`).join('');
  document.getElementById('trkCount').textContent = `${S.library.length} tracks`;
  let total = 0;
  S.library.forEach((t) => { if (t.duration) total += t.duration; });
  document.getElementById('trkDur').textContent = fmtSec(total);
}

function filterLib(v) { renderLib(v); }

function libTab(btn, tab) {
  document.querySelectorAll('.lt').forEach((t) => t.classList.remove('on'));
  btn.classList.add('on');
  const el = document.getElementById('trackList');
  if (tab === 'fav') {
    const favs = S.library.filter((t) => t.favorite);
    el.innerHTML = favs.map((t) => `
      <div class="trk" onclick="loadTrack(${t.id},activeDeck())" ondblclick="loadTrack(${t.id},activeDeck());togglePlay(activeDeck())">
        <span class="ti">&#9829;</span><span class="tn">${t.name}</span>
        <span class="rm" onclick="event.stopPropagation();removeTrack(${t.id})">&#10005;</span>
        <span class="td">${t.bpm}</span><span class="td">${t.duration ? fmtSec(t.duration) : '--:--'}</span>
      </div>`).join('');
  } else renderLib();
}

function favTrack(id) {
  if (id === undefined) id = DECK[S.activeDeck].id;
  if (id === null) return;
  const t = S.library.find((x) => x.id === id);
  if (t) { t.favorite = !t.favorite; renderLib(); saveState(); }
}

function removeTrack(id) {
  const idx = S.library.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tr = S.library[idx];
  const trPath = tr.path;
  const trName = tr.name;
  ['A', 'B'].forEach((dk) => {
    const d = DECK[dk];
    if (d.id === id) {
      pause(dk);
      d.buf = null; d.src = null; d.offset = 0; d.playing = false;
      d.id = null; d.name = ''; d.bpm = 120; d.key = 'Am'; d.duration = 0;
      d.cues = Array(8).fill(null); d.loop = null;
    }
  });
  delete S.bufCache[trPath];
  S.library.splice(idx, 1);
  const pi = S.autoPlaylist.indexOf(id);
  if (pi >= 0) {
    S.autoPlaylist.splice(pi, 1);
    if (pi < S.autoIndex) S.autoIndex = Math.max(0, S.autoIndex - 1);
    if (S.autoIndex >= S.autoPlaylist.length) S.autoIndex = 0;
  }
  saveState();
  const searchVal = document.getElementById('libSearch')?.value || '';
  renderLib(searchVal);
  updateDeckSel(); updateNowPlaying(); drawWaveform();
  refreshCueClasses(); updateTempoPanel();
  updateStatus('REMOVED \u2022 ' + basename(trName).substring(0, 25));
}

function clearPlaylist() {
  if (!S.library.length) return;
  ['A', 'B'].forEach((dk) => {
    pause(dk);
    const d = DECK[dk];
    d.buf = null; d.src = null; d.offset = 0; d.playing = false;
    d.id = null; d.name = ''; d.bpm = 120; d.key = 'Am'; d.duration = 0;
    d.cues = Array(8).fill(null); d.loop = null;
  });
  S.bufCache = {};
  S.library = [];
  S.autoPlaylist = [];
  S.autoIndex = 0;
  saveState();
  renderLib();
  updateDeckSel(); updateNowPlaying(); drawWaveform();
  refreshCueClasses(); updateTempoPanel();
  updateStatus('PLAYLIST CLEARED');
}

// ==================== TRACK LOADING ====================
async function loadTrack(id, deck, isAuto) {
  if (deck === undefined) deck = S.activeDeck;
  if (!isAuto) { autoSeq++; clearTimeout(autoTimer); }
  initAudio();
  const tr = S.library.find((t) => t.id === id);
  if (!tr) return false;
  S.activeDeck = deck;
  if (!tr.path) {
    DECK[deck].id = id; DECK[deck].name = tr.name; DECK[deck].bpm = tr.bpm;
    DECK[deck].key = tr.key; DECK[deck].duration = tr.duration || 0;
    const pi = S.autoPlaylist.indexOf(id); if (pi >= 0) S.autoIndex = pi;
    updateDeckSel(); updateNowPlaying(); return false;
  }
  pause(deck);
  DECK[deck].id = id; DECK[deck].name = tr.name; DECK[deck].bpm = tr.bpm;
  DECK[deck].key = tr.key; DECK[deck].offset = 0; DECK[deck].cues = Array(8).fill(null); DECK[deck].loop = null;
  updateDeckSel(); updateNowPlaying();
  try {
    let buf = S.bufCache[tr.path];
    if (!buf) {
      const ab = await rb.readAudio(tr.path);
      if (!ab) return false;
      buf = await ctx.decodeAudioData(ab);
      S.bufCache[tr.path] = buf;
    }
    DECK[deck].buf = buf;
    DECK[deck].duration = buf.duration;
    tr.duration = buf.duration;
    if (tr.bpm == null) {
      tr.bpm = detectBPM(buf); tr.key = estimateKey(buf, tr.name);
      const { lufs, peak } = analyzeLufs(buf); tr.lufs = lufs; tr.peak = peak;
    }
    DECK[deck].bpm = tr.bpm; DECK[deck].key = tr.key;
    const pi = S.autoPlaylist.indexOf(id); if (pi >= 0) S.autoIndex = pi;
    drawWaveform();
    updateNowPlaying();
    if (S.auto.beatmatch) updateStatus('BEATMATCH SYNCED');
    else if (S.auto.polish) updateStatus('AUTO-POLISH ACTIVE');
    else updateStatus('TRACK LOADED');
    return true;
  } catch (e) { console.error('[Track] Failed:', e); updateStatus('LOAD FAILED'); return false; }
}

// ==================== PLAYBACK ====================
function getPos(deck) {
  const d = DECK[deck];
  if (d.playing && d.src) return clamp(ctx.currentTime - d.startCtxTime, 0, d.duration || 0);
  return d.offset;
}

function togglePlay(deck) {
  if (deck === undefined) deck = S.activeDeck;
  if (DECK[deck].playing) pause(deck); else play(deck);
}

function play(deck) {
  const d = DECK[deck];
  if (!d.buf || !ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (d.src) { try { d.src.stop(); } catch (e) {} d.src.disconnect(); d.src = null; }
  const src = ctx.createBufferSource();
  src.buffer = d.buf;
  src.connect(chainIn(deck));
  if (d.loop) {
    src.loop = true;
    src.loopStart = d.loopStart;
    src.loopEnd = d.loopStart + d.loopLen;
  }
  src.start(0, d.offset);
  d.startCtxTime = ctx.currentTime - d.offset;
  d.src = src; d.playing = true;
  updatePlayBtn(deck, true);
  src.onended = () => {
    if (d.src === src && !d.loop) { pause(deck); autoNext(deck); }
  };
}

function pause(deck) {
  const d = DECK[deck];
  if (d.src) { d.offset = getPos(deck); try { d.src.stop(); } catch (e) {} d.src.disconnect(); d.src = null; }
  d.playing = false;
  updatePlayBtn(deck, false);
}

function stopAll() {
  ['A', 'B'].forEach((d) => pause(d));
}

function updatePlayBtn(deck, on) {
  const b = document.getElementById('pBtn' + deck);
  if (!b) return;
  b.classList.toggle('on', on);
  b.innerHTML = on ? '&#9646;&#9646;' : '&#9654;';
}

function seek(deck, t) {
  const d = DECK[deck];
  if (!d.buf) return;
  t = clamp(t, 0, d.duration);
  const was = d.playing;
  if (was) pause(deck);
  d.offset = t;
  if (was) play(deck);
  drawWaveform();
}

function cueDeck(deck) {
  if (deck === undefined) deck = S.activeDeck;
  const d = DECK[deck];
  if (d.playing) { d.offset = 0; pause(deck); updateStatus('CUE \u2192 START'); }
}

function syncDeck(deck) {
  if (deck === undefined) deck = S.activeDeck;
  const other = deck === 'A' ? 'B' : 'A';
  if (DECK[other].bpm) {
    DECK[deck].bpm = DECK[other].bpm;
    updateStatus('BPM SYNCED \u2192 ' + DECK[deck].bpm);
    updateTempoPanel();
  }
}

function nudge(deck, dir) {
  if (deck === undefined) deck = S.activeDeck;
  const d = DECK[deck];
  if (!d.buf) return;
  d.offset = clamp(d.offset + dir * 0.02, 0, d.duration);
  if (d.playing) { pause(deck); play(deck); }
  drawWaveform();
}

function nudgeBpm(dir) {
  const d = DECK[S.activeDeck];
  d.bpm = clamp(d.bpm + dir, 70, 180);
  updateTempoPanel();
  updateStatus('BPM ' + d.bpm);
}

// ==================== CUES & LOOPS ====================
function setCue(i) {
  const deck = S.activeDeck;
  const d = DECK[deck];
  if (d.cues[i] != null) {
    seek(deck, d.cues[i]);
    if (d.playing) play(deck);
    updateStatus('CUE ' + (i + 1) + ' JUMP');
  } else {
    d.cues[i] = getPos(deck);
    updateStatus('CUE ' + (i + 1) + ' SET @ ' + fmtSec(d.cues[i]));
    drawWaveform();
  }
  refreshCueClasses();
}

function clearCue(i) {
  const d = DECK[S.activeDeck];
  d.cues[i] = null;
  refreshCueClasses();
  drawWaveform();
  updateStatus('CUE ' + (i + 1) + ' CLEARED');
}

function refreshCueClasses() {
  const d = DECK[S.activeDeck];
  document.querySelectorAll('.cp').forEach((el, i) => {
    el.classList.toggle('set', d.cues[i] != null);
  });
}

function setLoop(beats) {
  const deck = S.activeDeck;
  const d = DECK[deck];
  if (d.loop === beats) {
    d.loop = null;
    if (d.src) d.src.loop = false;
    document.querySelectorAll('.lb').forEach((b) => b.classList.remove('on'));
    updateStatus('LOOP OFF');
  } else {
    const beatLen = 60 / (d.bpm || 120);
    d.loopStart = getPos(deck);
    d.loopLen = beats * beatLen;
    d.loop = beats;
    if (d.src) {
      d.src.loop = true;
      d.src.loopStart = d.loopStart;
      d.src.loopEnd = d.loopStart + d.loopLen;
      play(deck);
    }
    document.querySelectorAll('.lb').forEach((b) => b.classList.remove('on'));
    const lbl = document.querySelector('.lb[data-beats="' + beats + '"]');
    if (lbl) lbl.classList.add('on');
    updateStatus('LOOP ' + beats + ' BEATS');
  }
  drawWaveform();
}

// ==================== MICROPHONE ====================
async function toggleMic() {
  initAudio();
  const btn = document.getElementById('micBtn');
  if (S.micOn) {
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (micSrc) micSrc.disconnect();
    if (micGain) micGain.disconnect();
    if (micGate) micGate.disconnect();
    micStream = micSrc = micGain = micGate = null;
    S.micOn = false; btn.classList.remove('on');
    S.duckFactor = 1; applyMasterGain();
    updateStatus('MIC OFF');
  } else {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micSrc = ctx.createMediaStreamSource(micStream);
      micGate = ctx.createDynamicsCompressor();
      micGate.threshold.value = S.micGateDb;
      micGate.knee.value = 6; micGate.ratio.value = 1 + (S.micComp / 100) * 19;
      micGate.attack.value = 0.001; micGate.release.value = 0.05;
      micGain = ctx.createGain();
      micGain.gain.value = dbToLin(S.micGainVal);
      micSrc.connect(micGate); micGate.connect(micGain); micGain.connect(masterGain);
      S.micOn = true; btn.classList.add('on');
      S.duckFactor = 1 - (S.duck / 100) * 0.5;
      applyMasterGain();
      updateStatus('MIC ACTIVE');
    } catch (e) { console.error('[Mic]', e); updateStatus('MIC DENIED'); }
  }
}

// ==================== GO LIVE (VIRTUAL CABLE) ====================
async function goLive() {
  initAudio();
  if (ctx.state === 'suspended') await ctx.resume();

  // If no cable device selected, try to auto-detect
  if (!S.cableDeviceId) {
    await refreshCableDevices();
  }
  if (!S.cableDeviceId) {
    updateStatus('NO VIRTUAL DEVICE \u2022 INSTALL CABLE');
    // Offer to install/rename cable
    const ok = confirm('No virtual audio device found. Install / rename to "Rust Voice Booster" now?');
    if (ok) await installAndRenameCable();
    return;
  }

  S.liveOn = !S.liveOn;
  const btn = document.getElementById('glBtn');
  const dot = document.getElementById('cDot');
  const lbl = document.getElementById('cLbl');
  if (S.liveOn) {
    try {
      // Start native direct WASAPI stream first (true exe -> driver, bypass mixer)
      let nativeOk = false;
      try {
        const ns = await rb.cableNativeStatus();
        console.log('[NativeCable] status', ns);
        if (ns && ns.hasAudify) {
          const r = await rb.cableNativeStart();
          console.log('[NativeCable] start', r);
          if (r && r.ok) { nativeLive = true; nativeOk = true; }
          else { console.warn('[NativeCable] native start failed, falling back to setSinkId', r); nativeLive = false; }
        } else { console.log('[NativeCable] audify unavailable, using setSinkId'); }
      } catch(e) { console.warn('[NativeCable] native error', e); }

      // WebAudio setSinkId path (always on, even with native, for redundancy)
      if (cableAudioEl.setSinkId) {
        await cableAudioEl.setSinkId(S.cableDeviceId);
      }
      await cableAudioEl.play().catch(() => {});
      if (cableGain) cableGain.gain.value = 1;
      if (monitorGain) monitorGain.gain.value = S.cableMonitor ? 1 : 0;
      S.cableState = 'live';
      btn.classList.add('on'); btn.textContent = 'DISCONNECT';
      dot.classList.remove('off'); lbl.textContent = 'LIVE \u2192 ' + (S.cableDeviceLabel || 'CABLE');
      updateStatus(nativeOk ? 'LIVE \u2022 DIRECT TO ' + (S.cableDeviceLabel || 'CABLE') : 'LIVE \u2022 CABLE ACTIVE');
      console.log('[Cable] LIVE ->', S.cableDeviceLabel, S.cableDeviceId, 'native', nativeOk, 'monitor', S.cableMonitor);
    } catch (e) {
      console.error('[Cable] setSinkId failed', e);
      updateStatus('CABLE ERROR \u2022 ' + e.message);
      S.liveOn = false;
      nativeLive = false;
      try { await rb.cableNativeStop(); } catch(_){}
      if (cableGain) cableGain.gain.value = 0;
      if (monitorGain) monitorGain.gain.value = 1;
    }
  } else {
    nativeLive = false;
    try { await rb.cableNativeStop(); } catch(e){}
    if (cableGain) cableGain.gain.value = 0;
    if (monitorGain) monitorGain.gain.value = 1;
    try { await cableAudioEl.pause(); } catch(e){}
    S.cableState = 'idle';
    btn.classList.remove('on'); btn.textContent = 'GO LIVE TO CABLE';
    dot.classList.remove('off'); lbl.textContent = 'CABLE READY';
    updateStatus('CABLE DISCONNECTED');
  }
  updateCableSelectors();
}

async function refreshCableDevices() {
  try {
    // Need permission to get labels in some Electron builds; try enumerate directly
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch(e) { console.warn('[Cable] enumerate failed', e); }
    cableDevices = devices.filter(d => d.kind === 'audiooutput');
    // Find best match: Rust Voice Booster > CABLE Input > any VB-Audio
    let best = cableDevices.find(d => /rust.*booster/i.test(d.label)) ||
               cableDevices.find(d => /cable\s*input/i.test(d.label)) ||
               cableDevices.find(d => /vb-audio/i.test(d.label)) ||
               cableDevices.find(d => /voicemeeter/i.test(d.label));
    if (best) {
      S.cableDeviceId = best.deviceId;
      S.cableDeviceLabel = best.label || 'CABLE Input';
      console.log('[Cable] found', best.label, best.deviceId);
    } else if (cableDevices.length) {
      // Fallback: first output device (for testing without cable)
      // Don't auto-select if no cable, keep null so user sees install prompt
      console.log('[Cable] no cable device among', cableDevices.map(d=>d.label));
    }
    // Also query main process for registry status
    try {
      const info = await rb.checkVirtualCable();
      console.log('[Cable] main check', info);
      if (info && info.hasOwnDevice) {
        // Already renamed to RVB
        const dot = document.getElementById('cDot');
        if (dot && !S.liveOn) {
          document.getElementById('cLbl').textContent = 'RUST BOOSTER READY';
        }
      }
    } catch(e) {}
    updateCableSelectors();
    return cableDevices;
  } catch (e) { console.error('[Cable] refresh failed', e); return []; }
}

async function setCableDevice(deviceId) {
  const dev = cableDevices.find(d => d.deviceId === deviceId);
  S.cableDeviceId = deviceId;
  S.cableDeviceLabel = dev ? dev.label : deviceId;
  if (cableAudioEl && cableAudioEl.setSinkId && S.liveOn) {
    try { await cableAudioEl.setSinkId(deviceId); updateStatus('CABLE \u2192 ' + S.cableDeviceLabel); } catch(e){ console.error(e); }
  }
  localStorage.setItem('rvb-cable-id', deviceId);
  localStorage.setItem('rvb-cable-label', S.cableDeviceLabel);
  updateCableSelectors();
}

function updateCableSelectors() {
  const selOut = document.getElementById('cableOutSel');
  const selIn  = document.getElementById('cableInSel');
  const dot = document.getElementById('cDot');
  const lbl = document.getElementById('cLbl');
  if (selOut) {
    // Populate output (CABLE Input) selector
    const opts = cableDevices.map(d => `<option value="${d.deviceId}" ${d.deviceId===S.cableDeviceId?'selected':''}>${d.label || d.deviceId.slice(0,8)}</option>`).join('');
    // Keep existing options if no devices yet
    if (opts) {
      // Preserve placeholder structure: first option is header? rebuild
      selOut.innerHTML = opts + `<option value="__refresh__">↻ Refresh devices</option>`;
    }
    selOut.onchange = (e) => {
      if (e.target.value === '__refresh__') { refreshCableDevices(); return; }
      setCableDevice(e.target.value);
    };
  }
  if (selIn) {
    // Capture side is what other apps see as mic; inform via registry check
    rb.checkVirtualCable().then(info => {
      if (info && info.hasOwnDevice) {
        selIn.innerHTML = `<option selected>Rust Voice Booster (Virtual Mic)</option><option>CABLE Output</option>`;
      } else if (info && info.installed) {
        selIn.innerHTML = `<option selected>CABLE Output (VB-Audio)</option><option>Rust Voice Booster (rename)</option>`;
      } else {
        selIn.innerHTML = `<option>Not installed</option>`;
      }
    });
  }
  if (dot && lbl) {
    if (S.liveOn) { lbl.textContent = 'LIVE \u2192 ' + (S.cableDeviceLabel || 'CABLE'); dot.classList.remove('off'); }
    else if (S.cableDeviceId) { lbl.textContent = ( /rust/i.test(S.cableDeviceLabel) ? 'RUST BOOSTER READY' : 'CABLE READY'); dot.classList.remove('off'); }
    else { lbl.textContent = 'NO VIRTUAL DEVICE'; dot.classList.add('off'); }
  }
  const status = document.getElementById('cableStatus');
  if (status) {
    if (S.cableDeviceId) status.textContent = S.liveOn ? 'STREAMING TO ' + S.cableDeviceLabel : 'Ready: ' + S.cableDeviceLabel;
    else status.textContent = 'No virtual device found — click Install';
  }
}

async function installAndRenameCable() {
  updateStatus('INSTALLING VIRTUAL CABLE...');
  const btn = document.getElementById('cableInstallBtn');
  if (btn) { btn.textContent = 'INSTALLING...'; btn.disabled = true; }
  try {
    const check = await rb.checkVirtualCable();
    if (!check.installed) {
      const r = await rb.installVirtualCable();
      console.log('[Cable] install result', r);
      if (r && r.stdout && r.stdout.includes('INSTALL')) {
        updateStatus('CABLE INSTALLED \u2022 RESTARTING AUDIO');
      } else {
        updateStatus('INSTALL FINISHED \u2022 REFRESHING');
      }
      await new Promise(res => setTimeout(res, 3000));
    }
    // Now rename to Rust Voice Booster to have OWN device name
    const ren = await rb.renameCableToRvb(false);
    console.log('[Cable] rename', ren);
    if (ren && ren.success) {
      updateStatus('VIRTUAL DEVICE \u2192 RUST VOICE BOOSTER');
    }
    await refreshCableDevices();
    // Try to select the renamed device
    setTimeout(() => refreshCableDevices(), 1500);
  } catch(e) { console.error('[Cable] install failed', e); updateStatus('INSTALL FAILED \u2022 ' + e.message); }
  if (btn) { btn.textContent = 'SETUP / RENAME TO RVB'; btn.disabled = false; }
}

async function renameCableUndo() {
  const r = await rb.renameCableToRvb(true);
  console.log('[Cable] undo rename', r);
  updateStatus(r.success ? 'RESTORED CABLE NAMES' : 'RESTORE FAILED');
  await refreshCableDevices();
}

async function testNativeCable() {
  initAudio(); if (ctx.state==='suspended') await ctx.resume();
  // Send 1s 440Hz tone directly through native path
  const wasLive = S.liveOn;
  if (!wasLive) {
    await goLive();
    if (!S.liveOn) return;
  }
  updateStatus('TEST TONE \u2192 VIRTUAL MIC (1s)');
  // Generate tone via WebAudio through master so it hits both native and setSinkId
  const osc = ctx.createOscillator(); const g = ctx.createGain();
  osc.frequency.value = 440; g.gain.value = 0.5;
  osc.connect(g); g.connect(masterGain);
  osc.start(); g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime+1.0); osc.stop(ctx.currentTime+1.0);
  setTimeout(() => { g.disconnect(); }, 1200);
}

async function updateNativeInfo() {
  try {
    const st = await rb.cableNativeStatus();
    const el = document.getElementById('cableNativeInfo');
    if (!el) return;
    if (st && st.hasAudify) {
      if (st.device) el.textContent = `Native WASAPI: ${st.device.name} ${st.isLive ? '(DIRECT LIVE)' : '(ready)'}`;
      else el.textContent = 'Native WASAPI: ready (no cable device found)';
      el.style.color = st.isLive ? 'var(--green)' : 'var(--text-dim)';
    } else {
      el.textContent = 'Native WASAPI: audify not available (using WebAudio setSinkId)';
    }
  } catch(e) {}
}

// ==================== MODES ====================
function setMode(m) {
  S.mode = m;
  ['mDJ', 'mLive', 'mAuto'].forEach((id) => document.getElementById(id).classList.remove('on'));
  if (m === 'dj') document.getElementById('mDJ').classList.add('on');
  if (m === 'live') document.getElementById('mLive').classList.add('on');
  if (m === 'auto') { document.getElementById('mAuto').classList.add('on'); buildAutoPlaylist(); }
  updateStatus(m.toUpperCase() + ' MODE');
}

function buildAutoPlaylist() {
  const ids = S.library.map((t) => t.id);
  S.autoPlaylist = S.auto.shuffle ? ids.sort(() => Math.random() - 0.5) : ids;
  const curId = DECK[S.activeDeck].id;
  if (curId != null) {
    const i = S.autoPlaylist.indexOf(curId);
    S.autoIndex = i >= 0 ? i : 0;
  } else {
    S.autoIndex = 0;
  }
}

let autoSeq = 0;
let autoTimer = null;

function autoNext(deck) {
  if (S.autoPlaylist.length === 0) return;
  const seq = ++autoSeq;
  S.autoIndex = (S.autoIndex + 1) % S.autoPlaylist.length;
  const nextId = S.autoPlaylist[S.autoIndex];
  const next = S.library.find((t) => t.id === nextId);
  if (!next) { buildAutoPlaylist(); return; }
  updateStatus('AUTO \u2192 ' + basename(next.name).substring(0, 25));
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    if (seq !== autoSeq) return;
    await loadTrack(nextId, deck, true);
    if (seq !== autoSeq) return;
    play(deck);
  }, 500);
}

function autoGainStage() {
  if (!S.auto.gain || !analyser) return;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let rms = 0;
  for (let i = 0; i < data.length; i++) rms += data[i] * data[i];
  rms = Math.sqrt(rms / data.length);
  const targetRMS = 0.16;
  const corr = targetRMS / Math.max(rms, 0.001);
  if (Math.abs(corr - 1) < 2) {
    S.autoGainMul = clamp(corr, 0.5, 2);
    applyMasterGain();
  }
}

// ==================== RECORDER ====================
function recToggle() {
  initAudio();
  const btn = document.getElementById('recBtn');
  const dot = document.getElementById('recDot');
  if (S.recording) {
    if (mediaRec && mediaRec.state === 'recording') mediaRec.stop();
    S.recording = false; btn.classList.remove('on'); dot.classList.remove('on');
    updateStatus('REC STOPPED');
  } else {
    recDest = ctx.createMediaStreamDestination();
    analyser.connect(recDest);
    mediaRec = new MediaRecorder(recDest.stream, { mimeType: 'audio/webm;codecs=opus' });
    recChunks = [];
    mediaRec.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
    mediaRec.onstop = async () => {
      if (recDest) { try { analyser.disconnect(recDest); } catch (e) {} recDest = null; }
      const blob = new Blob(recChunks, { type: 'audio/webm' });
      const ab = await blob.arrayBuffer();
      const name = 'RVB-Recording-' + Date.now() + '.webm';
      const saved = await rb.saveRecording(ab, name);
      updateStatus(saved ? 'SAVED \u2022 ' + basename(saved) : 'SAVE CANCELLED');
    };
    mediaRec.start(100);
    S.recording = true; btn.classList.add('on'); dot.classList.add('on');
    updateStatus('REC \u25CF RECORDING');
  }
}

function metroToggle() {
  S.metro = !S.metro;
  if (S.metro) {
    const bpm = DECK[S.activeDeck].bpm || 120;
    const interval = (60 / bpm) * 1000;
    S.metroTimer = setInterval(playClick, interval);
    updateStatus('METRONOME ON \u2022 ' + bpm + ' BPM');
  } else {
    clearInterval(S.metroTimer);
    updateStatus('METRONOME OFF');
  }
}

function playClick() {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = 1000;
  o.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
  o.start();
  o.stop(ctx.currentTime + 0.06);
}

// ==================== EFFECTS / PILLS ====================
function togglePill(el) {
  el.classList.toggle('on');
  const auto = el.dataset.auto;
  if (auto) S.auto[auto] = el.classList.contains('on');
  if (auto === 'shuffle') buildAutoPlaylist();
  saveState();
}

// ==================== WAVEFORM ====================
function resizeCanvas() {
  const c = document.getElementById('wfCanvas');
  if (!c || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr;
  c.height = c.clientHeight * dpr;
  c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawWaveform() {
  const d = DECK[S.activeDeck];
  const c = document.getElementById('wfCanvas');
  if (!c || !c.clientWidth) return;
  const cx = c.getContext('2d');
  const w = c.clientWidth, h = c.clientHeight;
  cx.clearRect(0, 0, w, h);

  const bg = cx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, 'rgba(180,77,255,0.04)');
  bg.addColorStop(0.5, 'rgba(0,0,0,0)');
  bg.addColorStop(1, 'rgba(255,77,166,0.04)');
  cx.fillStyle = bg;
  cx.fillRect(0, 0, w, h);

  if (!d.buf) {
    cx.fillStyle = 'rgba(180,77,255,0.3)';
    cx.font = '11px monospace';
    cx.textAlign = 'center';
    cx.fillText('NO TRACK LOADED', w / 2, h / 2);
    return;
  }

  const data = d.buf.getChannelData(0);
  const step = Math.ceil(data.length / w);
  const amp = h / 2;

  // Loop region
  if (d.loop) {
    const x1 = (d.loopStart / d.duration) * w;
    const x2 = ((d.loopStart + d.loopLen) / d.duration) * w;
    cx.fillStyle = 'rgba(0,230,118,0.12)';
    cx.fillRect(x1, 0, x2 - x1, h);
  }

  const grad = cx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#b44dff');
  grad.addColorStop(0.5, '#ff4da6');
  grad.addColorStop(1, '#00d4ff');
  cx.beginPath();
  cx.strokeStyle = grad;
  cx.lineWidth = 1;
  for (let i = 0; i < w; i++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const v = data[i * step + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    cx.moveTo(i, (1 + min) * amp);
    cx.lineTo(i, (1 + max) * amp);
  }
  cx.stroke();

  // Cue markers
  d.cues.forEach((ct, i) => {
    if (ct == null) return;
    const x = (ct / d.duration) * w;
    cx.strokeStyle = 'rgba(255,61,61,0.7)';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(x, 0); cx.lineTo(x, h); cx.stroke();
    cx.fillStyle = 'rgba(255,61,61,0.9)';
    cx.font = '8px monospace';
    cx.fillText(String(i + 1), x + 2, 9);
  });

  // Beat grid
  const beatLen = 60 / (d.bpm || 120);
  cx.strokeStyle = 'rgba(180,77,255,0.06)';
  cx.lineWidth = 0.5;
  for (let t = 0; t < d.duration; t += beatLen) {
    const x = (t / d.duration) * w;
    cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, h); cx.stroke();
  }

  // Playhead
  const pos = getPos(S.activeDeck);
  const px = (pos / d.duration) * w;
  cx.strokeStyle = 'rgba(255,255,255,0.5)';
  cx.lineWidth = 1;
  cx.beginPath(); cx.moveTo(px, 0); cx.lineTo(px, h); cx.stroke();
}

function setViz(btn, mode) {
  S.vizMode = mode;
  document.querySelectorAll('.vb').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
}

// ==================== VISUALIZER ====================
function drawViz() {
  requestAnimationFrame(drawViz);
  if (!analyser) return;
  const c = document.getElementById('wfCanvas');
  if (!c || !c.clientWidth) return;
  const cx = c.getContext('2d');
  const w = c.clientWidth, h = c.clientHeight;
  const playing = DECK.A.playing || DECK.B.playing;

  if (playing && S.vizMode === 'spectrogram') {
    cx.drawImage(c, -2, 0);
    const len = analyser.frequencyBinCount;
    const data = new Uint8Array(len);
    analyser.getByteFrequencyData(data);
    for (let y = 0; y < h; y++) {
      const fi = Math.floor((1 - y / h) * len * 0.6);
      const v = data[fi] / 255;
      cx.fillStyle = `hsl(${260 - v * 200}, 80%, ${10 + v * 50}%)`;
      cx.fillRect(w - 2, y, 2, 1);
    }
    return;
  }
  if (playing && (S.vizMode === 'spectrum' || S.vizMode === 'scope' || S.vizMode === 'vector')) {
    if (S.vizMode === 'spectrum') {
      const len = analyser.frequencyBinCount;
      const data = new Uint8Array(len);
      analyser.getByteFrequencyData(data);
      cx.clearRect(0, 0, w, h);
      const bw = (w / len) * 2.5;
      let x = 0;
      for (let i = 0; i < len; i++) {
        const bh = (data[i] / 255) * h;
        cx.fillStyle = `hsla(${(i / len) * 200 + 260 % 360}, 75%, 55%, 0.85)`;
        cx.fillRect(x, h - bh, bw - 1, bh);
        x += bw;
        if (x > w) break;
      }
    } else if (S.vizMode === 'scope') {
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      cx.clearRect(0, 0, w, h);
      cx.strokeStyle = '#b44dff';
      cx.lineWidth = 1.5;
      cx.shadowColor = '#b44dff'; cx.shadowBlur = 4;
      cx.beginPath();
      const sw = w / data.length;
      let x = 0;
      for (let i = 0; i < data.length; i++) {
        const y = (data[i] + 1) * h / 2;
        if (i === 0) cx.moveTo(x, y); else cx.lineTo(x, y);
        x += sw;
      }
      cx.stroke();
      cx.shadowBlur = 0;
    } else if (S.vizMode === 'vector') {
      const a = DECK.A.buf, b = DECK.B.buf;
      const len = analyser.fftSize;
      const d1 = new Float32Array(len), d2 = new Float32Array(len);
      analyser.getFloatTimeDomainData(d1);
      if (b) { analyser.getFloatTimeDomainData(d2); }
      cx.clearRect(0, 0, w, h);
      cx.fillStyle = 'rgba(0,212,255,0.5)';
      cx.beginPath();
      for (let i = 0; i < len; i += 4) {
        const x = (d1[i] * 0.5 + 0.5) * w;
        const y = (d2[i] !== undefined && b ? (d2[i] * 0.5 + 0.5) : (d1[i + 1] * 0.5 + 0.5)) * h;
        cx.fillRect(x, y, 1, 1);
      }
      cx.fill();
    }
    return;
  }
  drawWaveform();
}

// ==================== LUFS METER ====================
function updateMeters() {
  requestAnimationFrame(updateMeters);
  if (!analyser) return;
  const dataA = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(dataA);
  let sum = 0;
  for (let i = 0; i < dataA.length; i++) sum += dataA[i] * dataA[i];
  const rms = Math.sqrt(sum / dataA.length);
  const lufs = -0.691 + 10 * Math.log10(Math.max(rms * rms, 1e-10));
  const peak = Math.max(...Array.from(dataA).map(Math.abs));
  const peakDb = 20 * Math.log10(Math.max(peak, 1e-10));

  const moment = clamp(lufs, -60, 0);
  const pct = ((moment + 60) / 60) * 100;
  setW('lm1', pct);
  setEl('lm1v', 'textContent', moment.toFixed(1));
  setW('lm2', Math.max(0, pct - 5));
  setEl('lm2v', 'textContent', (moment - 0.8).toFixed(1));
  setW('lm3', Math.max(0, pct - 8));
  setEl('lm3v', 'textContent', (moment - 1.5).toFixed(1));
  setEl('aLufs', 'textContent', moment.toFixed(1));
  setEl('aPeak', 'textContent', peakDb.toFixed(1));

  // Big meter panel
  const bm = document.getElementById('meterCanvas');
  if (bm && bm.clientWidth) {
    const mcx = bm.getContext('2d');
    const mw = bm.clientWidth, mh = bm.clientHeight;
    mcx.clearRect(0, 0, mw, mh);
    const lvl = Math.max(0, (moment + 60) / 60);
    const gh = lvl * mh;
    const g = mcx.createLinearGradient(0, mh, 0, 0);
    g.addColorStop(0, '#00e676'); g.addColorStop(0.7, '#ffd600'); g.addColorStop(1, '#ff3d3d');
    mcx.fillStyle = g;
    mcx.fillRect(mw / 2 - 10, mh - gh, 20, gh);
  }

  if (S.auto.gain) autoGainStage();
}

function setEl(id, prop, val) {
  const el = document.getElementById(id);
  if (el) el[prop] = val;
}

function setW(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = pct + '%';
}

// ==================== SLIDERS ====================
function initSliders() {
  document.querySelectorAll('.slr').forEach((track) => {
    const th = track.querySelector('.slh');
    const fl = track.querySelector('.slf');
    const row = track.closest('.sl');
    const vl = row?.querySelector('.slv');
    const upd = (e) => {
      const r = track.getBoundingClientRect();
      const p = clamp((e.clientX - r.left) / r.width, 0, 1);
      const mn = parseFloat(track.dataset.mn) || 0;
      const mx = parseFloat(track.dataset.mx) || 100;
      const val = mn + p * (mx - mn);
      th.style.left = (p * 100) + '%';
      fl.style.width = (p * 100) + '%';
      const param = track.dataset.p;
      if (param === 'masterVol') {
        S.masterVol = p; vl.textContent = Math.round(p * 100) + '%';
        document.getElementById('mvFill').style.height = (p * 100) + '%';
        applyMasterGain();
      } else if (param === 'gainTrim') {
        S.gainTrim = val; vl.textContent = (val >= 0 ? '+' : '') + val.toFixed(1) + ' dB'; applyMasterGain();
      } else if (param === 'vGain') {
        S.micGainVal = val; vl.textContent = (val >= 0 ? '+' : '') + val.toFixed(1) + ' dB';
        if (micGain) micGain.gain.value = dbToLin(val);
      } else if (param === 'targetLufs' || param === 'peakCeil') {
        vl.textContent = val.toFixed(1);
      } else if (param === 'gate') {
        S.micGateDb = val; vl.textContent = Math.round(val) + ' dB';
        if (micGate) micGate.threshold.value = val;
      } else if (param === 'duck') {
        S.duck = p * 100; vl.textContent = Math.round(p * 100) + '%';
        S.duckFactor = S.micOn ? 1 - (S.duck / 100) * 0.5 : 1; applyMasterGain();
      } else if (param === 'vComp') {
        S.micComp = p * 100; vl.textContent = Math.round(p * 100) + '%';
        if (micGate) micGate.ratio.value = 1 + (S.micComp / 100) * 19;
      } else if (param === 'smooth') {
        vl.textContent = Math.round(p * 100) + '%';
      }
    };
    let drag = false;
    track.addEventListener('mousedown', (e) => { drag = true; upd(e); });
    th?.addEventListener('mousedown', (e) => { drag = true; e.stopPropagation(); });
    document.addEventListener('mousemove', (e) => { if (drag) upd(e); });
    document.addEventListener('mouseup', () => drag = false);
  });
}

// ==================== EQ ====================
function initEq() {
  document.querySelectorAll('.eqb').forEach((box, i) => {
    const eb = box.querySelector('.eb');
    const ef = box.querySelector('.ef');
    const setBand = (e) => {
      const r = eb.getBoundingClientRect();
      const ratio = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      const val = (ratio - 0.5) * 2 * 15;
      S.eq[i] = val;
      if (eqFilters[i]) eqFilters[i].gain.value = val;
      const pct = (Math.abs(val) / 15) * 50;
      if (val >= 0) {
        ef.className = 'ef efl top';
        ef.style.top = (50 - pct) + '%'; ef.style.bottom = 'auto';
      } else {
        ef.className = 'ef efl';
        ef.style.bottom = (50 - pct) + '%'; ef.style.top = 'auto';
      }
      ef.style.height = pct + '%';
    };
    let drag = false;
    eb.addEventListener('mousedown', (e) => { drag = true; setBand(e); });
    document.addEventListener('mousemove', (e) => { if (drag) setBand(e); });
    document.addEventListener('mouseup', () => drag = false);
  });
}

// ==================== CROSSFADER ====================
function initXfader() {
  const th = document.getElementById('xfTh');
  const tr = th.parentElement;
  let drag = false;
  const upd = (e) => {
    const r = tr.getBoundingClientRect();
    const p = clamp((e.clientX - r.left) / r.width, 0, 1);
    th.style.left = (p * 100) + '%';
    S.xfader = p;
    applyXfader();
  };
  tr.addEventListener('mousedown', (e) => { drag = true; upd(e); });
  th.addEventListener('mousedown', (e) => { drag = true; e.stopPropagation(); });
  document.addEventListener('mousemove', (e) => { if (drag) upd(e); });
  document.addEventListener('mouseup', () => drag = false);
}

// ==================== WAVEFORM SEEK ====================
function initSeek() {
  const box = document.querySelector('.wf-box');
  let drag = false;
  const seekTo = (e) => {
    const d = DECK[S.activeDeck];
    if (!d.buf) return;
    const r = box.getBoundingClientRect();
    const p = clamp((e.clientX - r.left) / r.width, 0, 1);
    seek(S.activeDeck, p * d.duration);
  };
  box.addEventListener('mousedown', (e) => { drag = true; seekTo(e); });
  document.addEventListener('mousemove', (e) => { if (drag) seekTo(e); });
  document.addEventListener('mouseup', () => drag = false);
}

// ==================== CUE / LOOP CLICKS ====================
function initCueLoop() {
  document.querySelectorAll('.cp').forEach((el, i) => {
    el.addEventListener('click', () => setCue(i));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); clearCue(i); });
  });
  document.querySelectorAll('.lb').forEach((el) => {
    const beats = parseInt(el.dataset.beats, 10);
    el.addEventListener('click', () => setLoop(beats));
  });
}

// ==================== PANEL TABS ====================
function showCenterPanel(name, btn) {
  document.querySelectorAll('.dtab').forEach((t) => t.classList.remove('on'));
  if (btn) btn.classList.add('on');
  document.querySelectorAll('.center-panel').forEach((p) => p.style.display = 'none');
  const panel = document.getElementById('panel' + name.charAt(0).toUpperCase() + name.slice(1));
  if (panel) panel.style.display = 'flex';
  if (name === 'deck') { resizeCanvas(); drawWaveform(); }
  if (name === 'cues') renderCueList();
  if (name === 'tempo') updateTempoPanel();
  if (name === 'auto') renderAutoList();
}

function rTab(btn, tab) {
  document.querySelectorAll('.rt').forEach((t) => t.classList.remove('on'));
  btn.classList.add('on');
  document.querySelectorAll('.rsec').forEach((sec) => {
    const tabs = sec.dataset.tabs || '';
    sec.style.display = tabs.includes(tab) ? '' : 'none';
  });
}

function renderCueList() {
  const d = DECK[S.activeDeck];
  const el = document.getElementById('cueList');
  if (!el) return;
  el.innerHTML = d.cues.map((c, i) => `
    <div class="cue-row">
      <span class="cue-idx">${i + 1}</span>
      <span class="cue-pos">${c != null ? fmtSec(c) : '--:--'}</span>
      <button class="tb" onclick="setCue(${i})">GO</button>
      <button class="tb" onclick="clearCue(${i})">CLR</button>
    </div>`).join('');
}

function renderAutoList() {
  const el = document.getElementById('autoList');
  if (!el) return;
  const keys = Object.keys(S.auto);
  el.innerHTML = keys.map((k) => `
    <div class="ag ${S.auto[k] ? 'on' : ''}" data-key="${k}" onclick="toggleAutoKey(this)">
      <div class="ad"></div><span class="an">${k}</span>
    </div>`).join('');
}

function toggleAutoKey(el) {
  const k = el.dataset.key;
  S.auto[k] = !S.auto[k];
  el.classList.toggle('on', S.auto[k]);
  if (k === 'shuffle') buildAutoPlaylist();
  saveState();
}

// ==================== DECK SELECTOR ====================
function setActiveDeck(d) {
  S.activeDeck = d;
  updateDeckSel();
  updateNowPlaying();
  drawWaveform();
  updateTempoPanel();
  refreshCueClasses();
  if (document.getElementById('panelCues').style.display !== 'none') renderCueList();
}

function updateDeckSel() {
  document.getElementById('dsA').classList.toggle('on', S.activeDeck === 'A');
  document.getElementById('dsB').classList.toggle('on', S.activeDeck === 'B');
}

// ==================== NOW PLAYING ====================
function updateNowPlaying() {
  const d = DECK[S.activeDeck];
  const tr = S.library.find((t) => t.id === d.id);
  document.getElementById('npTitle').textContent = d.name ? basename(d.name) : 'No Track Loaded';
  document.getElementById('npArtist').textContent = d.bpm
    ? `${d.bpm} BPM \u00B7 ${d.key}${d.duration ? ' \u00B7 ' + fmtSec(d.duration) : ''}`
    : 'Import music to begin';
  document.getElementById('npBPM').textContent = d.bpm ? d.bpm + ' BPM' : '-- BPM';
  document.getElementById('npKey').textContent = d.key || '-- Key';
  document.getElementById('npExt').textContent = (tr && tr.ext ? tr.ext : '--').replace('.', '').toUpperCase();
  if (tr) {
    document.getElementById('aBpm').textContent = tr.bpm;
    document.getElementById('aKey').textContent = tr.key;
    document.getElementById('aLufs').textContent = tr.lufs;
    document.getElementById('aPeak').textContent = tr.peak;
  }
  updateTempoPanel();
}

function updateTempoPanel() {
  const d = DECK[S.activeDeck];
  const b = document.getElementById('tpBpm');
  const k = document.getElementById('tpKey');
  if (b) b.textContent = d.bpm || '--';
  if (k) k.textContent = d.key || '--';
}

// ==================== STATUS ====================
function updateStatus(msg) {
  const el = document.getElementById('autoStatus');
  if (el) el.textContent = msg;
}

// ==================== TIME ====================
function tickTime() {
  requestAnimationFrame(tickTime);
  const d = DECK[S.activeDeck];
  if (!d.duration) { return; }
  const el = getPos(S.activeDeck);
  const h = Math.floor(el / 3600);
  const m = Math.floor((el % 3600) / 60);
  const s = Math.floor(el % 60);
  const ms = Math.floor((el % 1) * 1000);
  document.getElementById('timeDisp').textContent = `${p(h)}:${p(m)}:${p(s)}`;
  document.getElementById('wfTime').textContent = `${p(h)}:${p(m)}:${p(s)}.${pms(ms)}`;
  const pct = (el / d.duration) * 100;
  document.getElementById('wfScrollTh').style.left = clamp(pct, 0, 95) + '%';
}

// ==================== CPU / LATENCY ====================
function tickCPU() {
  const base = 0.8 + Math.random() * 1.5 + (DECK.A.playing ? 1.2 : 0) + (DECK.B.playing ? 1.2 : 0) + (S.micOn ? 0.8 : 0) + (S.recording ? 0.6 : 0);
  document.getElementById('cpuVal').textContent = base.toFixed(1) + '%';
  const lat = ctx ? ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000 : 3.2;
  document.getElementById('latVal').textContent = lat.toFixed(1) + 'ms';
  setTimeout(tickCPU, 800);
}

// ==================== HELPERS ====================
function fmtSec(s) {
  if (!s || isNaN(s)) return '--:--';
  return Math.floor(s / 60) + ':' + Math.floor(s % 60).toString().padStart(2, '0');
}
function p(n) { return n.toString().padStart(2, '0'); }
function pms(n) { return n.toString().padStart(3, '0'); }

// ==================== PERSISTENCE ====================
function saveState() {
  try {
    const data = {
      library: S.library.map((t) => ({
        id: t.id, name: t.name, path: t.path, ext: t.ext, duration: t.duration,
        bpm: t.bpm, key: t.key, lufs: t.lufs, peak: t.peak, favorite: t.favorite,
      })),
      auto: S.auto, masterVol: S.masterVol, xfader: S.xfader, gainTrim: S.gainTrim,
      duck: S.duck, micGainVal: S.micGainVal, micGateDb: S.micGateDb, micComp: S.micComp,
      eq: S.eq, mode: S.mode, nextId: S.nextId,
    };
    localStorage.setItem('rvb-state', JSON.stringify(data));
  } catch (e) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem('rvb-state');
    if (!raw) return;
    const d = JSON.parse(raw);
    S.library = d.library || [];
    S.nextId = d.nextId || (S.library.length ? Math.max(...S.library.map((t) => t.id)) + 1 : 0);
    S.auto = Object.assign(S.auto, d.auto || {});
    S.masterVol = d.masterVol ?? S.masterVol;
    S.xfader = d.xfader ?? S.xfader;
    S.gainTrim = d.gainTrim ?? 0;
    S.duck = d.duck ?? 40;
    S.micGainVal = d.micGainVal ?? 6;
    S.micGateDb = d.micGateDb ?? -35;
    S.micComp = d.micComp ?? 60;
    S.eq = d.eq && d.eq.length === 7 ? d.eq : S.eq;
    S.mode = d.mode || 'auto';
  } catch (e) {}
}

// ==================== KEYBOARD ====================
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const deck = S.activeDeck;
    switch (e.code) {
      case 'Space': e.preventDefault(); togglePlay(deck); break;
      case 'ArrowLeft': seek(deck, getPos(deck) - 5); break;
      case 'ArrowRight': seek(deck, getPos(deck) + 5); break;
      case 'ArrowUp': nudge(deck, 1); break;
      case 'ArrowDown': nudge(deck, -1); break;
      case 'KeyM': toggleMic(); break;
      case 'KeyF': favTrack(); break;
      case 'KeyL': setLoop(DECK[deck].loop ? DECK[deck].loop : 4); break;
      default:
        if (/^Digit[1-8]$/.test(e.code)) { setCue(parseInt(e.code.slice(5), 10) - 1); }
    }
  });
}

// ==================== DRAG & DROP ====================
function initDrop() {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener('dragover', stop);
  window.addEventListener('drop', async (e) => {
    stop(e);
    const files = Array.from(e.dataTransfer.files || [])
      .filter((f) => /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i.test(f.name))
      .map((f) => ({ name: f.name, path: f.path, ext: extname(f.name) }));
    if (files.length) {
      await addTracks(files);
      if (S.library.length && DECK.A.id === null) loadTrack(S.library[0].id, 'A');
    }
  });
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
  loadState();
  initSliders();
  initEq();
  initXfader();
  initSeek();
  initCueLoop();
  initKeyboard();
  initDrop();

  // Restore UI state
  const mv = document.querySelector('.slr[data-p="masterVol"]');
  if (mv) { mv.querySelector('.slh').style.left = (S.masterVol * 100) + '%'; mv.querySelector('.slf').style.width = (S.masterVol * 100) + '%'; mv.closest('.sl').querySelector('.slv').textContent = Math.round(S.masterVol * 100) + '%'; }
  document.getElementById('mvFill').style.height = (S.masterVol * 100) + '%';
  document.getElementById('xfTh').style.left = (S.xfader * 100) + '%';
  applyXfader();
  applyMasterGain();
  S.eq.forEach((v, i) => { if (eqFilters[i]) eqFilters[i].gain.value = v; });

  // Auto pills + auto grid reflect restored state
  document.querySelectorAll('.auto-pill').forEach((el) => {
    const k = el.dataset.auto;
    if (k && S.auto[k]) el.classList.add('on'); else el.classList.remove('on');
  });
  document.querySelectorAll('.ag').forEach((el) => {
    const map = { 'Beatmatch': 'beatmatch', 'Auto-Gain': 'gain', 'Auto-EQ': 'eq', 'Key Match': 'keymatch', 'Transition': 'transition', 'Polish': 'polish', 'Shuffle': 'shuffle', 'Limiter': 'limiter', 'Cue Points': 'cuepoints', 'Sidechain': 'sidechain' };
    const k = map[el.querySelector('.an')?.textContent];
    if (k) { el.classList.toggle('on', !!S.auto[k]); }
  });
  document.getElementById('mAuto').classList.toggle('on', S.mode === 'auto');
  document.getElementById('mLive').classList.toggle('on', S.mode === 'live');
  document.getElementById('mDJ').classList.toggle('on', S.mode === 'dj');

  const ver = await rb.getVersion();
  document.getElementById('verTag').textContent = 'v' + ver;
  document.title = 'RUST VOICE BOOSTER ' + ver;

  renderLib();
  updateDeckSel();
  updateNowPlaying();
  drawViz();
  updateMeters();
  tickTime();
  tickCPU();
  buildAutoPlaylist();

  // Restore cable device choice + init virtual device UI
  const savedId = localStorage.getItem('rvb-cable-id');
  const savedLabel = localStorage.getItem('rvb-cable-label');
  if (savedId) { S.cableDeviceId = savedId; S.cableDeviceLabel = savedLabel || savedId; }
  // Refresh virtual cable devices after a short delay (needs engine)
  setTimeout(async () => {
    await refreshCableDevices();
    await updateNativeInfo();
    // If still no device, try main process check
    try {
      const info = await rb.checkVirtualCable();
      const statusEl = document.getElementById('cableStatus');
      if (statusEl) {
        if (info.hasOwnDevice) statusEl.textContent = 'Own device active: Rust Voice Booster (direct exe -> driver)';
        else if (info.installed) statusEl.textContent = 'VB-Cable found — click SETUP to rename to RVB';
        else statusEl.textContent = 'No virtual device — click SETUP to install';
      }
    } catch(e){}
  }, 800);
  // Listen for device changes (e.g. user plugs cable)
  try { navigator.mediaDevices.addEventListener('devicechange', refreshCableDevices); } catch(e) {}
  setInterval(updateNativeInfo, 2000);

  console.log('[Rust Voice Booster] Engine Ready');
});

