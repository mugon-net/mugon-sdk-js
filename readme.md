# @mugon/sdk

SDK for games running on the [mugon.net](https://mugon.net) platform.

A game runs in a sandboxed iframe on the platform's page (the _parentframe_). This package has
two halves:

- **The game side** (`@mugon/sdk`, `mugon.iife.js`): `Mugon.start`, which hands your game its
  context (role, ids, peers, messaging, loading progress) and serves its files through the
  platform so large downloads are cached.
- **The parentframe side** (`@mugon/sdk/parentframe`): what the platform and the `mugon` CLI's
  dev server use to host a game. Game developers don't need it.

## Game side

```ts
// Import the SDK first: importing it says hello to the platform.
import { Mugon } from "@mugon/sdk";

Mugon.start(async (ctx) => {
  console.log(`running as ${ctx.role} with id ${ctx.ownId}`);

  ctx.on("connect", (peerId) => console.log("peer connected", peerId));
  ctx.on("message", ({ from, data }) => console.log(from, data.byteLength));

  // ...create your game, then tell the platform it is playable:
  ctx.progress.done();
});
```

Without a bundler, load `dist/mugon.iife.js` as the **first** `<script>` of your `index.html`; it
defines a global `Mugon` (`Mugon.start`, `Mugon.Channel`).

The context (`ctx`) offers `role`, `ownId`, `serverId`, `peers`, `settings`, `send`, `drop`, `on`,
`showInvite`, `toggleFullscreen` and `progress.set`/`progress.done`. It is also published as
`window.mugon` for code that can't be handed it, such as a wasm module.

The platform closes its loading overlay when the `Mugon.start` callback finishes or when you call
`ctx.progress.done()`.

The `mugon` CLI ([mugon-cli](https://github.com/mugon-net/mugon-cli)) creates projects that
already use this SDK. For Rust games, see
[mugon-sdk-bevy](https://github.com/mugon-net/mugon-sdk-bevy).

## Versioning

The **major** version is the protocol generation between a game and the platform, and it is
recorded with every published game version (`js-sdk-version` in `mugon.toml`; `mugon publish`
verifies it against what is bundled). Within a major, changes only add things, so games built
with any release of a major keep working.

## Development

```bash
npm install
npm run build   # ESM build + the self-contained mugon.iife.js in dist/
npm test
```

The version is read from `package.json` and embedded in the bundles as a
`mugon-sdk-version:x.y.z` marker, which `mugon publish` looks for.

## License

[MIT](LICENSE-MIT)

## Links

- Repository and issues: <https://github.com/mugon-net/mugon-sdk-js>
- Platform: <https://mugon.net>
