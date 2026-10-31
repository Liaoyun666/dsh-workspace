# Agent preset compact UI

## Scope and behavior

This standalone client enhancement styles only an official, structurally verified Agent preset native Menu. It does not edit presets, defaults, permissions, core source, keyboard handlers, labels, DOM order or portal positioning. Ordinary menus and unknown structures remain native (fail open).

- Outer width: `min(420px, 100vw - 24px)`; outer maximum height: `min(320px, 100dvh - top - 12px)`.
- `top = max(12px, --dsh-frame-top-clearance + 20px)`; native fullscreen policy uses 20px. Inner scroll viewport has maximum 308px and reserves a further 12px for native padding.
- Two columns, row-major, at viewport widths >=560px; one column below 560px. Native ArrowUp/Down still follows original linear DOM order, not a new directional grid navigation model.
- Rows use 8px padding and 4px gap. Name is 13px/20px; description is 12px/16px. Both use single-line ellipsis without truncating text nodes. Full text is available in DOM and title.
- Native selected SVG check is retained. Selected/hover/focus colors, focus ring, radius and text use native theme tokens; reduced motion removes row animations/transitions.

## Identification, ownership and disposal

Stylesheet identity is `@deepseek-ai/dsh-client-ui-agent-preset/AgentPresetSeat.module.css`, not a localized label or fixed build hash. The current class family is read from that official stylesheet once and cached until source changes. All item/name/description shapes are checked; the aria-hidden MenuSurface material sibling is excluded. Selected checks accept the native `_check_*` dynamic class family and its real SVG shape.

The document body observer observes **direct childList changes only**, discovering/removing native direct-body portals. Only successfully identified target menus get local class/text/title observers. Non-target internals and chat subtree mutations are never observed. Source stylesheet/head observers are separate. Title writes do not trigger rescans unless an external actual value differs.

Preexisting title attributes remain untouched. Any externally changed or removed title permanently yields ownership for that element during its menu lifecycle, including temporary removal and reinsertion. Owned-element set differences restore still-connected moved-out nodes. Closing disconnects the local observer and clears menu/attribute strong references. Mount/release are reference-counted and idempotent. Final release restores owned attributes, disconnects every observer and removes the injected style.

## Native browser fixture (not the live GUI)

Run from the release package root:

```sh
node --check lib/client.js
node --check test/browser.mjs
node --check test/harness.js
node --check test/cdp.mjs
node --check test/start-browser.mjs
node test/browser.mjs
node test/artifacts/audit.mjs
```

Verified Node: `C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`, v24.21.0. Default browser: `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`; set `APC_EDGE` to override.

The test launches a fresh empty temporary headless Edge profile, creates one CDP target, and serves assets via CDP Fetch interception at `http://apc-fixture.invalid/`. No web server is started, no user profile/Cookies/Login Data is copied, and no authenticated GUI route is visited. CDP calls time out after 15s, startup after 15s, and target/browser cleanup runs in `finally`. The empty temporary profile is left in the OS temp directory for inspection; it is never packaged. The audit verifies the launched browser PID no longer exists.

`test/harness.js` renders the actual Menu export from the extracted local production core, with the real official `anchor` API and official item label structure. It does not implement a fake Menu, fake portal or test-only recognizer. Production AgentPresetSeat CSS and production theme token strings are loaded. The only production frontend seed modification replaces its automatic application bootstrap suffix with `window.__TEST_SEEDS__=SZ()` so the existing native exports can be exercised without transport/authentication.

### Fixture provenance

`test/fixtures/provenance.json` records all copied files, exact original paths, byte counts, SHA-256 and the seed bootstrap substitution. Files were read/copied only from the old extracted fixture; no writes/deletes occurred in the old implementation directory. Theme source was extracted from the installed official app archive.

Key SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| Production frontend CSS | `2412389d14707cc10df9b3fa83893af96c5f2568da78029e1ba64123fb0c2b82` |
| Seed export fixture | `2d15db030896681bfac8fd0e5bd1701077f263fd774443a32bbe44bb78883d19` |
| React/vendor JS | `c14ba1089d78f48b8959a7bc42c9013b4a57aa4122e053d54f74c0a4d1d156a7` |
| Official Agent preset client | `ea57f30073b48c4875e236f0a29e7241cafb0dfd6418fa079f5db1fcfd51795c` |
| Official theme client | `4a6c83650c063f639ff468d766c794c82998c411ffb7dcc7ebb282e1f61923d0` |
| Original production frontend JS | `4bc914bfbb6adbdd63953a29f63835eb7127defd2a973149d64cdab489f1a9a5` |

### Acceptance results

`PASS ALL BROWSER ACCEPTANCE` was obtained against production native Menu. Recorded measurements:

| Viewport | Width x height | Top | Columns | Horizontal overflow |
| --- | --- | --- | --- | --- |
| 1000x700 native before enhancement | 329 x 676 | 12 | 1 | none |
| 1000x700 compact | 420 x 316 | 12 | 2 | none |
| 540x550 compact | 420 x 316 | 12 | 1 | none |
| 560x550 compact | 420 x 316 | 12 | 2 | none |
| 320x240, clearance 42px | 296 x 162 | 62 | 1 | none |

At 320x240 the calculated top is `max(12,42+20)=62px`; outer height limit is `min(320,240-62-12)=166px`, inner limit is 154px. Actual outer bottom is 224px; native padding plus inner scrolling produces 162px actual outer height.

Assertions cover 18 long descriptions; row-major order; complete text/title and 13/12px fonts; height/width/scroll bounds; theme light/dark; hover, focus ring, reduced motion; native ArrowUp/Down/Home/End/Enter/Tab/Escape/click and anchor refocus; selected dynamic class; unknown final-row structure; unknown provenance; ordinary-menu isolation; chat text/class 100 mutations causing zero extra scans; stable no-loop counters; stylesheet cached until invalidation and fully changed dynamic prefix; external title change/deletion and lifecycle yielding; moved-out still-connected nodes and reinsertion; close/reopen with menus/records zero; repeated mount/release; full cleanup and restored native width.

Output is `test/artifacts/browser-result.json`. Screenshots are clearly marked `OFFICIAL NATIVE MENU FIXTURE — NOT LIVE GUI`:

- `test/artifacts/fixture-native-before.png`
- `test/artifacts/fixture-compact-light.png`
- `test/artifacts/fixture-compact-dark.png`
- `test/artifacts/fixture-compact-narrow.png`
- `test/artifacts/fixture-compact-boundary.png`
- `test/artifacts/fixture-keyboard-focus.png`

## Integration boundary and remaining validation

This work does not install the package, restart DSH, change profiles or commit git history. Packaging/installation belong to the separate executor. Authenticated live GUI validation is a lead follow-up: the current GUI returned 401 and no authentication bypass was attempted. Future official Menu/CSS structural changes intentionally fall back to native. If a previously rejected open menu later becomes a supported structure, it is not rescanned internally until a fresh native portal lifecycle; this is deliberate non-target isolation.
