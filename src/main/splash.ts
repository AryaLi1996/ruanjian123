/**
 * Minimal splash window shown immediately on launch (Ticket 38).
 *
 * Root cause of the "first launch looks frozen" report: the main
 * BrowserWindow is created with `show:false` and only becomes visible once
 * its renderer bundle has loaded *and* 'ready-to-show' fires (or the 5s
 * fallback in index.ts elapses) — see createWindow() in index.ts. On a cold
 * first launch (disk cache empty, OS code-signature verification still
 * running, subscription-monitor's network calls, etc.) that gap is exactly
 * where users see nothing at all and assume the app is dead.
 *
 * This window has zero dependency on the renderer bundle, IPC, or any
 * userData/network state — it's a static, inlined data: URL — so it paints
 * within a frame or two of app.whenReady() regardless of what else is slow.
 * index.ts closes it as soon as the real window is ready to show (or the
 * same 5s fallback elapses), so it's never left on screen forever.
 */
import { BrowserWindow } from 'electron'

const SPLASH_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: #0f1117;
    display: flex; align-items: center; justify-content: center;
    -webkit-user-select: none; user-select: none;
    font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .spin {
    width: 34px; height: 34px;
    border-radius: 50%;
    border: 3px solid rgba(0, 229, 160, 0.18);
    border-top-color: #00E5A0;
    animation: rotate 0.9s linear infinite;
  }
  @keyframes rotate { to { transform: rotate(360deg); } }
  .brand { font-size: 15px; letter-spacing: 0.04em; color: rgba(255,255,255,0.92); }
  .label { font-size: 12px; color: rgba(255,255,255,0.5); }
</style>
</head>
<body>
  <div class="wrap">
    <svg width="56" height="56" viewBox="0 0 512 512" role="img" aria-label="SootheVoice">
      <path d="M256,86 C302,108 334,176 326,246 C320,300 296,344 258,370 C230,348 210,306 208,246 C206,182 222,120 256,86 Z"
        fill="#FFFFFF" fill-opacity="0.10" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="4" stroke-linejoin="round" />
      <path d="M258,368 C250,388 240,406 230,426" fill="none" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="4" stroke-linecap="round" />
      <g fill="#00E5A0">
        <rect x="218.5" y="215" width="7" height="26" rx="3.5" />
        <rect x="230.5" y="205" width="7" height="46" rx="3.5" />
        <rect x="242.5" y="194" width="7" height="68" rx="3.5" />
        <rect x="254.5" y="182" width="7" height="92" rx="3.5" />
        <rect x="266.5" y="194" width="7" height="68" rx="3.5" />
        <rect x="278.5" y="205" width="7" height="46" rx="3.5" />
        <rect x="290.5" y="215" width="7" height="26" rx="3.5" />
      </g>
    </svg>
    <div class="spin"></div>
    <div class="brand">舒音 SootheVoice</div>
    <div class="label">正在启动… / Starting…</div>
  </div>
</body>
</html>`

/**
 * Creates and immediately shows the splash window. `show:true` (rather than
 * the ready-to-show dance createWindow() uses) is deliberate: this content
 * is a local data: URL with no external requests, so there is no meaningful
 * "not ready yet" flash to guard against — showing later would only widen
 * the exact gap this window exists to close.
 */
export function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width:           320,
    height:          320,
    frame:           false,
    resizable:       false,
    movable:         false,
    minimizable:     false,
    maximizable:     false,
    fullscreenable:  false,
    center:          true,
    show:            true,
    backgroundColor: '#0f1117',
    alwaysOnTop:     true,
    skipTaskbar:     false,
    webPreferences: {
      sandbox: true,
    },
  })
  splash.setMenuBarVisibility(false)
  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`)
  return splash
}

/** Closes the splash window if it hasn't already been closed/destroyed. */
export function closeSplashWindow(splash: BrowserWindow | null): void {
  if (splash && !splash.isDestroyed()) splash.close()
}
