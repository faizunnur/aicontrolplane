import path from "node:path";

/**
 * Where Google Chrome is usually installed, per platform. Pure (no config, no database), so the
 * helper that runs on the user's own computer can use the same list as the server.
 */
export function chromeInstallCandidates(): string[] {
  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA ?? "";
    return [path.join(pf, "Google", "Chrome", "Application", "chrome.exe"), path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"), ...(local ? [path.join(local, "Google", "Chrome", "Application", "chrome.exe")] : [])];
  }
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", path.join(process.env.HOME ?? "", "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")];
  return ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}
