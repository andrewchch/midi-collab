/**
 * MIDI Collab Editor – app.js
 *
 * Architecture:
 *  - State: notes[], bpm, bars, noteDuration, metronome
 *  - Rendering: Canvas-based piano roll
 *  - Playback: Web Audio API (OscillatorNode synth + metronome clicks)
 *  - MIDI import: minimal SMF parser (no external dependency)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTES_PER_OCTAVE = 12;
const OCTAVES = 2;
const NUM_PITCHES = NOTES_PER_OCTAVE * OCTAVES; // 24 rows

// Two octaves: C4 (MIDI 60) to B5 (MIDI 83)
const BASE_MIDI = 60;

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// Grid dimensions (pixels)
const ROW_H = 18;          // height of one pitch row
const BEAT_W = 80;         // pixels per beat (quarter note)
const BEATS_PER_BAR = 4;   // 4/4 time


// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let notes = [];          // { id, pitch, startBeat, durationBeats }
let bpm = 120;
let bars = 8;
let noteDurationBeats = 4;  // default: full note (4 beats)
let metronomeEnabled = false;

let audioCtx = null;
let scheduledSources = [];
let isPlaying = false;
let playStartTime = 0;    // audioCtx.currentTime when playback started
let animFrameId = null;
let _nextNoteId = 0;

function nextId() { return _nextNoteId++; }

// ---------------------------------------------------------------------------
// UI elements
// ---------------------------------------------------------------------------

const barsSelect         = document.getElementById('barsSelect');
const noteDurationSelect = document.getElementById('noteDurationSelect');
const bpmInput           = document.getElementById('bpmInput');
const metronomeToggle    = document.getElementById('metronomeToggle');
const playBtn            = document.getElementById('playBtn');
const stopBtn            = document.getElementById('stopBtn');
const clearBtn           = document.getElementById('clearBtn');
const midiFileInput      = document.getElementById('midiFileInput');
const statusMsg          = document.getElementById('status-msg');
const playheadPos        = document.getElementById('playhead-pos');
const canvas             = document.getElementById('grid-canvas');
const ctx                = canvas.getContext('2d');
const pianoKeysDiv       = document.getElementById('piano-keys');
const gridScroll         = document.getElementById('grid-scroll');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function midiNoteToName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[midi % 12] + octave;
}

function totalBeats() { return bars * BEATS_PER_BAR; }

function beatToX(beat) { return beat * BEAT_W; }

function pitchToRow(pitch) {
  // pitch is MIDI note; row 0 = top = highest pitch
  return (BASE_MIDI + NUM_PITCHES - 1) - pitch;
}

function rowToPitch(row) {
  return (BASE_MIDI + NUM_PITCHES - 1) - row;
}

function xToBeat(x) { return x / BEAT_W; }

function yToRow(y) { return Math.floor(y / ROW_H); }

// Snap beat to grid based on current note duration
function snapBeat(beat) {
  return Math.floor(beat / noteDurationBeats) * noteDurationBeats;
}

// ---------------------------------------------------------------------------
// Canvas setup
// ---------------------------------------------------------------------------

function resizeCanvas() {
  const totalW = totalBeats() * BEAT_W;
  const totalH = NUM_PITCHES * ROW_H;
  canvas.width  = totalW;
  canvas.height = totalH;
  pianoKeysDiv.style.height = totalH + 'px';
  pianoKeysDiv.style.width  = '48px';
  drawPianoKeys();
  render();
}

// ---------------------------------------------------------------------------
// Piano key sidebar (HTML)
// ---------------------------------------------------------------------------

function drawPianoKeys() {
  pianoKeysDiv.innerHTML = '';
  const totalH = NUM_PITCHES * ROW_H;
  pianoKeysDiv.style.height = totalH + 'px';

  for (let row = 0; row < NUM_PITCHES; row++) {
    const pitch = rowToPitch(row);
    const noteName = NOTE_NAMES[pitch % 12];
    const isBlack = noteName.includes('#');
    const div = document.createElement('div');
    div.style.position = 'absolute';
    div.style.top = (row * ROW_H) + 'px';
    div.style.left = '0';
    div.style.width = '48px';
    div.style.height = ROW_H + 'px';
    div.style.background = isBlack ? '#1a1a2e' : '#2a3a5a';
    div.style.borderBottom = '1px solid #0f3460';
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.paddingLeft = isBlack ? '6px' : '2px';
    div.style.fontSize = '10px';
    div.style.color = isBlack ? '#8899aa' : '#c0d4e8';
    div.style.userSelect = 'none';
    div.textContent = noteName.includes('#') ? noteName : midiNoteToName(pitch);
    pianoKeysDiv.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(playheadBeat) {
  const totalW = totalBeats() * BEAT_W;
  const totalH = NUM_PITCHES * ROW_H;

  ctx.clearRect(0, 0, totalW, totalH);

  // Background rows
  for (let row = 0; row < NUM_PITCHES; row++) {
    const pitch = rowToPitch(row);
    const noteName = NOTE_NAMES[pitch % 12];
    const isBlack = noteName.includes('#');
    ctx.fillStyle = isBlack ? '#0f1a2e' : '#16213e';
    ctx.fillRect(0, row * ROW_H, totalW, ROW_H);
  }

  // Grid lines – beats
  for (let b = 0; b <= totalBeats(); b++) {
    const x = beatToX(b);
    const isBar = b % BEATS_PER_BAR === 0;
    ctx.strokeStyle = isBar ? '#2a4a6a' : '#1a2e4a';
    ctx.lineWidth = isBar ? 1.5 : 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, totalH);
    ctx.stroke();
  }

  // Horizontal row lines
  ctx.strokeStyle = '#1a2e4a';
  ctx.lineWidth = 0.5;
  for (let row = 0; row <= NUM_PITCHES; row++) {
    const y = row * ROW_H;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(totalW, y);
    ctx.stroke();
  }

  // Bar numbers
  ctx.fillStyle = '#3a5a7a';
  ctx.font = '10px monospace';
  for (let bar = 0; bar < bars; bar++) {
    ctx.fillText('Bar ' + (bar + 1), beatToX(bar * BEATS_PER_BAR) + 3, 11);
  }

  // Notes
  for (const note of notes) {
    const row = pitchToRow(note.pitch);
    const x = beatToX(note.startBeat);
    const w = note.durationBeats * BEAT_W - 2;
    const y = row * ROW_H + 1;
    const h = ROW_H - 2;

    // gradient fill
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, '#e94560');
    grad.addColorStop(1, '#a02030');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x + 1, y, w, h, 3);
    ctx.fill();

    ctx.strokeStyle = '#ff6080';
    ctx.lineWidth = 1;
    ctx.stroke();

    // label
    if (w > 20) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText(midiNoteToName(note.pitch), x + 4, y + h - 3);
    }
  }

  // Playhead
  if (playheadBeat !== undefined) {
    const px = beatToX(playheadBeat);
    ctx.strokeStyle = '#ffdd57';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, totalH);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Note management
// ---------------------------------------------------------------------------

function addNote(pitch, startBeat, durationBeats) {
  const end = startBeat + durationBeats;
  const maxBeats = totalBeats();

  if (startBeat < 0 || startBeat >= maxBeats) return;
  if (end > maxBeats) return;

  // Overlap check: no two notes on the same pitch can overlap
  for (const n of notes) {
    if (n.pitch !== pitch) continue;
    const nEnd = n.startBeat + n.durationBeats;
    if (startBeat < nEnd && end > n.startBeat) {
      setStatus('Overlap – note not added');
      return;
    }
  }

  notes.push({ id: nextId(), pitch, startBeat, durationBeats });
  setStatus('Note added: ' + midiNoteToName(pitch));
  render();
}

function removeNoteAt(pitch, beat) {
  const idx = notes.findIndex(n =>
    n.pitch === pitch &&
    beat >= n.startBeat &&
    beat < n.startBeat + n.durationBeats
  );
  if (idx !== -1) {
    notes.splice(idx, 1);
    setStatus('Note removed');
    render();
  }
}

// ---------------------------------------------------------------------------
// Canvas mouse interaction
// ---------------------------------------------------------------------------

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  const row = yToRow(y);
  if (row < 0 || row >= NUM_PITCHES) return;

  const pitch = rowToPitch(row);
  const rawBeat = xToBeat(x);
  const snappedBeat = snapBeat(rawBeat);

  // Right-click handled via contextmenu; left-click = add/toggle
  const existing = notes.find(n =>
    n.pitch === pitch &&
    rawBeat >= n.startBeat &&
    rawBeat < n.startBeat + n.durationBeats
  );

  if (existing) {
    removeNoteAt(pitch, rawBeat);
  } else {
    addNote(pitch, snappedBeat, noteDurationBeats);
  }
  saveNotes();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  const row = yToRow(y);
  if (row < 0 || row >= NUM_PITCHES) return;
  const pitch = rowToPitch(row);
  const rawBeat = xToBeat(x);
  removeNoteAt(pitch, rawBeat);
  saveNotes();
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

barsSelect.addEventListener('change', () => {
  bars = parseInt(barsSelect.value, 10);
  // Remove notes beyond new end
  const max = totalBeats();
  notes = notes.filter(n => n.startBeat + n.durationBeats <= max);
  resizeCanvas();
});

bpmInput.addEventListener('change', () => {
  bpm = Math.max(20, Math.min(300, parseInt(bpmInput.value, 10) || 120));
  bpmInput.value = bpm;
});

metronomeToggle.addEventListener('change', () => {
  metronomeEnabled = metronomeToggle.checked;
});

clearBtn.addEventListener('click', () => {
  notes = [];
  setStatus('Cleared');
  render();
  saveNotes();
});

// ---------------------------------------------------------------------------
// Web Audio helpers
// ---------------------------------------------------------------------------

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Schedule a synth note (simple sawtooth → filter → envelope)
 */
