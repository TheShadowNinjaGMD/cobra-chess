# Third-party components in Cobra

## Chess engine — Stockfish 18 (WebAssembly lite + pure-JavaScript builds)
Files: `engine/stockfish.js`, `engine/stockfish.wasm`, `engine/stockfish-asm.embed.js`
Author: Nathan Rugg and the Stockfish authors — https://github.com/nmrugg/stockfish.js
(built on https://github.com/official-stockfish/Stockfish)
License: GNU GPL v3.0 (`engine/COPYING-GPLv3.txt`).

## Rules engine — chess.js
File: `lib/chess-bundle.js` — Jeff Hlywa, MIT — https://github.com/jhlywa/chess.js

## Piece sets — lichess.org (`pieces/`)
From https://github.com/lichess-org/lila (`public/piece`); licences per lila's COPYING.md.
- Free licences (GPL, MIT, Apache 2.0, CC0, CC BY, AGPL) — e.g. cburnett (Colin M.L. Burnett, GPL v2+),
  merida (GPL v2+), chessnut (Apache 2.0), fantasy (MIT).
- Sets marked "NC" in the app's Style panel are CC BY-NC-SA 4.0: personal,
  non-commercial use only. Attribution is by each set's artist as listed in lila's COPYING.md.
- Lichess sets that are not freely licensed (alpha, chess7, companion, leipzig,
  reillycraig, riohacha, shahi-ivory-brown) are not included.

## Sounds
- `sounds/cobra/` — audio files supplied by the project owner.
- `sounds/sfx`, `piano`, `nes`, `futuristic` — from lila (`public/sound`), AGPL-3.0 or later.
  Lichess's non-free packs (standard, robot, woodland) are not included.

## Original work
The UI, layout, review grading, bot personas and all CSS/JS glue are original to this project.

## Icons
`icons/` — move-quality badges and settings icon supplied by the project owner; the Cobra mark (`icons/cobra.svg`) is original to this project.
