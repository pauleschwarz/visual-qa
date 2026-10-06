import { access } from "node:fs/promises";

/** True when something exists at `path` (file or folder). */
export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A string as a file-name part: anything but letters, digits, `.`, `_`, `-` becomes `_`, at most the last 100 characters. */
export function safeName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(-100);
}
