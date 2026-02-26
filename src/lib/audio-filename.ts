/** Parse recording timestamp from filename like `2MM21799_20260119_193500.wav` */
export function parseRecordingTimestamp(filename: string): {
  date: string;
  time: string;
} | null {
  const match = filename.match(
    /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\./
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}:${s}` };
}
