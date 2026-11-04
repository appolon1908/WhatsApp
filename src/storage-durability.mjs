import fs from "node:fs/promises";

export async function syncDirectory(directory) {
  // Node cannot flush directory handles on Windows. File contents are still
  // fsynced by callers; this does not promise power-loss-safe directory entries.
  if (process.platform === "win32") return false;
  const folder = await fs.open(directory, "r");
  try {
    await folder.sync();
    return true;
  } finally {
    await folder.close();
  }
}
