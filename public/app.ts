const VIEWS = [
  ['watch', 'Door'],
  ['listen', 'Today'],
  ['log', 'Family log'],
  ['people', 'People'],
  ['care', 'Care']
];

const KIND = {
  doorbell: 'Doorbell',
  person: 'Person',
  vehicle: 'Vehicle',
  motion: 'Motion',
  anomaly: 'Alert',
  late: 'Late',
  offline: 'Offline',
  online: 'Online',
  system: 'Account',
  rule: 'Rule',
  package: 'Package',
  fall: 'Fall',
  loitering: 'Waiting',
  knock: 'Knock'
};

const PANELS = {
  doorbell: 'panel-doorbell',
  person: 'panel-person',
  vehicle: 'panel-vehicle',
  motion: 'panel-motion',
  anomaly: 'panel-anomaly',
  late: 'panel-anomaly',
  offline: 'panel-anomaly',
  rule: 'panel-anomaly',
  system: 'panel-anomaly',
  online: 'panel-quiet',
  package: 'panel-package',
  fall: 'panel-anomaly',
  loitering: 'panel-doorbell',
  knock: 'panel-doorbell'
};

let state = null;
let view = localStorage.getItem('carebell-view') || 'listen';
let logKind = 'all';
let logDay = 'all';
let scrolledFor = '';
let audioCtx = null;
let bedsideTimer = null;
let bedsideFor = '';
let liveSession = null;
const content = document.getElementById('content');
const banner = document.getElementById('banner');
const nav = document.getElementById('nav');
const live = document.getElementById('live');

function el(tag: string, attrs?: any, children?: any[]): any {
  const node: any = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]: [string, any]) => {
    if (value == null || value === false) return;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  });
  (children || []).forEach((child) => {
    node.append(child && child.nodeType ? child : document.createTextNode(child ?? ''));
  });
  return node;
}

function primeAudio() {
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return;
  audioCtx = audioCtx || new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function beep(kind) {
  if (!audioCtx) return;
  const tones = kind === 'anomaly' ? [440, 440, 330] : [784, 988];
  const now = audioCtx.currentTime;
  tones.forEach((freq, index) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const start = now + index * 0.28;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    osc.start(start);
    osc.stop(start + 0.24);
  });
}