function scheduleNote(pitch, startTime, durationSec, ac) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  const filter = ac.createBiquadFilter();

  osc.type = 'sawtooth';
  osc.frequency.value = midiToFreq(pitch);

  filter.type = 'lowpass';
  filter.frequency.value = 1200;
  filter.Q.value = 1.5;

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ac.destination);

  const attack = 0.01;
  const release = Math.min(0.15, durationSec * 0.3);
  const sustain = durationSec - attack - release;

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.4, startTime + attack);
  if (sustain > 0) gain.gain.setValueAtTime(0.4, startTime + attack + sustain);
  gain.gain.linearRampToValueAtTime(0, startTime + durationSec);

  osc.start(startTime);
  osc.stop(startTime + durationSec + 0.01);

  scheduledSources.push(osc, gain, filter);
}

/**
 * Schedule a metronome click
 */
function scheduleClick(startTime, isBar, ac) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();

  osc.type = 'sine';
  osc.frequency.value = isBar ? 1000 : 600;

  osc.connect(gain);
  gain.connect(ac.destination);

  gain.gain.setValueAtTime(0.5, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.05);

  osc.start(startTime);
  osc.stop(startTime + 0.06);

  scheduledSources.push(osc, gain);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function beatsToSeconds(beats) {
  return beats * (60 / bpm);
}

