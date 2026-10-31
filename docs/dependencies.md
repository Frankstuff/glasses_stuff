# Dependency and provider repair

Provider documentation and registry versions checked on 2026-10-28; final reconstruction verified on 2026-10-31 with Node v24.22.1 / npm 11.19.1 on Linux. No live model requests were made. Provider transport tests supply dummy keys and an in-process fetch stub.

## Package version evidence

Each exact version below was fetched from the public npm registry's `https://registry.npmjs.org/<package>/<version>` metadata endpoint, including its tarball URL and Node engine requirements. Direct dependencies are pinned without ranges; package-lock.json records transitive resolutions and integrity hashes. The originally supplied versions exist; OpenAI and Anthropic were advanced to current SDKs to verify the current stable API shapes and effort values.

| Package | Exact installed version |
| --- | --- |
| openai | 7.45.1 |
| @anthropic-ai/sdk | 1.3.0 |
| @typesafe-ai/sdk | 0.7.0 |
| chess.js | 1.4.0 |
| commander | 14.0.3 |
| ffmpeg-static | 5.3.0 |
| sharp | 0.35.5 |
| @types/node | 26.6.5 |
| tsx | 4.23.15 |
| typescript | 7.0.2 |
| vite | 6.4.5 |
| vitest | 4.1.12 |

Representative registry sources:
- https://registry.npmjs.org/openai/7.45.1
- https://registry.npmjs.org/@anthropic-ai%2fsdk/1.3.0
- https://registry.npmjs.org/@typesafe-ai%2fsdk/0.7.0
- https://registry.npmjs.org/typescript/7.0.2
- https://registry.npmjs.org/vitest/4.1.12

Initial `npm install --ignore-scripts` installed 87 packages and reported 0 vulnerabilities; `npm rebuild ffmpeg-static sharp --foreground-scripts` then installed the native runtime pieces. FFmpeg executes (`7.0.2-static`), and Sharp successfully generates and reads a JPEG. The ordinary install lifecycle is also verified below. Existing build/prepare/typecheck/test/eval scripts are preserved; `start` is `node dist/bin.js` and `demo` is `node dist/bin.js demo`. The evaluator was reconstructed separately.

## Official API and model evidence

Used the OpenAI Docs skill. The official site has no usable `/search?q=...` route here (404); fetched the actual official vision, model catalog, selected-model, reasoning, and pricing pages directly. No account-specific model-list call or inference was used.

- https://developers.openai.com/api/docs/models/gpt-6.1-sol explicitly documents **gpt-6.1-sol**, image input, text output, Responses, structured outputs, and `low`, `medium`, `high`, `xhigh`, `max` reasoning effort. The supplied default is therefore real according to the fetched official documentation and is retained. The earlier comment claiming clip-tested superiority has been removed because no such evidence is available here.
- https://developers.openai.com/api/docs/guides/images-vision documents base64 image inputs.
- https://developers.openai.com/api/docs/guides/reasoning documents `reasoning: { effort }` for Responses and explains that supported values depend on the model. The five exposed values are supported by the currently priced GPT models. The app does not expose `none`/`minimal`, which Sol does not support.
- https://developers.openai.com/api/docs/pricing documents the GPT rates below.
- https://docs.claude.com/en/docs/build-with-claude/effort documents all five effort values for current Claude Opus/Sonnet/Haiku 5.5. Installed SDK 1.3.0's stable `MessageCreateParamsNonStreaming` / `OutputConfig` types support the request's structured-output schema and all five values. Requests use `client.messages.create`; the unverified server-side-fallback beta and fallback request parameters were removed. ClaudeVision's direct-constructor default is Claude Sonnet 5.5.
- https://docs.claude.com/en/docs/about-claude/pricing documents the Claude rates below. The alternate `platform.claude.com` docs endpoint returned 403, so the accessible official docs.claude.com endpoint was used.
- https://docs.typesafe.ai/models documents Jev 1.14.0 and 1.13.0, the jev-latest alias, and $0.042/M input tokens with free output.
- https://docs.typesafe.ai/images.md documents image assets, `TypeSafe-Danger-Zone-Images: true`, multipart image input, 1568px maximum edge, and image usage included in input token usage. Images are explicitly experimental (“Dreamer-ready”), not production-certified. SDK 0.7.0 exports image/noul/TypeSafeClient and accepts the original assets + state + questions pattern. The optional gate is retained and pinned to **jev-1.14.0** for stable threshold/pricing assumptions. An API/auth failure falls through to vision; rejected keys turn off further gate calls; malformed probabilities also fall through.

