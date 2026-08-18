# Web Player for MacroSilicon MS2109 Capture Cards

I recently bought a cheap (65CNY/~10USD) capture card with MS2109 chip to play Switch games on my monitor without an HDMI switch (no pun intended).

## Hardware ID

|  VID  |  PID  |  REV  |
| :---: | :---: | :---: |
| 534d  | 2109  | 2100  |

## Spec

| Key                  | Value                   |
| -------------------- | ----------------------- |
| Video Input          | 4K 30FPS / 1080P 60FPS  |
| Video Output (MJPEG) | 1080P 30FPS             |
| Video Output (YUY2)  | 1080P 5FPS / 720P 10FPS |
| Audio Output (LPCM)  | Mono 16bit 96kHz        |

Notes:

1. Some device claims 1080P 60FPS output support but that's fake. When selected, they still output at 30FPS.
2. When connected to a USB hub, 1080P 30FPS mode may display a black screen (maybe due to insufficient bandwidth). Lower resolution or frame rate (for example 1080P 25FPS) may be used instead.
3. The audio output is actually stereo 16bit 48kHz interleaved (1 sample for left channel, then 1 sample for right channel, alternating).

## Use with OBS

1. Every time you remove and re-plug the device, you must re-select the "Device" in each source (or re-create all sources).
2. If 1080P 30FPS MJPEG doesn't work (black screen), try 25FPS or another USB port. Set "Resolution" to "Highest FPS" won't work either.
3. "Audio Output Mode" option in "Video Capture Device" can be very laggy, to reduce lag:
   1. Add an "Audio Input Capture" source
   2. Set "Device" to "Digital Audio Interface (*X*- USB Digital Audio)" (where *X* may be any number)
   3. Open "Edit" -> "Advanced Audio Properties" menu, set "Audio Monitoring" to "Monitor Only" or "Monitor and Output" (depends on your usage)
4. If you want to use YUY2 (high quality, low FPS) but can't find it in "Video Format", first set "FPS" to "Highest FPS" or 720P 10FPS, now you should see it.
5. For stereo audio: (source: https://www.youtube.com/watch?v=R4SXJMNywL4&lc=Ugwu3DawGg791wTcold4AaABAg)
    * Linux: Linux kernel has a patch to do this automatically.
    * Windows: https://github.com/ToadKing/mono-to-stereo
    * macOS: https://github.com/kunichiko/MS2109-mono-to-stereo-mac
    * I didn't test the above two, but they should replace "Audio Output Mode" or "Audio Input Capture" in 2.

## Use with Web Player

Or you can use this web player:

* No need to install OBS
* No need to reconfigure after every reconnect: devices are re-detected on plug/unplug
* Low CPU usage
* Automatically detects the highest working frame rate (30FPS, falling back to 25FPS)
* Converts the interleaved mono audio to stereo, when the OS doesn't already do it
* Picker for the video and audio input, so any capture card can be used, not just the MS2109

However

* It only supports 1080P resolution
* It only supports MJPEG format
* It needs a secure context, so `https://` or `localhost`. On a plain HTTP origin the browser does not expose `navigator.mediaDevices` at all and nothing can work.
* Only tested on Chromium based browsers. The mono to stereo `split` path has not been re-tested on Windows since the rewrite.

### Usage

Hover the dot in the top left corner to reveal the controls: a video input picker, an audio input picker and a status line.

Inputs whose label starts with `USB Video` are pre-selected, and the audio input is paired to the video input by `groupId` (the MS2109 reports one group for both), so the card is normally picked up without touching anything. Any other device can be selected manually.

The status line reports the negotiated video mode, the audio path and a live input level:

```
1920x1080 30FPS · audio stereo 2ch 48000Hz   ▄ -22dB
```

* `stereo`: the OS already de-interleaves the audio (the Linux kernel does), so it is passed through untouched
* `split`: the stream arrives as mono and is de-interleaved in an `AudioWorkletProcessor`
* The level meter is the quickest way to tell a hung capture card (`silent`) from an output routing problem (level moves but nothing is audible)

The `split` processor maps the first sample of each pair to the **right** channel, which is the opposite of note 3 under [Spec](#spec). Only the `stereo` path has been verified, so if the channels come out swapped, swap them in `deinterleave()` in `src/capture.ts`.

### Development

Vanilla TypeScript and [Vite](https://vite.dev/), no runtime dependencies. Needs Node.js and [pnpm](https://pnpm.io/).

```sh
pnpm install
pnpm dev        # dev server on http://localhost:5173
pnpm build      # production build into dist/
pnpm preview    # serve the production build
pnpm typecheck  # tsc --noEmit
```

`dist/` references its assets relatively, so it can be uploaded to any path on a static host (as long as it is served over HTTPS).

There is no linter: `typescript-eslint` does not support TypeScript 7 yet, so `tsc` is the only static check.