function startPlayback() {
  if (isPlaying) stopPlayback();
  const ac = getAudioCtx();
  if (ac.state === 'suspended') ac.resume();

  isPlaying = true;
  playBtn.disabled = true;
  stopBtn.disabled = false;

  const startTime = ac.currentTime + 0.1;
  playStartTime = startTime;
  scheduledSources = [];

  const totalDurationSec = beatsToSeconds(totalBeats());

  // Schedule all notes
  for (const note of notes) {
    const noteStart = startTime + beatsToSeconds(note.startBeat);
    const noteDur   = beatsToSeconds(note.durationBeats);
    scheduleNote(note.pitch, noteStart, noteDur, ac);
  }

  // Schedule metronome clicks
  if (metronomeEnabled) {
    for (let beat = 0; beat < totalBeats(); beat++) {
      const clickTime = startTime + beatsToSeconds(beat);
      const isBar = beat % BEATS_PER_BAR === 0;
      scheduleClick(clickTime, isBar, ac);
    }
  }

  // Animate playhead
  function animatePlayhead() {
    if (!isPlaying) return;
    const elapsed = ac.currentTime - startTime;
    const playheadBeat = elapsed * (bpm / 60);
    if (playheadBeat >= totalBeats()) {
      render();
      stopPlayback();
      setStatus('Playback finished');
      return;
    }
    render(playheadBeat);
    playheadPos.textContent = 'Bar ' + (Math.floor(playheadBeat / BEATS_PER_BAR) + 1) +
      ' Beat ' + (Math.floor(playheadBeat % BEATS_PER_BAR) + 1);
    animFrameId = requestAnimationFrame(animatePlayhead);
  }
  animFrameId = requestAnimationFrame(animatePlayhead);
  setStatus('Playing…');
}

function stopPlayback() {
  isPlaying = false;
  playBtn.disabled = false;
  stopBtn.disabled = true;

  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }

  for (const src of scheduledSources) {
    try { if (src.stop) src.stop(0); } catch (_) {}
    try { src.disconnect(); } catch (_) {}
  }
  scheduledSources = [];
  playheadPos.textContent = '';
  render();
}

