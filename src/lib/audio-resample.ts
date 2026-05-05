/**
 * Resamples an audio file to a target sample rate and returns a blob URL of the
 * resulting WAV. Used to work around wavesurfer.js spectrogram plugin bug where
 * `frequencyMax` only affects labels, not the data render — by lowering the
 * Nyquist we crop the spectrogram to the band of interest.
 */
export async function resampleAudioToWavBlobUrl(
  sourceUrl: string,
  targetSampleRate: number,
): Promise<string> {
  const response = await fetch(sourceUrl);
  const arrayBuffer = await response.arrayBuffer();

  const decodeCtx = new AudioContext();
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  await decodeCtx.close();

  const targetLength = Math.ceil(decoded.duration * targetSampleRate);
  const offlineCtx = new OfflineAudioContext(1, targetLength, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const resampled = await offlineCtx.startRendering();

  const wavBlob = encodeWav(resampled);
  return URL.createObjectURL(wavBlob);
}

function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;

  const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = headerSize;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