Account access, actual visual accuracy, latency, billable usage, live refusal behavior, and hardware operation have **not** been verified. No paid API calls, keychain access, or real credentials were needed. Older/custom model IDs outside the small price table need documented rates before live CLI use; arbitrary models may also need different effort settings. No model adapter fabricates a successful response when unsupported.

## Price estimates

USD per million uncached input/output tokens at standard short-context rates, read from the official pages above:

| Model | Input | Output |
| --- | ---: | ---: |
| gpt-6.1-sol | 2 | 10 |
| gpt-6-astra | 10 | 50 |
| gpt-6-luna | 0.10 | 0.50 |
| claude-sonnet-5-5 | 2 | 10 |
| claude-opus-5-5 | 4 | 20 |
| claude-haiku-5-5 | 0.10 | 0.50 |
| jev-1.14.0 / current jev-latest alias | 0.042 | 0 |

These are estimates, not verified invoice totals. Cache discounts/writes, long-context tiers (including Haiku's >100k tier and GPT >272k tier), batch/fast/ultrafast modes, regional uplifts, taxes, account agreements, and future alias/price changes are not modeled. Normal board-image requests are assumed to remain within short context. Dated snapshots may inherit a known base rate; unrelated suffixes such as `-pro` do not. Unknown returned model IDs now throw even at zero usage, or callers can explicitly pass the requested model as the fourth argument to `cost(returnedModel, inputTokens, outputTokens, requestedModel)` to use its rate. Known returned-model rates take priority over the requested model's rate. Unknown models can no longer silently cost $0.

## Behavior and integration notes

- `Vision.setColor(myColor: Side): void` rebuilds the readable system prompt. `system` remains publicly readable. The game calls setColor on its primary and first-look readers when starting another game. The pick prompt now contains the actual FEN and side to move; prompt cache version is 2.
- OpenAI uses strict Responses JSON schema plus ordered image/text input and supported reasoning effort. Claude uses stable Messages JSON schema plus supported output_config effort. Non-object JSON is a failed reading, and incomplete/refused output retains returned token usage for charging.
- Environment API keys take precedence on every OS. `readSecret()` returns null off macOS instead of trying to spawn `security`; saving a key there explicitly asks for environment configuration. No plaintext credential store was added.
- `CHESSHACKER_DATA_DIR` overrides storage. Otherwise macOS keeps its existing Application Support path, and Linux uses XDG_DATA_HOME or ~/.local/share/chesshacker.
- Doctor returns specific macOS-only diagnoses for live WhatsApp, BlackHole, and Screen Recording without running Mac commands on Linux, and reports missing keys before creating SDK clients. Offline demo, image processing and video replay can run on Linux; live hardware parts require a Mac.
- Stockfish release artifacts and checksums were verified independently; engine-only setup is available on Linux and macOS.

## Validation

- Focused tests: **25 passed** across `tests/vision.test.ts` and `tests/pricing.test.ts`. They cover real SDK request serialization with mocked fetch, color reset, corrected FEN, reference ordering, occupancy parsing, incomplete/refused/malformed responses, authentication/rate limits, Jev image requests/auth disable/fail-open validation, Linux diagnostics and environment key/data-path behavior, and unknown-model cost handling.
- Native runtime smoke: FFmpeg binary exists and executes, Sharp generates and reads JPEGs.
- Final `npm ci` (including prepare/build), typecheck, and all **95 tests** passed. The offline demo recovered the eight-ply practice sequence using actual Stockfish; the evaluator recovered all 33 Opera Game plies from synthetic observations.
- Headless Chrome: zero JavaScript errors, rendered board/frame, Undo and manual Move controls, no horizontal overflow at 390px. No physical-board vision accuracy is implied.
- Vite was advanced from 6.4.4 to 6.4.5 on 2026-10-31 to address [GHSA-8g5g-mxqh-grgj](https://github.com/advisories/GHSA-8g5g-mxqh-grgj). The final npm audit reports zero vulnerabilities.
- Provider and overlay cancellation now forwards abort signals to the SDKs. Returned gate usage is charged immediately even if a later vision stage fails.