playBtn.addEventListener('click', startPlayback);
stopBtn.addEventListener('click', () => { stopPlayback(); setStatus('Stopped'); });
stopBtn.disabled = true;

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function setStatus(msg) {
  statusMsg.textContent = msg;
}

// ---------------------------------------------------------------------------
// Minimal SMF (Standard MIDI File) parser
// ---------------------------------------------------------------------------

/**
 * Parse a Standard MIDI File (format 0 or 1) from an ArrayBuffer.
 * Returns an array of { pitch, startBeat, durationBeats } objects.
 * Only processes channel note-on/note-off events; ignores meta/sysex.
 */
function parseMidiFile(buffer) {
  const data = new Uint8Array(buffer);
  let pos = 0;

  function readUint32() {
    const v = (data[pos] << 24) | (data[pos+1] << 16) | (data[pos+2] << 8) | data[pos+3];
    pos += 4;
    return v >>> 0;
  }

  function readUint16() {
    const v = (data[pos] << 8) | data[pos+1];
    pos += 2;
    return v;
  }

  function readVLQ() {
    let value = 0;
    let byte;
    do {
      byte = data[pos++];
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return value;
  }

  // Header chunk
  if (String.fromCharCode(...data.slice(0, 4)) !== 'MThd') throw new Error('Not a MIDI file');
  pos = 4;
  readUint32(); // header length (always 6)
  const format   = readUint16();
  const numTracks = readUint16();
  const division  = readUint16(); // ticks per quarter note (assume non-SMPTE)

  if (division & 0x8000) throw new Error('SMPTE timecode MIDI not supported');
  if (format === 2) throw new Error('MIDI format 2 (multiple sequential patterns) is not supported');

  const ticksPerBeat = division;
  const allNoteEvents = []; // { tick, type, pitch, velocity }

  for (let t = 0; t < numTracks; t++) {
    const marker = String.fromCharCode(...data.slice(pos, pos + 4));
    if (marker !== 'MTrk') { pos += 4; readUint32(); continue; }
    pos += 4;
    const trackLen = readUint32();
    const trackEnd = pos + trackLen;

    let tick = 0;
    let runningStatus = 0;

    while (pos < trackEnd) {
      const delta = readVLQ();
      tick += delta;

      let statusByte = data[pos];
      if (statusByte & 0x80) {
        runningStatus = statusByte;
        pos++;
      } else {
        statusByte = runningStatus;
        // don't advance pos – data byte reuse
      }

      const msgType = statusByte & 0xf0;

      if (statusByte === 0xff) {
        // Meta event
        const metaType = data[pos++];
        const metaLen  = readVLQ();
        pos += metaLen;
      } else if (statusByte === 0xf0 || statusByte === 0xf7) {
        // SysEx
        const sysLen = readVLQ();
        pos += sysLen;
      } else if (msgType === 0x90) {
        // Note On
        const pitch    = data[pos++];
        const velocity = data[pos++];
        allNoteEvents.push({ tick, type: velocity > 0 ? 'on' : 'off', pitch });
      } else if (msgType === 0x80) {
        // Note Off
        const pitch = data[pos++];
        pos++; // velocity
        allNoteEvents.push({ tick, type: 'off', pitch });
      } else if (msgType === 0xa0 || msgType === 0xb0 || msgType === 0xe0) {
        pos += 2;
      } else if (msgType === 0xc0 || msgType === 0xd0) {
        pos += 1;
      } else {
        // Unknown – skip 1 byte and hope for the best
        pos += 1;
      }
    }

    pos = trackEnd;
  }

  // Convert tick-based events to beat-based notes
  allNoteEvents.sort((a, b) => a.tick - b.tick);

  const openNotes = {}; // pitch -> startTick
  const result = [];

  for (const ev of allNoteEvents) {
    if (ev.type === 'on') {
      openNotes[ev.pitch] = ev.tick;
    } else if (ev.type === 'off' && openNotes[ev.pitch] !== undefined) {
      const startTick = openNotes[ev.pitch];
      delete openNotes[ev.pitch];
      const startBeat = startTick / ticksPerBeat;
      const durBeats  = (ev.tick - startTick) / ticksPerBeat;
      if (durBeats > 0) {
        result.push({ pitch: ev.pitch, startBeat, durationBeats: durBeats });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// MIDI file input
// ---------------------------------------------------------------------------

midiFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('Loading ' + file.name + '…');

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = parseMidiFile(ev.target.result);

      // Filter to pitches in our 2-octave range and beats within current bars
      const maxBeats = totalBeats();
      const filtered = parsed.filter(n =>
        n.pitch >= BASE_MIDI &&
        n.pitch < BASE_MIDI + NUM_PITCHES &&
        n.startBeat < maxBeats
      ).map(n => ({
        ...n,
        durationBeats: Math.min(n.durationBeats, maxBeats - n.startBeat),
      }));

      // Clamp durations to min 0.5 beats (1/8 note)
      const clamped = filtered.filter(n => n.durationBeats >= 0.5);

      // Remove overlaps (keep earlier note)
      const deOverlapped = [];
      for (const n of clamped) {
        const clash = deOverlapped.some(existing =>
          existing.pitch === n.pitch &&
          n.startBeat < existing.startBeat + existing.durationBeats &&
          n.startBeat + n.durationBeats > existing.startBeat
        );
        if (!clash) deOverlapped.push(n);
      }

      notes = deOverlapped.map(n => ({ ...n, id: nextId() }));
      setStatus(`Loaded ${notes.length} notes from ${file.name}`);
      render();
    } catch (err) {
      setStatus('Error loading MIDI: ' + err.message);
      console.error(err);
    }
    // Reset input so the same file can be re-loaded
    midiFileInput.value = '';
  };
  reader.readAsArrayBuffer(file);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Set initial duration from select (default full = 4 beats)
noteDurationSelect.value = '1'; // 1 in select = full note mapped below
// Map select values: 0.125->0.5beats, 0.25->1beat, 0.5->2beats, 1->4beats
noteDurationSelect.addEventListener('change', mapDuration);
function mapDuration() {
  const val = parseFloat(noteDurationSelect.value);
  // val is fraction of whole note: 0.125=1/8, 0.25=1/4, 0.5=1/2, 1=full
  noteDurationBeats = val * 4; // convert to beats (quarter notes)
}
// Set from current select on load
mapDuration();

resizeCanvas();
setStatus('Click on the grid to add notes. Right-click to remove.');

// ---------------------------------------------------------------------------
// Persistence – localStorage
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = 'midi-collab-';

function saveLocal(datasetName) {
  if (!datasetName) return;
  const data = { notes, bpm, bars, noteDurationBeats, savedAt: Date.now() };
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + datasetName, JSON.stringify(data));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
}

function loadLocal(datasetName) {
  if (!datasetName) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + datasetName);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('localStorage load failed:', e);
    return null;
  }
}

