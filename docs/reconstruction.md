# Reconstruction and engineering notes

## Evidence and provenance

The supplied 249,816-byte transcript contains 28 recoverable configuration/source files, explanations of tests, and descriptions of an original project. It ends before the promised test/evaluation batch. The referenced `Reverse-demo/demo-0f104518` repository returned “Repository not found” using this workspace's GitHub access. The destination `Frankstuff/glasses_stuff` was empty.

`recovery-manifest.json` records the attachment SHA-256 and the original line range of every recovered block. The attachment itself is private workspace material and is not committed. The recovered package identifies the author as `picklerpeej` and version as `0.2.0`; see [NOTICE](../NOTICE.md).

This is a functional reconstruction of the supplied implementation, **not a claim of byte-for-byte identity with inaccessible upstream code or a particular creator's video**.

| Component | Evidence and resulting implementation |
| --- | --- |
| Source/configuration | 28 blocks recovered from the transcript; repaired as described below |
| Matching algorithm, thresholds, prompts | Recovered implementations, retained core behavior |
| Browser page and overlay | Recovered markup/geometry/renderers, repaired broken template interpolation |
| Tests and evaluator | Original files were discussed but not included; newly implemented here |
| PGN fixtures | Newly added practice line and historical Opera Game transcription |
| Demo | Newly implemented synthetic observations + actual Stockfish + production browser/game loop |
| Lockfile and CI | Newly generated; exact direct dependencies verified against npm |
| README/design/hardware docs | Written for this reconstruction; official source verification is separate from hardware testing |

## What the creator's approach appears to have been

The supplied implementation uses a consumer video-call feature as transport. The glasses share their camera through a phone-managed WhatsApp video call. Native WhatsApp on the Mac renders that view. The app screenshots the call window, sends JPEGs to a vision API, tracks the game locally, and runs Stockfish locally. macOS `say` writes audio into BlackHole; WhatsApp uses BlackHole as its microphone, carrying advice back to the glasses.

No chess application runs on the glasses. There is no webcam, RTMP capture URL, custom Bluetooth protocol, or Meta SDK in the recovered source. RTMP appears only as an optional **overlay output**. The overlay is for a computer/video viewer; it does not imply an in-lens display.

The model is only the eyes. It reports square occupancy. `chess.js` supplies legal moves and maintains piece identities and history. Stockfish evaluates the position and chooses a move. These are three separate responsibilities; a model agreeing with a legal continuation is not proof that the image was read correctly.

## Trace: White plays e4

Assume the wearer is Black, tracking the normal start position, with a previously confirmed starting-frame reference.

1. **Capture — `CallWindow.grab()` / `macos.capture()`.** Locate a visible call window; invoke `screencapture -x -o -l ID -t jpg FILE`. `toJpeg()` applies EXIF rotation and shrinks the longest edge to at most 2576 pixels, JPEG quality 90. A frame is `{jpeg: Buffer, t: seconds, capturedAt: wallClockMilliseconds}`. There is no recognition crop or perspective rectification.
2. **Optional gate — `Gate.ask()` / `Gate.verdict()`.** Jev reports readable/hand/changed probabilities. Skip unreadable below 0.8, hand above 0.5, or changed below 0.1 when no confirmation/reply is pending. A failed gate falls through to a vision read. Three consecutive unchanged skips force another full vision request. Jev images are capped at 1568 pixels.
3. **Vision — `Vision.question()` / `GptVision.call()` or `ClaudeVision.call()`.** The default changes strategy sends a reference image, its known occupancy, the new image, and a strict JSON schema. Example response:

   ```json
   {
     "board_visible": true,
     "hand_over_board": false,
     "changes": [
       {"square": "e2", "now": "empty"},
       {"square": "e4", "now": "white"}
     ]
   }
   ```