function maybeBeep(alert) {
  if (!alert || !alert.playSound) return;
  const key = `carebell-sound-${alert.id}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, '1');
  beep(alert.kind);
}

function announce(text) {
  if (!text || live.textContent === text) return;
  live.textContent = '';
  window.setTimeout(() => { live.textContent = text; }, 30);
}

function apply(next) {
  const previousId = state && state.banner ? state.banner.id : '';
  state = next;
  renderChrome();
  if (!liveSession) {
    renderBanner();
    if (!editingForm()) renderMain();
  }
  maybeBeep(state.banner);
  syncBedside(state.banner);
  if (state.banner && state.banner.id !== previousId) {
    announce(`${state.banner.title}. ${state.banner.detail}`);
    if (state.banner.level === 'critical') document.title = `[${state.banner.title}] CareBell`;
  }
  if (!state.banner && previousId) {
    announce('Alert acknowledged.');
    document.title = 'CareBell door watch';
  }
}

async function request(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(body.error || 'request failed');
    error.status = response.status;
    throw error;
  }
  return body;
}

function renderChrome() {
  nav.replaceChildren(...VIEWS.map(([id, label]) => el('button', {
    type: 'button',
    'aria-current': view === id ? 'page' : null,
    onclick: () => showView(id)
  }, [label])));
  const mode = document.getElementById('mode');
  const signOut = document.getElementById('sign-out');
  if (signOut) signOut.hidden = false;
  const playground = state.playground || {};
  if (playground.error) mode.textContent = playground.error;
  else if (playground.connected && playground.source === 'ring') mode.textContent = 'Connected through your Ring account. New door events appear here within about 20 seconds.';
  else if (playground.connected) mode.textContent = 'Connected to the Ring Playground. New door events appear here within about 20 seconds.';
  else mode.textContent = 'Practice mode. The buttons below pretend a door event just happened.';
}

function renderBanner() {
  banner.replaceChildren();
  if (state.paused) {
    const strip = el('div', { class: 'pause' }, [
      el('div', { class: 'wrap' }, [
        el('strong', {}, ['Door watch is paused']),
        el('p', {}, [state.pauseReason || 'Turn the subscription back on in Ring My Apps.'])
      ])
    ]);
    banner.append(strip);
  }
  if (state.banner && state.settings.bedsideMode && state.banner.level === 'critical') {
    banner.append(renderAlert(state.banner, true));
    return;
  }
  if (!state.banner || view === 'watch') return;
  banner.append(el('div', { class: 'wrap', style: null }, [
    renderAlert(state.banner, false)
  ]));
}

function shot(alert) {
  if (!alert.snapshotUrl) {
    return alert.snapshotNote ? el('p', {}, [alert.snapshotNote]) : document.createTextNode('');
  }
  return el('figure', {}, [
    el('img', { class: 'shot', src: alert.snapshotUrl, alt: '' }),
    el('figcaption', {}, [alert.snapshotNote || 'Picture from the door'])
  ]);
}

function renderAlert(alert, full) {
  const bedside = full && state.settings.bedsideMode && alert.level === 'critical';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const panel = el('article', {
    class: `panel ${PANELS[alert.kind] || 'panel-motion'}${full ? '' : ' panel-slim'}${bedside ? ` bedside${reduced ? '' : ' flash'}` : ''}`
  }, [
    el('p', { class: 'badge' }, [bedside ? 'Bedside alert' : (KIND[alert.kind] || 'Notice')]),
    el('h2', { class: full ? 'giant' : 'slim-title' }, [alert.title]),
    el('p', {}, [`${alert.localTime} · ${state.settings.deviceName}`]),
    full ? shot(alert) : '',
    full ? el('p', {}, [alert.detail]) : '',
    full && alert.chimeMessage ? el('p', {}, [alert.chimeMessage]) : '',
    full ? clipBlock(alert) : '',
    full ? liveBlock() : '',
    state.pending > 1 ? el('p', {}, [`${state.pending - 1} more alert${state.pending - 1 === 1 ? '' : 's'}. Acknowledge this one to see the next.`]) : ''
  ]);
  const actions = el('div', { class: 'actions' });
  if (full && state.mode === 'live') {
    actions.append(el('button', { type: 'button', class: 'btn-primary', onclick: (event) => lookNow(event.currentTarget) }, ['Look now']));
  }
  if (!full) {
    actions.append(el('button', { type: 'button', class: 'btn-light', onclick: () => showView('watch') }, ['Open the door view']));
  }
  actions.append(el('button', {
    type: 'button',
    class: 'btn-light',
    onclick: () => acknowledge(alert.id)
  }, ['I have seen this']));
  panel.append(actions);
  if (bedside) {
    queueMicrotask(() => {
      const seen = [...panel.querySelectorAll('button')].find((button) => button.textContent === 'I have seen this');
      if (seen) seen.focus();
    });
  }
  return panel;
}

function latestClipEvent(moments) {
  const list = moments || [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (['doorbell', 'person'].includes(list[index].kind) && !list[index].sample) return list[index];
  }
  return null;
}

function clipBlock(source) {
  if (!source) return '';
  if (source.clipUrl) {
    const note = el('p', {}, [source.clipNote || 'This is the recording from that moment at the door.']);
    return el('figure', {}, [
      el('video', { class: 'clip', controls: true, src: source.clipUrl, playsinline: true }),
      note
    ]);
  }
  if (state.mode !== 'live' || source.sample || !source.id || !['doorbell', 'person'].includes(source.kind)) return '';
  const status = el('p', { role: 'status' }, ['']);
  const button = el('button', {
    type: 'button',
    onclick: () => loadClip(source.id, button, status)
  }, ['Play the clip']);
  return el('div', { class: 'actions' }, [button, status]);
}

async function loadClip(id, button, status) {
  button.disabled = true;
  status.textContent = 'Getting the recording…';
  try {
    const response = await fetch(`/api/events/${id}/clip`, { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'No recording is available for this moment.');
    apply(body);
  } catch (error) {
    status.textContent = error.message || 'No recording is available for this moment. The words still stand.';
    button.disabled = false;
  }
}

function liveBlock() {
  return el('div', { id: 'live-view', class: 'live-box' });
}

function syncBedside(alert) {
  const on = Boolean(alert && state.settings.bedsideMode && alert.level === 'critical');
  if (!on) {
    clearInterval(bedsideTimer);
    bedsideTimer = null;
    bedsideFor = '';
    if (navigator.vibrate) navigator.vibrate(0);
    return;
  }
  if (bedsideFor === alert.id) return;
  bedsideFor = alert.id;
  clearInterval(bedsideTimer);
  const pulse = () => {
    beep(alert.kind === 'anomaly' || alert.kind === 'late' ? 'anomaly' : 'doorbell');
    if (navigator.vibrate) navigator.vibrate([180, 120, 180]);
  };
  pulse();
  bedsideTimer = setInterval(pulse, 2800);
}

async function lookNow(button) {
  button.disabled = true;
  await stopLive({ silent: true });
  const box = document.getElementById('live-view');
  if (!box || !window.RTCPeerConnection) {
    if (box) box.replaceChildren(el('p', {}, ['This browser cannot open a live view.']));
    button.disabled = false;
    return;
  }
  const status = el('p', { role: 'status' }, ['Opening the door…']);
  const video = el('video', { class: 'live-view', autoplay: true, playsinline: true, muted: true });
  const stop = el('button', { type: 'button', onclick: () => stopLive() }, ['Stop']);
  box.replaceChildren(status, video, stop);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  liveSession = { pc, timer: null, id: '' };
  pc.ontrack = (event) => {
    const current = video.srcObject instanceof MediaStream ? video.srcObject : new MediaStream();
    if (!current.getTracks().some((track) => track.id === event.track.id)) current.addTrack(event.track);
    video.srcObject = current;
    video.muted = true;
    video.play().catch(() => {});
  };
  pc.addTransceiver('video', { direction: 'recvonly' });
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 4000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const response = await fetch('/api/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription.sdp })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The live view could not start.');
    await pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
    liveSession.id = body.sessionId;
    let left = body.seconds || 30;
    status.textContent = `Live view. ${left} seconds left. It closes to save the doorbell battery.`;
    liveSession.timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        stopLive();
        return;
      }
      status.textContent = `Live view. ${left} seconds left. It closes to save the doorbell battery.`;
    }, 1000);
  } catch (error) {
    status.textContent = error.message || 'The live view could not start. Please try again.';
    button.disabled = false;
    if (liveSession && liveSession.pc) liveSession.pc.close();
    liveSession = null;
  }
}

async function stopLive(options: { silent?: boolean } = {}) {
  const current = liveSession;
  liveSession = null;
  if (!current) return;
  clearInterval(current.timer);
  if (current.pc) current.pc.close();
  if (current.id) {
    await fetch(`/api/live/${current.id}`, { method: 'DELETE' }).catch(() => {});
  }
  if (options.silent) return;
  renderBanner();
  if (!editingForm()) renderMain();
}

function clipBar() {
  const hint = el('p', { class: 'hint', id: 'clip-hint' }, ['Playground has no door recording. Choose an MP4, MOV, or WebM under 40 MB. Use a door view, with the person or parcel in the lower half. CareBell runs a person model, a pose/fall model, a parcel model, and a knock model on this computer. Waiting needs the same person near the door for one minute. It reads the file here and does not send it to Ring.']);
  const picker = el('input', {
    type: 'file',
    accept: 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm',
    id: 'clip-file',
    'aria-describedby': 'clip-hint'
  });
  const status = el('p', { role: 'status' }, ['']);
  const button = el('button', {
    type: 'button',
    class: 'btn-primary',
    onclick: async () => {
      const file = picker.files && picker.files[0];
      if (!file) {
        status.textContent = 'Choose a door recording first.';
        announce('Choose a door recording first.');
        return;
      }
      button.disabled = true;
      status.textContent = 'Looking at the recording…';
      try {
        const body = new FormData();
        body.append('file', file, file.name || 'clip.mp4');
        apply(await request('/api/demo/video', { method: 'POST', body }));
        status.textContent = '';
      } catch (error) {
        status.textContent = error.message || 'CareBell could not read that recording.';
        announce(status.textContent);
      } finally {
        button.disabled = false;
      }
    }
  }, ['Look at this recording']);
  return el('section', { class: 'card' }, [
    el('h2', {}, ['Try a door recording']),
    hint,
    el('label', { class: 'check', for: 'clip-file' }, ['Door recording']),
    picker,
    button,
    status
  ]);
}

function demoBar() {
  const box = el('section', { class: 'card' }, [
    el('h2', {}, ['Try a practice event']),
    el('p', { class: 'hint' }, ['These buttons use the same checks as a real doorbell, so you can see the alert before a token is connected.'])
  ]);
  const row = el('div', { class: 'demo-row' });
  [
    ['doorbell', 'Doorbell pressed'],
    ['person', 'Someone at the door'],
    ['vehicle', 'Car passed'],
    ['package', 'Package at the door'],
    ['fall', 'Someone has fallen'],
    ['loitering', 'Waiting at the door'],
    ['knock', 'Someone knocking'],
    ['anomaly', 'Missed check-in']
  ].forEach(([kind, label]) => {
    row.append(el('button', {
      type: 'button',
      onclick: (event) => simulate(kind, event.currentTarget)
    }, [label]));
  });
  box.append(row);
  return box;
}

async function simulate(kind, button) {
  primeAudio();
  button.disabled = true;
  try {
    apply(await request('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind })
    }));
  } catch {
    announce('The practice event did not go through. Please try again.');
  } finally {
    button.disabled = false;
  }
}

async function acknowledge(id) {
  try {
    apply(await request(`/api/alerts/${id}/ack`, { method: 'POST' }));
  } catch {
    announce('That alert is still open. Please try again.');
  }
}

function quietPanel() {
  const recent = groupEvents(state.today.moments).at(-1);
  const latest = recent
    ? `Latest: ${timeSpan(recent)} ${kindsOf(recent).map((kind) => KIND[kind]).join(', ')}`
    : 'No new activity at the door today.';
  return el('article', { class: 'panel panel-quiet' }, [
    el('p', { class: 'badge' }, ['Quiet']),
    el('h2', { class: 'giant' }, ['The door is quiet']),
    el('p', {}, ['When someone presses the doorbell, this page shows large text and a color that matches the words.']),
    el('p', {}, [latest])
  ]);
}

function clockMinutes(time) {
  const [hour, minute] = String(time || '0:0').split(':').map(Number);
  return (hour * 60) + minute;
}

const CLUSTER_KINDS = new Set(['doorbell', 'person', 'vehicle', 'motion', 'package', 'knock', 'loitering']);
const TAG_ORDER = ['doorbell', 'person', 'vehicle', 'motion', 'anomaly', 'late', 'rule', 'offline', 'online', 'system'];

function groupEvents(rows) {
  const groups = [];
  rows.forEach((event) => {
    const current = groups[groups.length - 1];
    const previous = current && current[current.length - 1];
    const close = previous
      && CLUSTER_KINDS.has(event.kind)
      && CLUSTER_KINDS.has(previous.kind)
      && event.localDate === previous.localDate
      && Math.abs(clockMinutes(event.localTime) - clockMinutes(previous.localTime)) <= 2;
    if (close) current.push(event);
    else groups.push([event]);
  });
  return groups;
}

function kindsOf(events) {
  const present = new Set(events.map((event) => event.kind));
  return TAG_ORDER.filter((kind) => present.has(kind));
}

function timeSpan(events) {
  const sorted = [...events].sort((a, b) => clockMinutes(a.localTime) - clockMinutes(b.localTime));
  const start = sorted[0].localTime;
  const end = sorted[sorted.length - 1].localTime;
  return start === end ? start : `${start}–${end}`;
}

function tagRow(events) {
  return el('p', { class: 'tags' }, kindsOf(events).map((kind) => (
    el('span', { class: `tag tag-${kind}` }, [KIND[kind] || 'Record'])
  )));
}

function photoEvent(events) {
  const photos = events.filter((event) => /\.jpe?g($|\?)/i.test(event.snapshotUrl || ''));
  return photos.find((event) => event.kind === 'person')
    || photos.find((event) => event.kind === 'doorbell')
    || photos[0]
    || null;
}

function renderWatch() {
  const bedside = state.banner && state.settings.bedsideMode && state.banner.level === 'critical';
  const groups = groupEvents(state.today.moments);
  const pieces = [
    bedside ? '' : (state.banner ? renderAlert(state.banner, true) : quietPanel()),
    doorHealth(),
    el('section', { class: 'card' }, [
      el('h2', {}, ['At the door today']),
      groups.length
        ? el('div', {}, groups.map((events) => {
          const named = events.find((event) => event.familiarName);
          const photo = photoEvent(events);
          return el('div', { class: 'moment' }, [
            el('span', { class: 'when' }, [timeSpan(events)]),
            tagRow(events),
            named ? el('h3', { class: 'named' }, [named.title]) : '',
            named && photo ? el('img', { class: 'thumb', src: photo.snapshotUrl, alt: '' }) : ''
          ]);
        }))
        : el('p', {}, ['Nothing new today. Yesterday is in the family log.'])
    ]),
    clipBar(),
    state.mode === 'live' ? '' : demoBar()
  ];
  return pieces;
}

function doorHealth() {
  if (!state || state.mode !== 'live') return '';
  const door = state.door || {};
  const choices = door.choices || [];
  const picker = choices.length > 1
    ? el('fieldset', {}, [
      el('legend', {}, ['Which door to watch']),
      ...choices.map((choice) => {
        const input = el('input', { type: 'radio', name: 'watched-door', value: choice.key });
        input.checked = Boolean(choice.watching);
        input.addEventListener('change', () => chooseDoor(choice.key));
        return el('label', { class: 'check' }, [input, choice.name]);
      })
    ])
    : '';
  return el('section', { class: 'card' }, [
    el('h2', {}, ['Door health']),
    el('p', { class: 'health-line', role: 'status' }, [
      door.line || (state.playground && state.playground.error) || 'Checking the doorbell…'
    ]),
    door.motion ? el('p', { class: 'health-line' }, [door.motion]) : '',
    picker
  ]);
}

async function chooseDoor(key) {
  try {
    apply(await request('/api/door', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    }));
    announce('CareBell is watching that door.');
  } catch (error) {
    announce(error.message || 'That door was not selected.');
  }
}

function speakButton(text) {
  const button = el('button', { type: 'button', class: 'btn-primary' }, ['Read this aloud']);
  if (!window.speechSynthesis) {
    button.disabled = true;
    button.textContent = 'This device cannot speak';
    return button;
  }
  button.addEventListener('click', () => {
    if (speechSynthesis.speaking) {
      speechSynthesis.cancel();
      button.textContent = 'Read this aloud';
      button.setAttribute('aria-pressed', 'false');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    const voice = speechSynthesis.getVoices().find((item) => /^en(-|_)US/i.test(item.lang));
    if (voice) utterance.voice = voice;
    utterance.onend = () => {
      button.textContent = 'Read this aloud';
      button.setAttribute('aria-pressed', 'false');
    };
    button.textContent = 'Stop';
    button.setAttribute('aria-pressed', 'true');
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
  return button;
}

function renderListen() {
  const source = state.today.source === 'bedrock' ? 'Rewritten with AI.' : 'Written from the door record.';
  return [
    el('section', { class: 'card', 'aria-live': 'polite' }, [
      el('h2', {}, [state.today.label]),
      el('p', { class: 'summary' }, [state.today.summary]),
      el('p', { class: 'meta' }, [source]),
      speakButton(state.today.summary),
      clipBlock(latestClipEvent(state.today.moments))
    ]),
    el('section', { class: 'card' }, [
      el('h2', {}, [state.yesterday.label]),
      state.yesterday.sample ? el('p', { class: 'meta' }, ['This is a sample, so you can see what a peace-of-mind report looks like.']) : '',
      el('p', { class: 'summary' }, [state.yesterday.summary]),
      speakButton(state.yesterday.summary),
      clipBlock([...state.log].find((event) => event.localDate === state.yesterday.date && ['doorbell', 'person'].includes(event.kind)))
    ])
  ];
}

function renderLog() {
  const days = ['all', state.today.date, state.yesterday.date];
  const dayLabels = { all: 'All days', [state.today.date]: 'Today', [state.yesterday.date]: 'Yesterday' };
  const kinds = [['all', 'All'], ['doorbell', 'Doorbell'], ['person', 'Person'], ['vehicle', 'Vehicle'], ['motion', 'Motion'], ['package', 'Package'], ['knock', 'Knock'], ['loitering', 'Waiting'], ['fall', 'Fall'], ['anomaly', 'Alert'], ['late', 'Late'], ['rule', 'Rule']];
  const filters = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filter the log' });
  days.forEach((day) => {
    filters.append(el('button', {
      type: 'button',
      'aria-pressed': logDay === day ? 'true' : 'false',
      onclick: () => { logDay = day; renderMain(); }
    }, [dayLabels[day]]));
  });
  kinds.forEach(([kind, label]) => {
    filters.append(el('button', {
      type: 'button',
      'aria-pressed': logKind === kind ? 'true' : 'false',
      onclick: () => { logKind = kind; renderMain(); }
    }, [label]));
  });
  const rows = state.log.filter((event) => {
    if (logDay !== 'all' && event.localDate !== logDay) return false;
    if (logKind === 'all') return true;
    return event.kind === logKind;
  });
  const list = el('div', {});
  if (!rows.length) {
    list.append(el('p', {}, ['No records match. Doorbell and door activity show up here for the family.']));
  }
  let shownDate = '';
  groupEvents(rows).forEach((events) => {
    const lead = events[0];
    if (logDay === 'all' && lead.localDate !== shownDate) {
      shownDate = lead.localDate;
      const dayName = lead.localDate === state.today.date
        ? 'Today'
        : (lead.localDate === state.yesterday.date ? 'Yesterday' : lead.localDate);
      list.append(el('h3', { class: 'day-head' }, [dayName]));
    }
    const span = timeSpan(events);
    const kinds = kindsOf(events);
    const photo = photoEvent(events);
    const clipSource = events.find((event) => event.clipUrl)
      || events.find((event) => ['doorbell', 'person'].includes(event.kind));
    const alone = events.length === 1 && !CLUSTER_KINDS.has(lead.kind);
    const named = events.find((event) => event.familiarName);
    const item = el('article', {
      class: 'log-item',
      'aria-label': `${span}. ${kinds.map((kind) => KIND[kind] || 'Record').join(', ')}.`
    });
    if (photo) item.append(el('img', { class: 'thumb', src: photo.snapshotUrl, alt: '' }));
    const notes = [];
    if (events.some((event) => event.sample)) notes.push('Sample');
    if (events.some((event) => event.notified)) notes.push('Alerted');
    const text = el('div', {}, [
      el('p', {}, [el('span', { class: 'when' }, [span])]),
      tagRow(events),
      named ? el('h3', {}, [named.title]) : (alone ? el('h3', {}, [lead.title]) : ''),
      named ? el('p', {}, [named.detail]) : (alone ? el('p', {}, [lead.detail]) : ''),
      clipBlock(clipSource),
      photo ? el('button', { type: 'button', onclick: () => rememberPerson(photo) }, ['This is someone I know']) : '',
      notes.length ? el('p', { class: 'meta' }, [notes.join(' · ')]) : ''
    ]);
    item.append(text);
    list.append(item);
  });
  return [el('section', {}, [el('h2', {}, ['The family door log']), filters, list])];
}

function renderCare() {
  const settings = state.settings;
  const form = el('form', { class: 'stack' });
  form.append(el('fieldset', {}, [
    el('legend', {}, ['Household names']),
    labeled('Door name', 'deviceName', settings.deviceName, 'text'),
    labeled('Emergency contact', 'emergencyName', settings.emergencyName, 'text')
  ]));
  const checks = el('fieldset', {}, [el('legend', {}, ['Which events should alert'])]);
  [
    ['doorbell', 'Someone pressed the doorbell'],
    ['person', 'Someone at the door'],
    ['vehicle', 'A car passed'],
    ['motion', 'Small movement at the door'],
    ['package', 'A package left at the door'],
    ['fall', 'Someone may have fallen'],
    ['loitering', 'Someone waiting at the door'],
    ['knock', 'Someone knocking at the door']
  ].forEach(([key, label]) => {
    const box = el('input', { type: 'checkbox', name: key, checked: settings.alerts[key] ? 'checked' : null });
    if (settings.alerts[key]) box.checked = true;
    checks.append(el('label', { class: 'check' }, [box, label]));
  });
  form.append(checks);
  const morning = el('fieldset', {}, [
    el('legend', {}, ['Morning check-in']),
    el('p', { class: 'hint', id: 'check-hint' }, ['After this time, if the door has been quiet, CareBell tells the emergency contact and includes the latest saved picture.'])
  ]);
  const timeLabel = el('label', { for: 'checkInBy' }, ['Latest time for activity']);
  const time = el('input', { id: 'checkInBy', name: 'checkInBy', type: 'time', value: settings.checkInBy, 'aria-describedby': 'check-hint' });
  const anomaly = el('input', { type: 'checkbox', name: 'anomalyEnabled' });
  anomaly.checked = settings.anomalyEnabled;
  const chime = el('input', { type: 'checkbox', name: 'playChime' });
  chime.checked = settings.playChimeOnDoorbell;
  morning.append(timeLabel, time, el('label', { class: 'check' }, [anomaly, 'Alert if there is no activity by this time']), el('label', { class: 'check' }, [chime, 'Play a sound when someone presses the doorbell']));
  form.append(morning);
  const routine = el('fieldset', {}, [
    el('legend', {}, ['Usual door times']),
    el('p', { class: 'hint' }, ['A person before the leave time counts as leaving. A person after the home time counts as arriving home.'])
  ]);
  const leaveLabel = el('label', { for: 'leaveBy' }, ['Leaves by']);
  const leave = el('input', { id: 'leaveBy', name: 'leaveBy', type: 'time', value: settings.leaveBy || '08:15' });
  const homeLabel = el('label', { for: 'homeBy' }, ['Usually home by']);
  const home = el('input', { id: 'homeBy', name: 'homeBy', type: 'time', value: settings.homeBy || '18:30' });
  const late = el('input', { type: 'checkbox', name: 'lateHomeEnabled' });
  late.checked = settings.lateHomeEnabled !== false;
  const bedside = el('input', { type: 'checkbox', name: 'bedsideMode' });
  bedside.checked = settings.bedsideMode !== false;
  routine.append(
    leaveLabel,
    leave,
    homeLabel,
    home,
    el('label', { class: 'check' }, [late, 'Alert if nobody is home by this time']),
    el('label', { class: 'check' }, [bedside, 'Bedside mode: full-screen words, a flashing border, and a repeating sound until you tap I have seen this'])
  );
  form.append(routine);
  form.append(el('p', { class: 'hint' }, [state.chimeNote]));
  form.append(el('p', { class: 'hint' }, ['When the doorbell saved a recording, CareBell reads frames from that clip on this computer. It runs a person model, a pose/fall model, a parcel model, and a knock model here. Waiting needs the same person near the door for one minute. It does not name a stranger, and it does not listen for a knock.']));
  form.append(el('button', { type: 'submit', class: 'btn-primary' }, ['Save care settings']));
  const status = el('p', { id: 'status', role: 'status' }, ['']);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      apply(await request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceName: data.get('deviceName'),
          emergencyName: data.get('emergencyName'),
          checkInBy: data.get('checkInBy'),
          leaveBy: data.get('leaveBy'),
          homeBy: data.get('homeBy'),
          anomalyEnabled: anomaly.checked,
          lateHomeEnabled: late.checked,
          bedsideMode: bedside.checked,
          playChimeOnDoorbell: chime.checked,
          alerts: {
            doorbell: form.elements.doorbell.checked,
            person: form.elements.person.checked,
            vehicle: form.elements.vehicle.checked,
            motion: form.elements.motion.checked,
            package: form.elements.package.checked,
            fall: form.elements.fall.checked,
            loitering: form.elements.loitering.checked,
            knock: form.elements.knock.checked
          }
        })
      }));
      document.getElementById('status').textContent = 'Saved.';
    } catch {
      status.textContent = 'Settings were not saved. Please try again.';
    }
  });
  const tools = el('div', { class: 'actions' }, [
    state.mode === 'live' ? '' : el('button', { type: 'button', onclick: restoreSample }, ['Restore the sample day']),
    el('button', { type: 'button', class: 'btn-danger', onclick: openDelete }, ['Delete door records'])
  ]);
  return [
    chimeCard(),
    rulesCard(),
    ringAppCard(),
    playgroundCard(),
    el('section', {}, [
      el('h2', {}, ['Care settings']),
      el('p', { class: 'hint' }, ['Choose which events should alert. Unselected events stay in the family log.']),
      form,
      status,
      tools
    ]),
    state.mode === 'live' ? '' : demoBar()
  ];
}

const RULE_DAYS = [['every', 'Every day'], ['weekdays', 'Weekdays'], ['weekends', 'Weekends']];
const RULE_KINDS = [
  ['by', 'By this time, if this has not happened'],
  ['between', 'Between these times, when this happens'],
  ['stay', 'If someone keeps appearing for several minutes']
];
const RULE_WHAT = [
  ['doorbell', 'Someone pressed the doorbell'],
  ['person', 'Someone at the door'],
  ['familiar', 'A familiar person'],
  ['vehicle', 'A car passed'],
  ['motion', 'Movement at the door'],
  ['activity', 'Any activity at the door']
];
const RULE_ACTIONS = [
  ['alert', 'Show an alert'],
  ['contact', 'Show an alert and tell the emergency contact']
];
const RULE_PRESETS = [
  ['Quiet by 10:00', { kind: 'by', time: '10:00', end: '10:00', days: 'every', condition: 'activity', action: 'contact' }],
  ['Doorbell after 21:00', { kind: 'between', time: '21:00', end: '07:00', days: 'every', condition: 'doorbell', action: 'alert' }],
  ['Familiar person by 18:30 on weekdays', { kind: 'by', time: '18:30', end: '18:30', days: 'weekdays', condition: 'familiar', action: 'contact' }],
  ['Someone stays 3 minutes', { kind: 'stay', minutes: 3, days: 'every', condition: 'person', action: 'alert' }]
];

function ruleSelect(id, label, value, options) {
  const select = el('select', { id, name: id });
  options.forEach(([key, text]) => {
    const option = el('option', { value: key }, [text]);
    if (key === value) option.selected = true;
    select.append(option);
  });
  return el('div', {}, [el('label', { for: id }, [label]), select]);
}

function readRuleForm(form) {
  return {
    kind: form.elements['rule-kind'].value,
    time: form.elements['rule-time'].value,
    end: form.elements['rule-end'].value,
    days: form.elements['rule-days'].value,
    condition: form.elements['rule-what'].value,
    action: form.elements['rule-then'].value,
    minutes: form.elements['rule-minutes'].value
  };
}

function fillRuleForm(form, rule) {
  const fields = {
    'rule-kind': 'kind',
    'rule-time': 'time',
    'rule-end': 'end',
    'rule-days': 'days',
    'rule-what': 'condition',
    'rule-then': 'action',
    'rule-minutes': 'minutes'
  };
  Object.entries(fields).forEach(([name, key]) => {
    if (form.elements[name] && rule[key]) form.elements[name].value = rule[key];
  });
  showRuleRows(form);
}

function rulesCard() {
  const saved = (state.settings && state.settings.rules) || [];
  const list = el('div', { class: 'stack' });
  if (!saved.length) list.append(el('p', {}, ['No custom rules yet.']));
  saved.forEach((rule) => {
    list.append(el('article', { class: 'log-item' }, [
      el('div', {}, [
        el('p', {}, [rule.sentence]),
        el('button', { type: 'button', onclick: () => removeRule(rule.id) }, ['Remove this rule'])
      ])
    ]));
  });
  const form = el('form', { class: 'stack' });
  const endRow = el('div', { 'data-end-row': 'true' }, [
    el('label', { for: 'rule-end' }, ['Until']),
    el('input', { id: 'rule-end', name: 'rule-end', type: 'time', value: '07:00' })
  ]);
  const minuteRow = el('div', { 'data-minute-row': 'true' }, [
    el('label', { for: 'rule-minutes' }, ['Minutes at the door']),
    el('input', { id: 'rule-minutes', name: 'rule-minutes', type: 'number', min: '1', max: '60', value: '3' }),
    el('p', { class: 'hint' }, ['CareBell compares the door photos Ring already saved. A person you named can be recognized. A stranger is not named.'])
  ]);
  endRow.hidden = true;
  minuteRow.hidden = true;
  const kind = ruleSelect('rule-kind', 'When', 'by', RULE_KINDS);
  kind.querySelector('select').addEventListener('change', () => showRuleRows(form));
  form.append(
    el('p', { class: 'hint' }, ['A rule is only these choices. It can watch the door and alert. It cannot change lights, locks, or the doorbell itself.']),
    ruleSelect('rule-days', 'Which days', 'every', RULE_DAYS),
    kind,
    ruleTimeField(),
    endRow,
    minuteRow,
    ruleSelect('rule-what', 'What at the door', 'activity', RULE_WHAT),
    ruleSelect('rule-then', 'What CareBell should do', 'alert', RULE_ACTIONS)
  );
  const presets = el('div', { class: 'actions' });
  RULE_PRESETS.forEach(([label, rule]) => {
    presets.append(el('button', { type: 'button', onclick: () => fillRuleForm(form, rule) }, [label]));
  });
  const sentence = el('input', { id: 'rule-sentence', name: 'rule-sentence', type: 'text', maxlength: '240', autocomplete: 'off' });
  const status = el('p', { id: 'rule-status', role: 'status' }, ['']);
  form.append(
    presets,
    el('label', { for: 'rule-sentence' }, ['Or describe a rule']),
    sentence,
    el('p', { class: 'hint' }, [
      'A written rule is saved only when it names a time and something at the door. Anything else is refused.'
    ]),
    el('div', { class: 'actions' }, [
      el('button', { type: 'submit', class: 'btn-primary' }, ['Add this rule']),
      state.gemini ? el('button', { type: 'button', onclick: () => suggestRule(form, sentence, status) }, ['Fill the choices']) : ''
    ]),
    status
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveRule(form, status);
  });
  return el('section', { class: 'card' }, [
    el('h2', {}, ['Alert rules']),
    list,
    form
  ]);
}

function showRuleRows(form) {
  const kind = form.elements['rule-kind'] ? form.elements['rule-kind'].value : 'by';
  const end = form.querySelector('[data-end-row]');
  const minutes = form.querySelector('[data-minute-row]');
  const time = form.querySelector('[data-time-row]');
  if (end) end.hidden = kind !== 'between';
  if (minutes) minutes.hidden = kind !== 'stay';
  if (time) time.hidden = kind === 'stay';
}

function ruleTimeField() {
  return el('div', { 'data-time-row': 'true' }, [
    el('label', { for: 'rule-time' }, ['Time']),
    el('input', { id: 'rule-time', name: 'rule-time', type: 'time', value: '10:00' })
  ]);
}

async function saveRule(form, status) {
  const text = form.elements['rule-sentence'] ? form.elements['rule-sentence'].value.trim() : '';
  const body = text ? { text } : readRuleForm(form);
  status.textContent = text ? 'Checking that rule…' : '';
  try {
    apply(await request('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }));
    renderMain();
    const next = document.getElementById('rule-status');
    if (next) next.textContent = 'Rule saved.';
  } catch (error) {
    status.textContent = error.message || 'That rule was not saved.';
  }
}

async function suggestRule(form, sentence, status) {
  if (!sentence.value.trim()) {
    status.textContent = 'Describe the time and what should alert.';
    return;
  }
  status.textContent = 'Reading that sentence…';
  try {
    const result = await request('/api/rules/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sentence.value.trim() })
    });
    fillRuleForm(form, result.rule);
    status.textContent = result.sentence;
  } catch (error) {
    status.textContent = error.message || 'Gemini could not fill the form. Build the rule from the choices.';
  }
}

async function removeRule(id) {
  try {
    apply(await request(`/api/rules/${id}`, { method: 'DELETE' }));
    renderMain();
  } catch {
    announce('That rule is still saved. Please try again.');
  }
}

function chimeCard() {
  if (!state || state.mode !== 'live' || !state.chimeLine) return '';
  return el('section', { class: 'card' }, [
    el('h2', {}, ['Chime']),
    el('p', { class: 'health-line', role: 'status' }, [state.chimeLine]),
    el('p', { class: 'hint' }, ['Snooze is set in the Ring app. CareBell reads it before anyone rings.'])
  ]);
}

function ringAppCard() {
  const app = state.ringApp || {};
  if (!app.configured) return '';
  const linked = state.playground && state.playground.source === 'ring';
  return el('section', { class: 'card' }, [
    el('h2', {}, ['Ring app']),
    el('p', { class: 'hint' }, [
      linked
        ? 'This CareBell account is linked to Ring. Door events, photos, live view, and the Chime use that connection.'
        : 'Credentials for ring-care are saved on this server. In the Ring developer portal, set these paths on your public HTTPS address, then open CareBell from the Ring app and sign in.'
    ]),
    el('p', {}, [`Token exchange: ${app.tokenExchange}`]),
    el('p', {}, [`Account link: ${app.accountLink}`]),
    el('p', {}, [`Webhook: ${app.webhook}`]),
    el('p', { class: 'hint' }, ['Cameras, doorbells, livestream, video download, and Chime playback are the scopes this app uses. Sensor events are accepted and kept out of the door log.'])
  ]);
}

function playgroundCard() {
  const playground = state.playground || {};
  const status = el('p', { id: 'playground-status', role: 'status' }, [
    playground.error
      ? playground.error
      : playground.connected && playground.source === 'ring'
        ? `Connected${playground.deviceName ? ` to ${playground.deviceName}` : ''} through your Ring account. The connection stays on this server.`
        : playground.connected
          ? `Connected${playground.deviceName ? ` to ${playground.deviceName}` : ''}. The token stays on this server and is not shown again. It lasts about 30 minutes.`
          : 'Not connected. Generate a token in the Ring Playground, then paste it here.'
  ]);
  const token = el('input', {
    id: 'playground-token',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'playground-help'
  });
  const connect = el('button', { type: 'button', class: 'btn-primary', onclick: () => connectPlayground(token, connect) }, ['Connect']);
  const disconnect = el('button', { type: 'button', onclick: disconnectPlayground }, ['Disconnect']);
  return el('section', { class: 'card' }, [
    el('h2', {}, ['Ring Playground']),
    el('p', { id: 'playground-help', class: 'hint' }, [
      'Open the Ring Developer Playground, choose Generate Token, and paste it here. CareBell calls Ring from this computer. The browser never talks to Ring directly.'
    ]),
    el('p', {}, [
      el('a', { href: 'https://developer.amazon.com/ring/console/playground', target: '_blank', rel: 'noopener noreferrer' }, ['Open the Ring Playground'])
    ]),
    el('label', { for: 'playground-token' }, ['Playground access token']),
    token,
    el('div', { class: 'actions' }, [connect, playground.connected && playground.source !== 'env' ? disconnect : '']),
    status
  ]);
}

async function connectPlayground(input, button) {
  button.disabled = true;
  try {
    apply(await request('/api/playground', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: input.value.trim() })
    }));
    renderMain();
    announce('Playground connected.');
  } catch {
    const status = document.getElementById('playground-status');
    if (status) status.textContent = 'Ring did not accept that token. Generate a new one in the Playground.';
  } finally {
    button.disabled = false;
  }
}

async function disconnectPlayground() {
  try {
    apply(await request('/api/playground', { method: 'DELETE' }));
    renderMain();
    announce('Playground disconnected.');
  } catch {
    announce('Could not disconnect. Please try again.');
  }
}

function editingForm() {
  return (view === 'care' || view === 'people') && Boolean(content.querySelector('form'));
}

function renderPeople() {
  const people = state.people || [];
  const list = el('div', { class: 'stack' });
  if (!people.length) list.append(el('p', {}, ['No familiar people yet. Add a JPEG, or label a door photo from the family log.']));
  people.forEach((person) => {
    list.append(el('article', { class: 'log-item' }, [
      person.photoUrl ? el('img', { class: 'thumb', src: person.photoUrl, alt: '' }) : '',
      el('div', {}, [
        el('h3', {}, [person.name]),
        el('p', {}, [person.relationship]),
        el('button', { type: 'button', onclick: () => removePerson(person.id) }, ['Remove this person'])
      ])
    ]));
  });
  const name = el('input', { id: 'person-name', name: 'name', type: 'text', autocomplete: 'off', required: true });
  const relation = el('input', { id: 'person-relation', name: 'relationship', type: 'text', list: 'relations', value: 'Daughter' });
  const options = ['Daughter', 'Son', 'Partner', 'Caregiver', 'Neighbor', 'Friend', 'Family'];
  const listBox = el('datalist', { id: 'relations' }, options.map((option) => el('option', { value: option })));
  const file = el('input', { id: 'person-photo', name: 'photo', type: 'file', accept: 'image/jpeg', required: true });
  const status = el('p', { id: 'people-status', role: 'status' }, ['']);
  const form = el('form', { class: 'stack card' }, [
    el('h2', {}, ['Add a person']),
    el('p', { class: 'hint' }, ['Use the latest photo Ring already saved, or choose a JPEG from the door. Photos stay on this computer.']),
    el('label', { for: 'person-name' }, ['Name']),
    name,
    el('label', { for: 'person-relation' }, ['Relationship']),
    relation,
    listBox,
    el('label', { for: 'person-photo' }, ['JPEG photo']),
    file,
    el('div', { class: 'actions' }, [
      el('button', { type: 'submit', class: 'btn-primary' }, ['Add this person']),
      el('button', { type: 'button', onclick: () => useRingPhoto(name, relation, status) }, ['Use the latest Ring photo'])
    ]),
    status
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    savePerson(name, relation, file, status);
  });
  return [
    el('section', { class: 'card' }, [
      el('h2', {}, ['Familiar people']),
      el('p', { class: 'hint' }, ['Ring reports a person and sends the photo. Ring does not return a name. You choose the name. A later photo that looks like this one is titled with that name, for example “Mia is at the door.”']),
      list
    ]),
    form
  ];
}

async function useRingPhoto(name, relation, status) {
  if (!name.value.trim()) {
    status.textContent = 'Enter the person’s name.';
    return;
  }
  status.textContent = 'Asking Ring for the latest door photo…';
  try {
    apply(await request('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.value.trim(), relationship: relation.value.trim(), source: 'ring' })
    }));
    renderMain();
    const next = document.getElementById('people-status');
    if (next) next.textContent = 'Saved from the Ring door photo.';
  } catch (error) {
    status.textContent = error.message || 'Ring did not return a photo.';
  }
}

async function savePerson(name, relation, file, status) {
  if (!name.value.trim()) {
    status.textContent = 'Enter the person’s name.';
    return;
  }
  if (!file.files || !file.files[0]) {
    status.textContent = 'Choose a JPEG photo, or label one from the family log.';
    return;
  }
  const image = await readJpeg(file.files[0]);
  if (!image) {
    status.textContent = 'Use a JPEG photo.';
    return;
  }
  try {
    apply(await request('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.value.trim(), relationship: relation.value.trim(), image })
    }));
    renderMain();
    const next = document.getElementById('people-status');
    if (next) next.textContent = 'Saved. A matching door photo will use this name.';
  } catch (error) {
    status.textContent = error.message || 'That person was not saved.';
  }
}

function readJpeg(file) {
  return new Promise((resolve) => {
    if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) {
      resolve('');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

function rememberPerson(event) {
  const name = el('input', { id: 'remember-name', type: 'text' });
  const relation = el('input', { id: 'remember-relation', type: 'text', value: 'Daughter' });
  const dialog = el('dialog', {}, [
    el('h2', {}, ['Who is in this photo?']),
    el('p', {}, ['Ring sent this photo. Ring does not return a name. A later photo that looks like this one is titled with the name you choose, for example “Mia is at the door.” The person is saved on the People page.']),
    el('label', { for: 'remember-name' }, ['Name']),
    name,
    el('label', { for: 'remember-relation' }, ['Relationship']),
    relation,
    el('div', { class: 'actions' }, [
      el('button', {
        type: 'button',
        class: 'btn-primary',
        onclick: async () => {
          try {
            apply(await request('/api/people', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: name.value.trim(), relationship: relation.value.trim(), eventId: event.id })
            }));
            dialog.close();
            announce(`${name.value.trim()} will be recognized from similar door photos.`);
          } catch (error) {
            announce(error.message || 'That person was not saved.');
          }
        }
      }, ['Save']),
      el('button', { type: 'button', onclick: () => dialog.close() }, ['Cancel'])
    ])
  ]);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  name.focus();
}

async function removePerson(id) {
  try {
    apply(await request(`/api/people/${id}`, { method: 'DELETE' }));
    renderMain();
  } catch {
    announce('That person is still saved. Please try again.');
  }
}

function labeled(text, name, value, type) {
  const id = `field-${name}`;
  return el('div', {}, [
    el('label', { for: id }, [text]),
    el('input', { id, name, type, value, autocomplete: 'off' })
  ]);
}

async function restoreSample() {
  try {
    apply(await request('/api/sample', { method: 'POST' }));
    const status = document.getElementById('status');
    if (status) status.textContent = 'The sample day is back in the log.';
  } catch {
    announce('The sample day was not restored. Please try again.');
  }
}

function openDelete() {
  const dialog = el('dialog', {}, [
    el('h2', {}, ['Delete the household door records?']),
    el('p', {}, ['Pictures, alerts, and peace-of-mind reports are deleted. Care settings stay.']),
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn-danger', onclick: confirmDelete }, ['Delete']),
      el('button', { type: 'button', onclick: () => dialog.close() }, ['Keep them'])
    ])
  ]);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

async function confirmDelete() {
  const dialog = document.querySelector('dialog');
  try {
    apply(await request('/api/household-data', { method: 'DELETE' }));
    if (dialog) dialog.close();
    announce('Door records deleted.');
  } catch {
    announce('Nothing was deleted. Please try again.');
  }
}

function renderMain() {
  const views = { watch: renderWatch, listen: renderListen, log: renderLog, people: renderPeople, care: renderCare };
  content.replaceChildren(...(views[view] || renderListen)());
  if (!state || !state.banner || view !== 'watch' || scrolledFor === state.banner.id) return;
  scrolledFor = state.banner.id;
  const panel = content.querySelector('.panel');
  if (panel) panel.scrollIntoView({ block: 'start' });
}

function showView(next) {
  view = next;
  localStorage.setItem('carebell-view', next);
  renderChrome();
  renderBanner();
  renderMain();
  content.focus();
}

function showIntro() {
  if (localStorage.getItem('carebell-intro')) return;
  const dialog = el('dialog', {}, [
    el('h2', {}, ['Door events, in words the household can use']),
    el('p', {}, ['Door: large text and color when someone presses the bell.']),
    el('p', {}, ['Today: one sentence about the day, which can be read aloud.']),
    el('p', {}, ['People: name familiar people from a door photo, and remove them.']),
    el('p', {}, ['Care: choose which events alert, set a morning check-in time, and paste a Ring Playground token.']),
    el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn-primary', onclick: () => finishIntro(dialog) }, ['Start']),
      el('button', { type: 'button', onclick: () => finishIntro(dialog) }, ['Skip'])
    ])
  ]);
  document.body.append(dialog);
  dialog.showModal();
}

function finishIntro(dialog) {
  localStorage.setItem('carebell-intro', '1');
  dialog.close();
  dialog.remove();
}

function setSize(size) {
  document.body.dataset.size = size;
  localStorage.setItem('carebell-size', size);
  document.getElementById('size-standard').setAttribute('aria-pressed', size === 'standard' ? 'true' : 'false');
  document.getElementById('size-large').setAttribute('aria-pressed', size === 'large' ? 'true' : 'false');
}

document.getElementById('size-standard').addEventListener('click', () => setSize('standard'));
document.getElementById('size-large').addEventListener('click', () => setSize('large'));
document.body.addEventListener('pointerdown', primeAudio, { once: true });
setSize(localStorage.getItem('carebell-size') || 'large');

function startApp(data) {
  apply(data);
  showIntro();
  const stream = new EventSource('/api/stream');
  stream.onmessage = (event) => apply(JSON.parse(event.data));
  stream.onerror = () => { document.getElementById('mode').textContent = 'Reconnecting…'; };
}

function showAuth() {
  document.getElementById('sign-out').hidden = true;
  nav.replaceChildren();
  document.getElementById('mode').textContent = 'Sign in to watch the door.';
  const name = el('input', { id: 'account-name', type: 'text', autocomplete: 'name' });
  const email = el('input', { id: 'account-email', type: 'email', autocomplete: 'username' });
  const password = el('input', { id: 'account-password', type: 'password', autocomplete: 'current-password' });
  const status = el('p', { id: 'auth-status', role: 'status' }, ['']);
  const form = el('form', { class: 'stack card' }, [
    el('h2', {}, ['Your CareBell account']),
    el('p', { class: 'hint' }, ['Create an account on this computer. The first account keeps the door history already stored here.']),
    el('label', { for: 'account-name' }, ['Your name']),
    name,
    el('label', { for: 'account-email' }, ['Email']),
    email,
    el('label', { for: 'account-password' }, ['Password']),
    password,
    el('div', { class: 'actions' }, [
      el('button', { type: 'submit', class: 'btn-primary' }, ['Create account']),
      el('button', { type: 'button', onclick: () => submitAuth('/api/login', name, email, password, status) }, ['Sign in'])
    ]),
    status
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuth('/api/register', name, email, password, status);
  });
  content.replaceChildren(form);
}

async function submitAuth(url, name, email, password, status) {
  status.textContent = '';
  try {
    const data = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.value, email: email.value, password: password.value })
    });
    startApp(data);
  } catch (error) {
    status.textContent = error.message || 'Please try again.';
  }
}

document.getElementById('sign-out').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.reload();
});

request('/api/state').then(startApp).catch((error) => {
  if (error.status === 401) showAuth();
  else content.replaceChildren(el('p', {}, ['The door record could not be opened. Make sure CareBell is running.']));
});