/** Convenience: save current notes under the active dataset name. */
function saveNotes() {
  saveLocal(datasetNameInput.value.trim());
}

// ---------------------------------------------------------------------------
// Peer-change tracking
// ---------------------------------------------------------------------------

// Notes that were changed by a remote peer (highlighted differently on render)
let peerAddedNotes = new Set(); // keys of notes added by peer
let peerRemovedSlots = new Set(); // keys of slots removed by peer

function peerKey(pitch, startBeat) {
  return pitch + ':' + startBeat;
}

function applyPeerChanges(peerChanges) {
  if (!peerChanges) return;
  peerAddedNotes = new Set((peerChanges.added || []).map(n => peerKey(n.pitch, n.startBeat)));
  peerRemovedSlots = new Set((peerChanges.removed || []).map(n => peerKey(n.pitch, n.startBeat)));
}

// ---------------------------------------------------------------------------
// Sync UI elements
// ---------------------------------------------------------------------------

const datasetNameInput = document.getElementById('datasetName');
const pushBtn          = document.getElementById('pushBtn');
const pullBtn          = document.getElementById('pullBtn');
const syncStatusEl     = document.getElementById('syncStatus');

function setSyncStatus(msg, type) {
  syncStatusEl.textContent = msg;
  syncStatusEl.className = 'sync-status' + (type ? ' ' + type : '');
}

// ---------------------------------------------------------------------------
// Render (extended) – highlight peer-changed notes
// ---------------------------------------------------------------------------

