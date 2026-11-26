# Cobra — an offline chess app with a local bot

Play against Cobra, an on-device Stockfish 18 bot, with a live evaluation
bar, hints, takebacks, right-click arrows, post-game review, and PGN/FEN
import. No account, no server, no network calls once the page is open.

## Running it

Open `index.html` — it works straight from disk. Two Stockfish 18 builds ship
with the app and the page picks the best one that works:

| Build | Files | Notes |
|---|---|---|
| WebAssembly (Lite, single-thread) | `engine/stockfish.js`, `engine/stockfish.wasm` | Fastest. Browsers only allow it over `http://`. |
| JavaScript (asm.js) | `engine/stockfish-asm.embed.js` | Slower, runs anywhere including `file://`. |

Settings → Chess engine lets you force either (default: Automatic). For the
strongest play, serve the folder locally:

```bash
cd cobra
python3 -m http.server 8000     # then open http://localhost:8000
```

## Features

- Cobra difficulty slider, levels 1–20 (about 400–2600 Elo), on the game
  panel and on Cobra's card.
- Fischer clocks, click or drag to move, premoves (Esc or right-click cancels),
  promotion picker, move navigation, flip board.
- Eval bar toggle, hints (3 per game), takebacks (3 per game).
- Right-click drag draws arrows (Shift green, Ctrl red, Alt yellow); moving a
  piece or left-clicking outside the board clears them.
- Analysis: paste or upload a PGN with moves, then grade every move
  (Brilliant … Blunder) with accuracy per side. FEN positions can be loaded
  to play against the bot.
- 34 Lichess piece sets, board colours, light/dark theme.
- Sound packs: Cobra (your own files in `sounds/cobra/`), Lichess SFX, Piano,
  NES, Futuristic, or synthesized.
- Everything is saved in `localStorage`.

## Files

- `index.html`, `styles.css`, `app.js` — the app (vanilla JS, no build step).
- `lib/chess-bundle.js` — chess.js. `engine/` — Stockfish builds + licence.
- `pieces/`, `sounds/` — assets. `LICENSES.md` — attribution.

## Shortcuts
←/→ step, Home/End jump, F flip, H hint, U take back, [ ] previous/next key moment, ? list.

Analysis shows an evaluation graph (click to jump) and key-moment navigation.

## Publishing
`./push-to-github.sh [repo] [--private|--public]`
