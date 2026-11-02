const UNITS = ['KiB', 'MiB', 'GiB'] as const;

/** Human-readable size in binary units, e.g. `512 B`, `1.5 KiB`, `5 MiB` (like the API's messages). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes;
  let unit: string = UNITS[0];
  for (const candidate of UNITS) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) {
      break;
    }
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${unit}`;
}

/** Lower-case extension including the dot (`.md`), or `''` when the name has none. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot).toLowerCase() : '';
}

/** `1 document`, `2 documents` – English plural for counts shown in the UI. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
