# Squidify design system — v1

Mobile is the primary interaction target; desktop retains keyboard navigation, search, sidebar, queue and volume controls.

- **Type:** locally bundled Bricolage Grotesque 700 for headings; 800 with −0.05em tracking (−50/1000 em) for the logo. System UI sans serif for body and controls.
- **Color:** ink backgrounds; mint #0eedb5 for primary actions, the squid mark and wordmark; violet #ae00ff within iridescent artwork. High-contrast neutral text. No wordmark period. The squid head has pointed side fins rather than rounded cheeks.
- **Controls:** filled mint for commit/play actions; outlined neutral for secondary actions; borderless quiet buttons for contextual actions; ghost icons for utilities; muted red for destructive actions. Focus indicators remain visible. Touch targets normally 44px; dense playlist overflow and output indicators keep a 44px vertical hit area.
- **Motion:** No wave wipes anywhere. Modules rise 26px with a subtle scale and blur reveal over 650ms and 38ms stagger (capped at 304ms). The player opens over 580ms with a 7px overshoot and settles; dismissal continues from the actual rendered drag position over 360ms with an ease-out curve. Dragging and dismissal share one transform; the sheet stays opaque and the backdrop fades from its current opacity. The final offscreen transform remains set until the dialog is hidden. Repeated dismissals cannot restart the animation. Incomplete gestures settle back smoothly. Reduced-motion settings remove these animations. Playback never waits on motion.
- **Layers:** fixed app shell with an independently scrolling content area; mini-player above bottom navigation; dialogs and noninteractive top-edge toasts in the top layer.
- **Artwork:** generated folding gradients by default; optional square photo covers compressed to JPEG at up to 1024px. Photos and audio share IndexedDB and the browser quota. Album updates are atomic.
- **Import feedback:** retain successfully committed audio; separate duplicate, unsupported, unreadable, timed-out and quota outcomes. Add music → Import results shows file-level details for the latest import in this session.
- **Audio:** Media Session uses the active playlist cover, otherwise track art or the app icon. Equalizer bands are derived from FFT windows of decoded audio without routing playback through Web Audio; files over 40MB or 15 minutes, unsupported decoders and decode failures use a quiet baseline. Bluetooth/output controls use browser capabilities, never infer an active Bluetooth route from a paired-device list.

## Mobile polish

- The equalizer remains a continuous cubic Bézier contour with a mint-to-violet stroke, translucent gradient fill and restrained glow. Eighteen fixed frequency bands feed six separated, narrow Bézier hotspots with baseline valleys at the current playback position, with fast attack and smooth release; the curve does not scroll in time. Hidden canvases are cleared without resizing to zero, and the full player redraws after opening. It sits at 22px immediately right of mini-player Play; in the full player it remains at the bottom edge and is horizontally bounded by the Bluetooth and queue controls.
- The mini-player uses an unsquashed 44px output button in place of Next. Headphone icons are green only when an exposed selected-output label identifies headphones; unknown routes retain the Bluetooth glyph. Full-player skip controls and skip gestures remain available.
- All overflow menus use vertical dots. Dialogs initially focus a neutral heading or the dialog; keyboard focus indications remain available on interactive controls. Touch-only devices do not retain hover backgrounds.
- Mobile search animates its height and opacity on both entry and exit, preserving Safari rebound protection.
- Apple touch icons are provided both as explicit metadata and at conventional root paths, alongside the manifest icons and favicon fallback.
- Click delegation matches explicit controls rather than arbitrary ancestors carrying `data-view`, so native form submissions work even when the body identifies the current view.

## Device verification remaining

Physical iPhone Safari and Home Screen testing: whole-screen gestures, search scroll reveal, keyboard layout, toast placement, background playback, lock-screen art, and OS audio output chooser. Automated tests do not substitute for this coverage.

- Collection Play controls toggle the active collection queue and reflect audio play/pause events. Starting another collection creates its queue; pausing never restarts the current song.
- The brand mark is about 40% larger, with tightened spacing to the wordmark. The mini-player has a restored thin gradient hairline. Song rows use padded, rounded cell surfaces over a stationary swipe-to-queue underlay.