4. **Grid — `Vision.reading()`.** Apply those changes to the reference occupancy. The resulting rows (rank 8 first, files a→h) are:

   ```text
   bbbbbbbb
   bbbbbbbb
   ........
   ........
   ....w...
   ........
   wwww.www
   wwwwwwww
   ```

   These letters do not identify pawns or other pieces. The first frame, and periodic audit frames, use the occupancy strategy: all 64 squares are read independently, with `?` for uncertainty.
5. **Inference — `rank()` / `match()` / `Tracker.update()`.** Compare the grid against every legal move and no move. e2e4 fits with zero discrepancies; no move leaves two. Margin is runner-up minus best score. Two independent agreeing frames, total margin at least 3, commit e4. The tracker now knows the new FEN from applying a legal move, including turn and castling metadata.
6. **Evaluation — `Game.committed()` / `Engine.best()`.** If it is the wearer's turn and the frame did not already contain their reply, send `position fen ...` and `go movetime 500` over Stockfish's stdin. Parse `info ... score ...` and `bestmove`. Validate that bestmove is legal with `moveFrom()` before using it. Scores are normalized to White internally and to the wearer for spoken/displayed text.
7. **Feedback — `spoken()` / `Speaker.say()`.** A recommendation such as e7e5 becomes “Pawn to e5”. Run `say -a "BlackHole 2ch" ...` and log speech completion/failure. Browser state travels over server-sent events. No new frame is processed concurrently with the game loop's awaited vision/engine work, although speech and the optional overlay run independently.

## State, ambiguity and recovery

`Grid` stores 64 cells indexed a1=0 through h8=63. Unknown squares do not count as mismatches. `rank()` evaluates each legal move and each move-plus-reply, charging one extra mismatch for the reply. Only the first ply is committed; the second still needs its own confirmation. The reference can therefore already show a reply that the tracker has not committed. `Watcher.referenceFen` deliberately describes the photographed position, not always the current tracked position.

The main defaults are `confirm=2`, `evidence=3`, `lostAfter=6`, `maxMismatchRate=0.15`, `maxOff=5`, `REPLY_COST=1`. Ties never commit. The rate threshold is `max(4, roundHalfEven(0.15 × knownSquares))`, with the additional absolute cap of five. Six unusably loose fits trigger lost tracking. Hand/unreadable observations pause confirmation rather than supply evidence. These heuristics are retained from the attachment; they are not calibrated probabilities.

Orientation is an assumption tied to wearer color: White's a-file is on the left; Black's h-file is on the left. The model locates squares implicitly. Side-on viewing is not calibrated. Moving heads, occlusion, lookalike colors and small boards remain visual failure modes. The changes strategy has no per-square unknown response; omitted changes look unchanged. A periodic full occupancy audit helps expose omissions but cannot recover an arbitrary game state.

Piece identity, turn, castling rights, en passant, halfmove clock and move number come from the supplied FEN and subsequent legal moves. Occupancy-equivalent promotions are deduplicated to a queen. A knight/bishop/rook underpromotion needs manual correction. Starting without the correct rights can make a visually plausible castle or en passant impossible to match.

Recovery uses browser Undo, manual SAN/UCI Move, or New Game with a corrected FEN. “Lost” does not launch a separate piece recognizer. More than two unseen plies can fall outside the search. A legal but incorrectly perceived move can still be committed; legal validation is not recognition validation.

## Repairs and deliberate changes

The pasted material had many silently damaged template literals: `${...}` became bare names or malformed braces, sometimes deleting whole declarations. Restored examples include the wearer-color vision prompt, FEN prompt, non-pawn speech, Mac CoreGraphics window list, score text, run timestamp, server URL, UI DOM calls, board SVG and overlay SVG. Compilation alone would not catch strings that were syntactically valid but wrong.

Additional changes made for a usable reconstruction:

- Pin verified package versions, create a lockfile, use current stable SDK types and remove the unverified Anthropic fallback beta. Preserve the documented default model; see [dependency evidence](dependencies.md).
- Keep environment-key lookup usable on Linux without calling macOS Keychain. Add a data-directory override and clear platform diagnostics.
- Keep the verified official macOS Stockfish pin; add checksum-verified Linux downloads and engine-only setup. Clean up failed/hung child processes.
- Ignore repeated replay-frame timestamps. Snapshot the JPEG and timestamp together. Preserve the last decoded image for tracking even if the overlay reads it first. Report invalid video/decoder failures instead of swallowing them; bound decoder buffering. Exit completed recordings even when paused or in a terminal chess position, and cancel provider requests when stopping.
- Audit changes mode using a fresh occupancy read after ten vision reads. Refresh a no-change reference only on an exact zero-mismatch fit. Reset orientation prompts on browser color changes.
- Invalidate pending vision responses when a manual control arrives. Clear queued advice on ordinary commits, lost tracking and call loss as well as manual corrections. Repeat and display use the same observation/age checks. Suppress engine results after controls/position changes or old local captures. These checks cannot know that the physical board moved during a remote read.
- Account for actual returned models or explicitly fall back to the requested model's documented rate; never treat unknown prices as free. Charge each completed response before the next provider stage, and stop resuming reads after an exceeded cap. This remains estimated, post-request accounting.
- Repair and test loopback HTTP/SSE controls, request validation and renderers. Keep browser/recorded overlays optional; no phone or glasses display application was added.
- Add reproducible simulated and recorded evaluation, a clearly labeled offline demo, test fixtures, and CI.

## Latency and costs: what can actually be claimed

The attachment includes conflicting reports of roughly 4–18 seconds per vision read and about 10 seconds for a short example's move-to-speech result. No source recordings or authoritative timestamps accompanied those claims. They should not be presented as measured performance here.

The implementation needs two agreeing model reads. Approximate delay is:

```text
unknown call transport delay
+ wait for sampling
+ two (optional gate + vision request + legal-move matching) passes
+ 500 ms Stockfish search
+ speech startup and duration
```

The loop already starts the next read immediately when processing exceeded its sample interval. “Remove the second wait to halve latency” would not be a valid optimization. Parallel reads need revision/age handling and may consume more tokens. Local pixel differences from a moving camera are not reliable evidence that a move happened.

Each frame event records media time, optional local capture time, processed time, model duration and match margin. `suggest`, `spoken`, `commit`, errors and controls have event timestamps. For actual transport latency, film a physical clock/stopwatch and compare the captured image to the original; local timestamps cannot reveal delays before the Mac screenshot. Use varied real clips and known PGNs to report wrong commits, missed plies, exact-game accuracy and API latency. Separate held-out physical recordings from synthetic regression fixtures.

Costs use returned input/output tokens and the checked model price table. The cache prevents repeated evaluation calls for identical prompts, references and images. A typical dollar-per-game estimate cannot be defended until actual call counts, token usage and board visibility are measured. The optional overlay adds its own locator requests.

## Practical next experiments

| Milestone | Success criterion | Relevant files |
| --- | --- | --- |
| Rebuild locally | `npm ci`, typecheck, tests and offline demo succeed | package/lockfile, tests, demo.ts |
| Hardware round trip | 20 readable captured board frames and ten audible move phrases | cli.ts testCall, macos.ts, speak.ts |
| One known position | Occupancy agrees with a known FEN across several real photos | vision.ts, match.ts |
| Recorded practice | Full PGN recovered with no wrong commits from a deliberately slow clip | capture.ts, evals/score.ts |
| Live practice | Complete a short game and measure time from physical move to audible advice | main.ts, watch.ts, events.ts |
| Direct glasses transport | Official CameraAccess sample yields actual frames; one TTS result returns | New native phone app + new Source implementation required |
| Arbitrary photograph | Piece-type recognition plus explicit nonvisual state confirmation | New position-recognition workflow required |

Meta's current toolkit has a documented camera-to-phone route and model-specific display support. It is not the route used by this reconstruction. The [hardware research](meta-glasses.md) includes official documentation, platform/version constraints, and a documented discrepancy about camera transport. Prove the official sample on the exact hardware before writing a relay.
