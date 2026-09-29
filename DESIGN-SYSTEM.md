# Squidify design system — v1

Mobile is the primary interaction target; desktop retains keyboard navigation, search, sidebar, queue and volume controls.

- **Type:** locally bundled Bricolage Grotesque 700 for headings; 800 with −0.05em tracking (−50/1000 em) for the logo. System UI sans serif for body and controls.
- **Color:** ink backgrounds; mint #0eedb5 for primary actions and active states; violet #ae00ff within iridescent artwork and transitions. High-contrast neutral text.
- **Controls:** filled mint for commit/play actions; outlined neutral for secondary actions; borderless quiet buttons for contextual actions; ghost icons for utilities; muted red for destructive actions. Focus indicators remain visible. Touch targets normally 44px; dense playlist overflow and output indicators keep a 44px vertical hit area.
- **Motion:** 540ms shallow wave with full coverage at the swap; entrances begin after it clears. No bottom-navigation wipes. Repeated actions within 750ms skip the wash. Playback never waits on motion. Reduced-motion settings remove washes and animated entrances.
- **Layers:** fixed app shell with an independently scrolling content area; mini-player above bottom navigation; dialogs and noninteractive top-edge toasts in the top layer.
- **Artwork:** generated folding gradients by default; optional square photo covers compressed to JPEG at up to 1024px. Photos and audio share IndexedDB and the browser quota. Album updates are atomic.
- **Import feedback:** retain successfully committed audio; separate duplicate, unsupported, unreadable, timed-out and quota outcomes. Add music → Import results shows file-level details for the latest import in this session.
- **Audio:** Media Session uses the active playlist cover, otherwise track art or the app icon. Waveforms are derived from decoded audio without routing playback through Web Audio; files over 40MB or 15 minutes, unsupported decoders and decode failures use a quiet baseline. Bluetooth/output controls use browser capabilities, never infer an active Bluetooth route from a paired-device list.

## Device verification remaining

Physical iPhone Safari and Home Screen testing: whole-screen gestures, search scroll reveal, keyboard layout, toast placement, background playback, lock-screen art, and OS audio output chooser. Automated tests do not substitute for this coverage.
