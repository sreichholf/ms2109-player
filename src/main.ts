import './style.css';
import {
  startAudio,
  startVideo,
  stopAudio,
  stopStream,
  type AudioSession,
} from './capture';
import { pickDevice } from './devices';

// The MS2109 enumerates as "USB Video" (video input) and "USB Video Analog
// Stereo" (audio input), so one prefix covers both. Prefer it when present so
// the player starts on the capture card without touching the picker.
const PREFERRED_LABELS = ['USB Video'];

const video = document.querySelector<HTMLVideoElement>('#video')!;
const videoSelect = document.querySelector<HTMLSelectElement>('#video-device')!;
const audioSelect = document.querySelector<HTMLSelectElement>('#audio-device')!;
const statusElement = document.querySelector<HTMLElement>('#status')!;
const levelElement = document.querySelector<HTMLElement>('#level')!;

let videoStream: MediaStream | undefined;
let audioSession: AudioSession | undefined;
let microphoneAllowed = false;
let levelTimer: number | undefined;

function setStatus(message: string): void {
  statusElement.textContent = message;
}

// `enumerateDevices` only reports device labels once permission has been
// granted, and only `getUserMedia` can trigger the permission prompt. Camera and
// microphone are asked for separately, because a combined request is rejected as
// a whole if either one is blocked, which leaves the other's labels empty.
async function requestPermission(
  constraints: MediaStreamConstraints,
): Promise<boolean> {
  try {
    stopStream(await navigator.mediaDevices.getUserMedia(constraints));
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function fillSelect(
  select: HTMLSelectElement,
  devices: MediaDeviceInfo[],
  options: { preferredGroupId?: string; noneLabel?: string } = {},
): void {
  const previous = select.value;

  select.replaceChildren();
  if (options.noneLabel !== undefined) {
    select.append(new Option(options.noneLabel, ''));
  }
  for (const [index, device] of devices.entries()) {
    select.append(new Option(device.label || `Device ${index + 1}`, device.deviceId));
  }

  select.value =
    pickDevice(devices, {
      current: previous,
      preferredGroupId: options.preferredGroupId,
      preferredLabels: PREFERRED_LABELS,
      // With a "None" entry present, leave the selection empty unless something
      // matched, rather than grabbing an unrelated microphone
      fallbackToFirst: options.noneLabel === undefined,
    })?.deviceId ??
    select.options[0]?.value ??
    '';
}

async function refreshDevices(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((device) => device.kind === 'videoinput');
  const audioInputs = devices.filter((device) => device.kind === 'audioinput');

  fillSelect(videoSelect, videoInputs);

  // The MS2109 reports one groupId for both of its inputs, so this pairs audio
  // with whichever video device is selected
  const selectedVideo = videoInputs.find(
    (device) => device.deviceId === videoSelect.value,
  );
  fillSelect(audioSelect, audioInputs, {
    preferredGroupId: selectedVideo?.groupId,
    noneLabel: 'None',
  });
}

const METER_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];

function startMeter(session: AudioSession): void {
  levelTimer = window.setInterval(() => {
    const rms = session.level();
    if (rms <= 0) {
      levelElement.textContent = 'silent';
      return;
    }
    const db = 20 * Math.log10(rms);
    // -60dB..0dB across the bars
    const step = Math.min(
      METER_BARS.length - 1,
      Math.max(0, Math.round(((db + 60) / 60) * (METER_BARS.length - 1))),
    );
    levelElement.textContent = `${METER_BARS[step]} ${db.toFixed(0)}dB`;
  }, 200);
}

function stopMeter(): void {
  if (levelTimer !== undefined) {
    clearInterval(levelTimer);
    levelTimer = undefined;
  }
  levelElement.textContent = '';
}

function stopCapture(): void {
  stopMeter();
  if (videoStream) {
    stopStream(videoStream);
    videoStream = undefined;
  }
  video.srcObject = null;

  if (audioSession) {
    stopAudio(audioSession);
    audioSession = undefined;
  }
}

async function restart(): Promise<void> {
  stopCapture();

  const videoDeviceId = videoSelect.value;
  if (!videoDeviceId) {
    setStatus('No video input found');
    return;
  }

  let status: string;
  try {
    const started = await startVideo(videoDeviceId);
    videoStream = started.stream;
    video.srcObject = started.stream;
    status = `${started.mode.width}x${started.mode.height} ${started.mode.frameRate}FPS`;
  } catch (error) {
    console.error(error);
    setStatus('No supported 1080P mode on this device');
    return;
  }

  const audioDeviceId = audioSelect.value;
  if (audioDeviceId) {
    try {
      audioSession = await startAudio(audioDeviceId);
      status += ` · audio ${audioSession.layout} ${audioSession.channelCount}ch ${audioSession.sampleRate}Hz`;
      if (audioSession.context.state !== 'running') {
        status += ` (${audioSession.context.state}, click to start)`;
      }
      startMeter(audioSession);
    } catch (error) {
      console.error(error);
      status += ' · audio unavailable';
    }
  } else if (!microphoneAllowed) {
    status += ' · microphone blocked';
  }

  setStatus(status);
}

videoSelect.addEventListener('change', () => void restart());
audioSelect.addEventListener('change', () => void restart());

// `navigator.mediaDevices` only exists in a secure context, so on a plain HTTP
// origin there is nothing to talk to. Say so instead of failing silently.
if (!navigator.mediaDevices) {
  setStatus('Requires HTTPS (or localhost)');
} else {
  // Re-enumerate on plug/unplug, and reconnect if the selected device changed
  navigator.mediaDevices.addEventListener('devicechange', () =>
    void (async () => {
      const previousVideo = videoSelect.value;
      const previousAudio = audioSelect.value;

      await refreshDevices();

      if (videoSelect.value !== previousVideo || audioSelect.value !== previousAudio) {
        await restart();
      }
    })(),
  );

  setStatus('Starting…');

  const cameraAllowed = await requestPermission({ video: true });
  microphoneAllowed = await requestPermission({ audio: true });

  if (!cameraAllowed) {
    setStatus('Camera permission is required');
  }

  await refreshDevices();
  await restart();
}
