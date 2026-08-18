// MS2109 outputs 1080P 30FPS over MJPEG. When bandwidth is limited (for example
// behind a USB hub) it may only manage 25FPS, so fall back to that.
const MODE_LIST = [
  { width: 1920, height: 1080, frameRate: 30 },
  { width: 1920, height: 1080, frameRate: 25 },
] as const;

export type VideoMode = (typeof MODE_LIST)[number];

// On Windows the device reports mono 16bit 96kHz, but actually sends
// interleaved stereo 48kHz: one sample left, then one right, alternating.
// On Linux the kernel/PulseAudio already de-interleaves it into real stereo
// ("USB Video Analog Stereo"), in which case it must be passed through as-is.
const INTERLEAVED_SAMPLE_RATE = 96_000;

/**
 * De-interleave one block of the mono stream into a left and a right channel.
 *
 * The device sends alternating samples of the two channels at twice the frame
 * rate, so each sample is written twice: the Web Audio API cannot resample here,
 * and duplicating keeps the block duration identical.
 *
 * NOTE: this maps `input[i]` to the RIGHT channel, which is what the original
 * implementation did, but the opposite of what README.md describes. Swap the two
 * if the channels come out reversed on Windows.
 *
 * Exported so it can be unit tested; it is embedded into the worklet below via
 * `toString()`, so it must not reference anything outside its own body.
 */
export function deinterleave(
  input: Float32Array,
  leftOutput: Float32Array,
  rightOutput: Float32Array,
): void {
  // `i + 1` keeps a truncated block from reading past the end, which would
  // write NaN (an audible click) instead of a sample
  let i = 0;
  while (i + 1 < input.length) {
    leftOutput[i] = input[i + 1];
    leftOutput[i + 1] = input[i + 1];

    rightOutput[i] = input[i];
    rightOutput[i + 1] = input[i];

    i += 2;
  }
}

// Assigned to a local name inside the worklet so minified renaming of the
// function above cannot break the call below
const SPLIT_PROCESSOR_SOURCE = `
const deinterleave = ${deinterleave.toString()};

class SplitProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0][0];
    const leftOutput = outputs[0][0];
    const rightOutput = outputs[0][1];

    // No input yet, or the output is not stereo after all
    if (!input || !leftOutput || !rightOutput) {
      return true;
    }

    deinterleave(input, leftOutput, rightOutput);
    return true;
  }
}

registerProcessor('split-processor', SplitProcessor);
`;

export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export async function startVideo(
  deviceId: string,
): Promise<{ stream: MediaStream; mode: VideoMode }> {
  let lastError: unknown;

  for (const mode of MODE_LIST) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { exact: mode.width },
          height: { exact: mode.height },
          frameRate: { exact: mode.frameRate },
        },
      });
      return { stream, mode };
    } catch (error) {
      // Try the next (lower) frame rate
      lastError = error;
    }
  }

  throw new Error('No supported 1080P mode', { cause: lastError });
}

export interface AudioSession {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  /** `split` de-interleaves a mono stream, `stereo` passes it through. */
  readonly layout: 'split' | 'stereo';
  readonly sampleRate: number;
  readonly channelCount: number;
}

/**
 * Chrome creates an AudioContext in the `suspended` state until the page has
 * seen a user gesture, which silences audio that starts on page load. Resume
 * right away if allowed, otherwise on the first click or key press.
 */
/**
 * Chrome creates an AudioContext in the `suspended` state until the page has
 * seen a user gesture, which silences audio that starts on page load. Resume
 * right away if allowed, otherwise on the first click or key press.
 */
async function resumeWhenAllowed(context: AudioContext): Promise<void> {
  try {
    await context.resume();
  } catch {
    // Not allowed yet, fall through to waiting for a gesture
  }
  if (context.state === 'running') {
    return;
  }

  const events = ['pointerdown', 'keydown'] as const;
  const resume = (): void => {
    for (const type of events) {
      window.removeEventListener(type, resume);
    }
    void context.resume();
  };
  for (const type of events) {
    window.addEventListener(type, resume, { passive: true });
  }
}

export interface AudioSession {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  /** `split` de-interleaves a mono stream, `stereo` passes it through. */
  readonly layout: 'split' | 'stereo';
  readonly sampleRate: number;
  readonly channelCount: number;
  /**
   * Held only so the graph is not garbage collected: a
   * MediaStreamAudioSourceNode that nothing references can be collected, which
   * silences the output while the graph still looks healthy.
   */
  readonly nodes: AudioNode[];
  /** Current signal level as RMS, 0 to 1. */
  readonly level: () => number;
}

function attachMeter(
  context: AudioContext,
  source: AudioNode,
): { analyser: AnalyserNode; level: () => number } {
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  // A tap only: deliberately not connected to the destination
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  const level = (): number => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      sum += sample * sample;
    }
    return Math.sqrt(sum / samples.length);
  };

  return { analyser, level };
}

export async function startAudio(deviceId: string): Promise<AudioSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      // This is a raw capture feed, not a voice call. Chrome turns all three on
      // by default, which resamples and downmixes the stream.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  // Start at the device's own rate and read the channel count off the graph:
  // `getSettings()` does not always report it, and guessing wrong is destructive.
  let context = new AudioContext();
  let source = context.createMediaStreamSource(stream);
  const channelCount =
    stream.getAudioTracks()[0]?.getSettings().channelCount ?? source.channelCount;

  try {
    // Already real stereo (Linux de-interleaves in the kernel): pass it through
    if (channelCount >= 2) {
      source.connect(context.destination);
      const { analyser, level } = attachMeter(context, source);
      await resumeWhenAllowed(context);
      return {
        stream,
        context,
        layout: 'stereo',
        sampleRate: context.sampleRate,
        channelCount,
        nodes: [source, analyser],
        level,
      };
    }

    // Mono interleaved: the split has to run at the doubled rate
    await context.close();
    context = new AudioContext({ sampleRate: INTERLEAVED_SAMPLE_RATE });
    source = context.createMediaStreamSource(stream);

    await context.audioWorklet.addModule(
      'data:application/javascript;charset=utf8,' +
        encodeURIComponent(SPLIT_PROCESSOR_SOURCE),
    );

    const processor = new AudioWorkletNode(context, 'split-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      // The input is a single interleaved channel that the processor splits in
      // two, so the output channel count has to be requested explicitly
      outputChannelCount: [2],
    });

    source.connect(processor);
    processor.connect(context.destination);
    const { analyser, level } = attachMeter(context, source);
    await resumeWhenAllowed(context);

    return {
      stream,
      context,
      layout: 'split',
      sampleRate: context.sampleRate,
      channelCount,
      nodes: [source, processor, analyser],
      level,
    };
  } catch (error) {
    stopStream(stream);
    await context.close();
    throw error;
  }
}

export function stopAudio(session: AudioSession): void {
  stopStream(session.stream);
  for (const node of session.nodes) {
    node.disconnect();
  }
  void session.context.close();
}
