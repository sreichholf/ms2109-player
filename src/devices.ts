export interface PickDeviceOptions {
  /** Currently selected deviceId, kept if that device is still connected. */
  current?: string;
  /** Prefer a device belonging to this group (same physical device). */
  preferredGroupId?: string;
  /** Prefer a device whose label starts with one of these (case insensitive). */
  preferredLabels?: string[];
  /** Fall back to the first device when nothing above matched. */
  fallbackToFirst?: boolean;
}

/**
 * Pick the device to pre-select, in order of confidence: the current device if
 * it is still connected, then the same physical device as `preferredGroupId`,
 * then a known label, then optionally just the first one.
 */
export function pickDevice(
  devices: MediaDeviceInfo[],
  options: PickDeviceOptions = {},
): MediaDeviceInfo | undefined {
  const {
    current,
    preferredGroupId,
    preferredLabels = [],
    fallbackToFirst = true,
  } = options;

  if (current) {
    const kept = devices.find((device) => device.deviceId === current);
    if (kept) {
      return kept;
    }
  }

  // The MS2109 reports one groupId for its video and audio input, so this pairs
  // audio with the selected video device even if the labels differ
  if (preferredGroupId) {
    const sameDevice = devices.find(
      (device) => device.groupId === preferredGroupId,
    );
    if (sameDevice) {
      return sameDevice;
    }
  }

  for (const label of preferredLabels) {
    const preferred = devices.find((device) =>
      device.label.toLowerCase().startsWith(label.toLowerCase()),
    );
    if (preferred) {
      return preferred;
    }
  }

  return fallbackToFirst ? devices[0] : undefined;
}
