# Checkmate Speedrun

Speedrun basic chess endgames against a perfect defender.

**Play it: <https://jeptah.github.io/checkmate-speedrun/>**

You get a won position, the clock starts on your first move, and the computer
defends with tablebase-best moves. At the end you see your time, your move
count, and the fewest moves that were possible.

## Endings

| Group | Endings | Goal |
|---|---|---|
| Checkmates | Queen, Rook, Two Bishops, Bishop + Knight | Checkmate the lone king |
| Queen vs piece | Queen vs Rook, Bishop or Knight | Win the piece, or mate |
| Pawn endings | Pawn vs King, Queen vs Pawn on the 7th, Rook vs Pawn | Queen safely, or win the pawn |
| Rook endings | Lucena with a centre, bishop or knight pawn; Rook + rook pawn vs Rook | Queen safely, or win the rook |

Each ending has two kinds of start:

- **Standard** – a random position with a fixed optimal length (for example,
  "mate in 28" for Bishop + Knight), so runs are comparable and cannot be memorised.
- **Any position** – any won position.

## Controls

Moves happen on press, not release, and there are several ways to make one:

- Drag a piece, or click it and then click a square.
- Click a square that only one piece can reach.
- Hover a square and press a piece key. Hold the key and sweep the mouse to keep moving.

| Key | Piece |
|---|---|
| `Shift` | King |
| `S` | Queen |
| `1` / `3` | Left / right rook |
| `Space` | Bishop |
| `A` / `D` | Left / right knight |
| `W` | Pawn forward |
| `Q` / `E` | Pawn takes left / right |
| `R` or `Enter` | New position |

The board can be resized from its bottom-right corner when no run is in progress.

## Sharing

**Share** copies your result and a link to the position you started from, such as
`#BN/c3f1d5e8`. Opening the link loads the same position, which keeps its own
best time.

## How it works

- A static site with no build step and no dependencies: plain HTML, CSS and
  JavaScript modules.
- Tablebases are generated in the browser by retrograde analysis in a web
  worker, the first time an ending is selected (from under a second to about
  five seconds), then cached in IndexedDB.
- The mate endings use exact distance-to-mate tables.
- The other endings stop at the first capture or promotion, which is judged on
  the spot; their tables hold the distance to that winning conversion.
- When several defences last equally long, the computer picks one at random.
- Best times are stored in the browser's local storage. There are no accounts
  and no server.

Known simplifications in the pawn endings: the defender only promotes to a
queen, and a win that needs more than one move after the defender queens is not
counted as a win.

## Sounds

The **Sound** button switches between recorded sounds, fully generated sounds,
and silence. The `.ogg` recordings in `sounds/` are from the
[Impact Sounds](https://kenney.nl/assets/impact-sounds) pack by Kenney (CC0);
the generated sounds are synthesised in the browser by `js/sound.js`.

## Run locally

Any static file server works. With Python:

```bash
python -m http.server 8123
```

Then open <http://localhost:8123/>. Opening `index.html` straight from disk does
not work, because browsers block module scripts and workers on `file://` pages.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css` | Page and layout |
| `js/main.js` | UI: input, clock, records, sharing |
| `js/endings.js` | The list of endings and how each is played |
| `js/tablebase.js` | Distance-to-mate tables for K + pieces vs K |
| `js/wintable.js` | Conversion tables for the piece and pawn endings |
| `js/lucena.js` | Rules and table for rook + pawn vs rook |
| `js/tb-worker.js` | Web worker that builds the tables |
| `js/chess.js` | Board geometry |
| `js/sound.js`, `sounds/` | Sound effects |
