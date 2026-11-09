# Web Memory

Save the exact text you found online, with its source. Search it later in plain words. Everything stays on your device.

## Install (Chrome, Edge, Brave)

1. Unzip this folder.
2. Open `chrome://extensions` (`brave://extensions` in Brave) and turn on Developer mode.
3. Click Load unpacked and pick the `web-memory` folder.

## Use

- Select text on a page, then press `Alt+Shift+S`, or right-click and choose Save to Web Memory.
- Selecting text closes the popup, so select first, then use the shortcut, right-click menu, or open the popup and click Save selection.
- Open the popup on a page you've saved from and an On this page section appears first. Click Highlight on page and your saved passages are marked in the page itself.
- Click the toolbar icon to search. Every word you type must match the text, note, title, tags or URL.
- Add a note or tags with Add note or tags. Click a tag to filter.
- Clicking a clip's title opens the page and highlights the passage you saved (works in Chrome and Edge).
- Turn on Resurface in the popup footer to get one older clip as a notification each day.
- Change the shortcut at `chrome://extensions/shortcuts` (`brave://extensions/shortcuts` in Brave).
- Export and Import give you a JSON backup.

## Files

| File | Job |
| --- | --- |
| `manifest.json` | Permissions, shortcut, popup |
| `background.js` | Shortcut and right-click saving, daily resurfacing |
| `lib.js` | Storage, keyword search, text-fragment links, on-page highlighting |
| `popup.html`, `popup.css`, `popup.js` | Search, notes, tags, On this page, import and export |
| `fonts/` | Newsreader and Instrument Sans (SIL OFL), bundled so nothing loads remotely |

## Next steps

- Full-page library view for long browsing sessions
- Firefox build (needs a `browser_specific_settings` entry and a background script fallback)
- Optional local semantic search once the library is big enough to need it

## License

MIT. See `LICENSE`. The fonts in `fonts/` are Newsreader and Instrument Sans, licensed under the SIL Open Font License.
