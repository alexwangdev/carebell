const fileInput = document.getElementById('clip-file') as HTMLInputElement;
const mediaName = document.getElementById('media-name') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLElement;
const preview = document.getElementById('preview') as HTMLElement;
const run = document.getElementById('run') as HTMLButtonElement;
const tokenInput = document.getElementById('playground-token') as HTMLInputElement;
const connectBtn = document.getElementById('playground-connect') as HTMLButtonElement;
const disconnectBtn = document.getElementById('playground-disconnect') as HTMLButtonElement;
const playgroundStatus = document.getElementById('playground-status') as HTMLElement;
const link = document.getElementById('page-link');
if (link) link.innerHTML = 'Page address: <code>' + window.location.origin + '/opencv</code>';

function playgroundLine(body: any): string {
  const playground = (body && body.playground) || {};
  if (playground.error) return playground.error;
  if (playground.connected && playground.source === 'ring') {
    return `Connected${playground.deviceName ? ` to ${playground.deviceName}` : ''} through your Ring account.`;
  }
  if (playground.connected) {
    return `Connected${playground.deviceName ? ` to ${playground.deviceName}` : ''}. The token stays on this server and is not shown again.`;
  }
  return 'Not connected. Generate a token in the Ring Playground, then paste it here.';
}

function showPlayground(body: any) {
  const playground = (body && body.playground) || {};
  playgroundStatus.textContent = playgroundLine(body);
  disconnectBtn.hidden = !(playground.connected && playground.source !== 'env');
}

async function loadPlayground() {
  try {
    const response = await fetch('/api/state');
    if (response.status === 401) {
      playgroundStatus.textContent = 'Sign in on CareBell first, then come back to this page.';
      disconnectBtn.hidden = true;
      return;
    }
    if (!response.ok) throw new Error('Could not read Playground status.');
    showPlayground(await response.json());
  } catch {
    playgroundStatus.textContent = 'Could not read Playground status.';
    disconnectBtn.hidden = true;
  }
}

connectBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    playgroundStatus.textContent = 'Paste a Playground token first.';
    return;
  }
  connectBtn.disabled = true;
  playgroundStatus.textContent = 'Connecting…';
  try {
    const response = await fetch('/api/playground', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const body = await response.json().catch(() => ({}));
    tokenInput.value = '';
    if (response.status === 401 && /sign in/i.test(body.error || '')) {
      playgroundStatus.textContent = 'Sign in on CareBell first, then come back to this page.';
      disconnectBtn.hidden = true;
      return;
    }
    if (!response.ok) {
      playgroundStatus.textContent = body.error || 'Ring did not accept that token. Generate a new one in the Playground.';
      disconnectBtn.hidden = true;
      return;
    }
    showPlayground(body);
  } catch {
    playgroundStatus.textContent = 'Ring did not accept that token. Generate a new one in the Playground.';
  } finally {
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  try {
    const response = await fetch('/api/playground', { method: 'DELETE' });
    if (response.status === 401) {
      playgroundStatus.textContent = 'Sign in on CareBell first, then come back to this page.';
      disconnectBtn.hidden = true;
      return;
    }
    if (!response.ok) throw new Error('Could not disconnect.');
    showPlayground(await response.json());
  } catch {
    playgroundStatus.textContent = 'Could not disconnect. Please try again.';
  } finally {
    disconnectBtn.disabled = false;
  }
});

loadPlayground();

function showPreview(file: File) {
  preview.replaceChildren();
  if (!file) return;
  if (/^image\//.test(file.type)) {
    const img = document.createElement('img');
    img.className = 'shot';
    img.alt = '';
    img.src = URL.createObjectURL(file);
    preview.append(img);
    return;
  }
  const video = document.createElement('video');
  video.className = 'clip';
  video.controls = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(file);
  preview.append(video);
}

fileInput.addEventListener('change', () => showPreview(fileInput.files && fileInput.files[0]));

run.addEventListener('click', async () => {
  run.disabled = true;
  statusEl.textContent = 'Looking at the file…';
  try {
    const file = fileInput.files && fileInput.files[0];
    const name = mediaName.value.trim();
    let response;
    if (file) {
      const body = new FormData();
      body.append('file', file, file.name || 'clip.mp4');
      response = await fetch('/api/demo/vision', { method: 'POST', body });
    } else if (name) {
      response = await fetch('/api/demo/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media: name })
      });
    } else {
      statusEl.textContent = 'Choose a door recording or type a file name in data/media.';
      run.disabled = false;
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      statusEl.textContent = 'Sign in on CareBell first, then come back to this page.';
      return;
    }
    if (!response.ok) throw new Error(body.error || 'CareBell could not read that file.');
    const seen = body.seen || body.banner || {};
    statusEl.textContent = seen.title
      ? (seen.title + '. The family log has this alert.')
      : 'CareBell saved the result. Open Door to see it.';
    if (seen.snapshotUrl || seen.clipUrl) {
      preview.replaceChildren();
      if (seen.snapshotUrl) {
        const img = document.createElement('img');
        img.className = 'shot';
        img.alt = '';
        img.src = seen.snapshotUrl;
        preview.append(img);
      }
      if (seen.clipUrl) {
        const video = document.createElement('video');
        video.className = 'clip';
        video.controls = true;
        video.playsInline = true;
        video.autoplay = true;
        video.muted = true;
        video.src = seen.clipUrl;
        preview.append(video);
      }
    }
  } catch (error) {
    statusEl.textContent = error.message || 'CareBell could not read that file.';
  } finally {
    run.disabled = false;
  }
});