// Override render to highlight peer notes
const _baseRender = render;
render = function renderWithPeerHighlight(playheadBeat) {
  _baseRender(playheadBeat);

  const totalW = totalBeats() * BEAT_W;
  const totalH = NUM_PITCHES * ROW_H;

  // Highlight notes added by peer
  for (const note of notes) {
    const key = peerKey(note.pitch, note.startBeat);
    if (!peerAddedNotes.has(key)) continue;
    const row = pitchToRow(note.pitch);
    const x = beatToX(note.startBeat);
    const w = note.durationBeats * BEAT_W - 2;
    const y = row * ROW_H + 1;
    const h = ROW_H - 2;
    ctx.strokeStyle = '#57e9a0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x + 1, y, w, h, 3);
    ctx.stroke();
  }

  // Show ghost markers for notes removed by peer
  for (const key of peerRemovedSlots) {
    const [pitchStr, beatStr] = key.split(':');
    const pitch = parseInt(pitchStr, 10);
    const startBeat = parseFloat(beatStr);
    const row = pitchToRow(pitch);
    if (row < 0 || row >= NUM_PITCHES) continue;
    const x = beatToX(startBeat);
    const y = row * ROW_H + 1;
    const h = ROW_H - 2;
    ctx.strokeStyle = '#e94560';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.roundRect(x + 1, y, noteDurationBeats * BEAT_W - 2, h, 3);
    ctx.stroke();
    ctx.setLineDash([]);
  }
};

// ---------------------------------------------------------------------------
// Push – send local notes to server
// ---------------------------------------------------------------------------

const DATASET_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function validateDatasetName(name) {
  return DATASET_NAME_RE.test(name);
}

async function pushToServer() {
  const datasetName = datasetNameInput.value.trim();
  if (!validateDatasetName(datasetName)) { setSyncStatus('Invalid dataset name', 'error'); return; }

  setSyncStatus('Pushing…');
  pushBtn.disabled = true;

  // Snapshot local state before sending so we can compare on pull
  const snapshot = notes.map(n => ({ ...n }));

  try {
    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset: datasetName, notes: snapshot }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    // Update local notes to the merged result
    notes = data.notes.map(n => ({ ...n, id: n.id !== undefined ? n.id : nextId() }));
    applyPeerChanges(data.peer_changes);
    saveLocal(datasetName);
    render();
    setSyncStatus('Pushed ✓', 'ok');
    setStatus('Pushed ' + notes.length + ' notes (v' + data.version + ')');
  } catch (err) {
    setSyncStatus('Push failed', 'error');
    setStatus('Push error: ' + err.message);
    console.error(err);
  } finally {
    pushBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Pull – fetch merged notes from server
// ---------------------------------------------------------------------------

async function pullFromServer() {
  const datasetName = datasetNameInput.value.trim();
  if (!validateDatasetName(datasetName)) { setSyncStatus('Invalid dataset name', 'error'); return; }

  setSyncStatus('Pulling…');
  pullBtn.disabled = true;

  // Remember current local notes for diff
  const preNotes = notes.map(n => ({ ...n }));

  try {
    const res = await fetch('/api/sync/pull?dataset=' + encodeURIComponent(datasetName));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    // Compute peer changes: what's different between our local state and server
    const preIndex = {};
    for (const n of preNotes) preIndex[peerKey(n.pitch, n.startBeat)] = n;

    const serverIndex = {};
    for (const n of data.notes) serverIndex[peerKey(n.pitch, n.startBeat)] = n;

    const added = data.notes.filter(n => !preIndex[peerKey(n.pitch, n.startBeat)]);
    const removed = preNotes.filter(n => !serverIndex[peerKey(n.pitch, n.startBeat)]);

    notes = data.notes.map(n => ({ ...n, id: n.id !== undefined ? n.id : nextId() }));
    applyPeerChanges({ added, removed });
    saveLocal(datasetName);
    render();
    setSyncStatus('Pulled ✓', 'ok');
    setStatus('Pulled ' + notes.length + ' notes (v' + data.version + ')');
  } catch (err) {
    setSyncStatus('Pull failed', 'error');
    setStatus('Pull error: ' + err.message);
    console.error(err);
  } finally {
    pullBtn.disabled = false;
  }
}

pushBtn.addEventListener('click', pushToServer);
pullBtn.addEventListener('click', pullFromServer);

// ---------------------------------------------------------------------------
// On load – restore from localStorage if a dataset is stored
// ---------------------------------------------------------------------------

(function restoreOnLoad() {
  const datasetName = datasetNameInput.value.trim();
  const saved = loadLocal(datasetName);
  if (saved && Array.isArray(saved.notes) && saved.notes.length > 0) {
    notes = saved.notes.map(n => ({ ...n, id: n.id !== undefined ? n.id : nextId() }));
    if (saved.bpm) { bpm = saved.bpm; bpmInput.value = bpm; }
    if (saved.bars) {
      bars = saved.bars;
      barsSelect.value = String(bars);
      resizeCanvas();
    }
    render();
    setStatus('Restored ' + notes.length + ' notes from local storage (' + datasetName + ')');
  }
})();
