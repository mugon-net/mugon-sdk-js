import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGameframeRuntime,
  GameframeMessageEvent,
  MugonContext,
} from "./gameframe";
import type { FetchVersionFile } from "./fetch-proxy";
import {
  HandshakeTimeoutError,
  NoServerAvailableError,
  Parentframe,
  ParentframeMessageEvent,
  ParentframeTransport,
  SdkMajorMismatchError,
  TransportHandlers,
  TransportIdentity,
} from "./parentframe";
import { Channel } from "./protocol";
import { major, version } from "./version";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

function defer<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

class FakeTransport implements ParentframeTransport {
  handlers!: TransportHandlers;
  connection = defer<TransportIdentity>();
  connectCalls = 0;
  sent: { playerId: string; channel: Channel; data: Uint8Array }[] = [];
  disconnected: string[] = [];
  closed = 0;

  connect(_role: unknown, handlers: TransportHandlers) {
    this.connectCalls++;
    this.handlers = handlers;
    return this.connection.promise;
  }
  send(playerId: string, channel: Channel, data: Uint8Array) {
    this.sent.push({ playerId, channel, data });
  }
  disconnectPlayer(playerId: string) {
    this.disconnected.push(playerId);
  }
  close() {
    this.closed++;
  }
}

// A parent window, a game window and the wiring between them, so that the real
// gameframe runtime talks to the real Parentframe over real MessageChannels.
function createHarness(
  fetchVersionFile: FetchVersionFile = () =>
    Promise.reject(new Error("unused")),
) {
  const parentListeners = new Set<(event: ParentframeMessageEvent) => void>();
  const childListeners = new Set<(event: GameframeMessageEvent) => void>();
  const parentWindow = {
    postMessage(message: unknown) {
      for (const listener of parentListeners) {
        listener({ source: childWindow, data: message, ports: [] });
      }
    },
  };
  const childWindow = {
    delivered: [] as unknown[],
    postMessage(message: unknown, _origin: string, transfer?: Transferable[]) {
      this.delivered.push(message);
      for (const listener of childListeners) {
        listener({
          source: parentWindow,
          data: message,
          ports: (transfer ?? []) as MessagePort[],
        });
      }
    },
  };
  const messageTarget = {
    addEventListener: (
      _type: "message",
      listener: (event: ParentframeMessageEvent) => void,
    ) => parentListeners.add(listener),
    removeEventListener: (
      _type: "message",
      listener: (event: ParentframeMessageEvent) => void,
    ) => parentListeners.delete(listener),
  };
  const transport = new FakeTransport();
  const events = {
    phases: [] as string[],
    progress: [] as unknown[],
    showInvite: 0,
    endGame: 0,
    nextRound: [] as Record<string, unknown>[],
  };
  const parentframe = new Parentframe({
    transport,
    fetchVersionFile,
    messageTarget,
    onPhase: (phase) => events.phases.push(phase),
    onProgress: (progress) => events.progress.push(progress),
    onShowInviteRequest: () => events.showInvite++,
    onEndGameRequest: () => events.endGame++,
    onNextRoundRequest: (settings) => events.nextRound.push(settings),
    handshakeTimeoutMs: 1000,
  });

  function launch(
    role: "server" | "client" = "server",
    expectedMajor?: number,
    settings?: Record<string, string>,
    totalBytes?: number,
  ) {
    return parentframe.launch({
      src: "about:blank",
      role,
      expectedMajor,
      settings,
      totalBytes,
      iframeFactory: () => ({ contentWindow: childWindow }),
    });
  }

  const published: MugonContext[] = [];
  const runtimes: ReturnType<typeof createGameframeRuntime>[] = [];

  function startGame(keepRunning = false) {
    const contextPromise = defer<MugonContext>();
    const runtime = createGameframeRuntime({
      parent: parentWindow,
      publishContext: (context) => published.push(context),
      addEventListener: (_type, listener) => childListeners.add(listener),
      toggleFullscreen: () => {},
    });
    runtimes.push(runtime);
    const finished = runtime.start(async (context) => {
      contextPromise.resolve(context);
      if (keepRunning) await new Promise<void>(() => {});
    });
    finished.catch((error) => contextPromise.reject(error));
    return { context: contextPromise.promise, finished };
  }

  return {
    messageTarget,
    parentframe,
    transport,
    events,
    childWindow,
    launch,
    startGame,
    published,
    runtimes,
  };
}

const player = (id: string, name = id) => ({ id, name });

const serverIdentity = { self: player("host-1") };

let active: Parentframe | undefined;
afterEach(() => {
  active?.destroy();
  active = undefined;
  vi.useRealTimers();
});

describe("handshake ordering", () => {
  it("waits for the network when hello comes first", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    const launched = harness.launch();
    const game = harness.startGame();

    await vi.waitFor(() =>
      expect(harness.childWindow.delivered).toContainEqual({
        type: "fetch-port",
      }),
    );
    expect(harness.childWindow.delivered).toHaveLength(1);
    expect(harness.events.phases).toEqual(["frame-created", "hello-received"]);

    harness.transport.connection.resolve(serverIdentity);
    const context = await game.context;
    expect(context.role).toBe("server");
    expect(context.self).toEqual(player("host-1"));
    expect(context.server).toEqual(player("host-1"));
    expect((await launched).self.id).toBe("host-1");
    expect(harness.events.phases).toEqual([
      "frame-created",
      "hello-received",
      "network-ready",
      "running",
    ]);
  });

  it("inits immediately when the network is ready before hello", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve({ self: player("c1"), server: player("s1") });
    const launched = harness.launch("client", undefined, { colour: "red" });
    await vi.waitFor(() =>
      expect(harness.events.phases).toContain("network-ready"),
    );
    expect(harness.childWindow.delivered).toEqual([]);

    const game = harness.startGame();
    const context = await game.context;
    await launched;
    expect(context.role).toBe("client");
    expect(context.self).toEqual(player("c1"));
    expect(context.server).toEqual(player("s1"));
    expect(context.settings).toEqual({ colour: "red" });
  });

  it("does not run the game callback before init", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.launch();
    const callback = vi.fn();
    const game = harness.startGame();
    void game.finished.then(callback);
    await vi.waitFor(() =>
      expect(harness.events.phases).toContain("hello-received"),
    );
    expect(callback).not.toHaveBeenCalled();
    harness.transport.connection.resolve(serverIdentity);
    await game.finished;
    expect(callback).toHaveBeenCalled();
  });

  it("answers a repeated hello with fresh ports and a fresh init", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    harness.launch();
    const game = harness.startGame();
    await game.context;
    harness.transport.handlers.onPlayerConnected(player("player-a"));
    const deliveredBefore = harness.childWindow.delivered.length;

    const secondGame = harness.startGame();
    const secondContext = await secondGame.context;
    expect(harness.childWindow.delivered.length).toBeGreaterThan(
      deliveredBefore,
    );
    expect(secondContext.initialPlayers).toEqual([player("player-a")]);
  });
});

describe("player names", () => {
  it("carries names into init and into playerConnected", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve({
      self: player("c1", "Cleo"),
      server: player("s1", "Sam"),
    });
    harness.launch("client");
    const context = await harness.startGame().context;

    expect(context.self).toEqual({ id: "c1", name: "Cleo" });
    expect(context.server).toEqual({ id: "s1", name: "Sam" });
    expect(context.initialPlayers).toEqual([{ id: "s1", name: "Sam" }]);

    const joined: { id: string; name: string }[] = [];
    context.on("playerConnected", (connected) => joined.push(connected));
    harness.transport.handlers.onPlayerConnected(player("p2", "Pat"));
    await vi.waitFor(() => expect(joined).toEqual([{ id: "p2", name: "Pat" }]));
  });

  it("freezes the players it hands the game", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    harness.launch();
    const context = await harness.startGame().context;

    expect(Object.isFrozen(context.self)).toBe(true);
    expect(Object.isFrozen(context.initialPlayers)).toBe(true);
  });

  it("cuts names to 32 characters", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve({
      self: player("host-1", "h".repeat(100)),
    });
    harness.launch();
    const context = await harness.startGame().context;
    harness.transport.handlers.onPlayerConnected(player("p2", "x".repeat(40)));
    const joined: string[] = [];
    context.on("playerConnected", (connected) => joined.push(connected.name));

    expect(context.self.name).toHaveLength(32);
    await vi.waitFor(() => expect(joined).toEqual(["x".repeat(32)]));
  });
});

describe("byte progress", () => {
  it("reports the final byte count even when the last chunks arrive within the throttle window", async () => {
    const chunk = new Uint8Array(1000);
    const harness = createHarness(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < 5; index++)
                controller.enqueue(chunk.slice());
              controller.close();
            },
          }),
        ),
    );
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    const launched = harness.launch("server", undefined, undefined, 10_000);
    const game = harness.startGame(true);
    await game.context;
    await launched;

    const { body } = await harness.runtimes[0].fetchClient.request(
      { path: "f", query: "", method: "GET" },
      new AbortController().signal,
    );
    await new Response(body).arrayBuffer();

    await vi.waitFor(() =>
      expect(harness.events.progress.at(-1)).toMatchObject({
        loadedBytes: 5000,
        fraction: 0.5,
      }),
    );
  });

  it("does not reopen the overlay when bytes are counted after the game said done", async () => {
    const harness = createHarness(
      async () => new Response(new Uint8Array(1000)),
    );
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    const launched = harness.launch("server", undefined, undefined, 10_000);
    const game = harness.startGame();
    const context = await game.context;
    await launched;

    context.progress.done();
    await vi.waitFor(() =>
      expect(harness.events.progress.at(-1)).toMatchObject({ done: true }),
    );

    const { body } = await harness.runtimes[0].fetchClient.request(
      { path: "f", query: "", method: "GET" },
      new AbortController().signal,
    );
    await new Response(body).arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(harness.events.progress.at(-1)).toMatchObject({ done: true });
  });
});

describe("context handoff", () => {
  it("publishes the context before the game callback runs", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    harness.launch();
    const context = await harness.startGame().context;
    expect(harness.published).toEqual([context]);
  });

  it("puts the server among a client's players even if the transport never reported it", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve({ self: player("c1"), server: player("s1") });
    harness.launch("client");
    const context = await harness.startGame().context;
    expect(context.initialPlayers).toEqual([player("s1")]);
  });
});

describe("failures", () => {
  it("times out with a diagnostic when no hello arrives", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    active = harness.parentframe;
    const launched = harness.launch();
    const assertion = expect(launched).rejects.toBeInstanceOf(
      HandshakeTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    await expect(launched).rejects.toThrow(
      /no `hello` received .* built with `@mugon\/sdk` 0\.x/,
    );
  });

  it("rejects a game whose SDK major differs from the recorded one", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    const launched = harness.launch("server", major + 1);
    const game = harness.startGame();
    await expect(launched).rejects.toBeInstanceOf(SdkMajorMismatchError);
    await expect(launched).rejects.toThrow(
      `declares SDK major ${major + 1} but bundles SDK ${version}`,
    );
    await expect(game.finished).rejects.toThrow(/platform runs SDK major/);
  });

  it("parks the frame when no server exists and retries without reloading", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve({ self: player("c1") });
    const launched = harness.launch("client");
    await expect(launched).rejects.toBeInstanceOf(NoServerAvailableError);
    expect(harness.transport.closed).toBe(1);

    const game = harness.startGame();
    await vi.waitFor(() =>
      expect(harness.childWindow.delivered).toContainEqual({
        type: "fetch-port",
      }),
    );

    harness.transport.connection = defer();
    const retried = harness.parentframe.retryNetwork();
    harness.transport.connection.resolve({ self: player("c1"), server: player("s1") });
    await retried;
    expect((await game.context).server).toEqual(player("s1"));
    expect(harness.transport.connectCalls).toBe(2);
  });
});

describe("events around init", () => {
  it("folds pre-init player events into the snapshot and delivers pre-init data", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.launch();
    harness.transport.connection.resolve(serverIdentity);
    await vi.waitFor(() =>
      expect(harness.events.phases).toContain("network-ready"),
    );

    const { handlers } = harness.transport;
    handlers.onPlayerConnected(player("a"));
    handlers.onPlayerConnected(player("b"));
    handlers.onPlayerDisconnected("a");
    handlers.onData("b", Channel.ReliableOrdered, new Uint8Array([1, 2]));

    const game = harness.startGame();
    const context = await game.context;
    expect(context.initialPlayers).toEqual([player("b")]);

    const received: unknown[] = [];
    context.on("message", (message) => received.push(message));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      from: "b",
      channel: Channel.ReliableOrdered,
    });
    expect(Array.from((received[0] as { data: Uint8Array }).data)).toEqual([
      1, 2,
    ]);
  });

  it("forwards live events and queues them until a handler subscribes", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    harness.launch();
    const context = await harness.startGame().context;

    harness.transport.handlers.onPlayerConnected(player("late"));
    harness.transport.handlers.onPlayerDisconnected("late");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const connected: string[] = [];
    const disconnected: string[] = [];
    context.on("playerConnected", (joined) => connected.push(joined.id));
    context.on("playerDisconnected", (playerId) => disconnected.push(playerId));
    expect(connected).toEqual(["late"]);
    expect(disconnected).toEqual(["late"]);

    harness.transport.handlers.onPlayerConnected(player("live"));
    await vi.waitFor(() => expect(connected).toEqual(["late", "live"]));
  });
});

describe("game to parent", () => {
  it("relays sends, drops, invite requests and progress", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    harness.launch();
    const context = await harness.startGame().context;

    context.send("b", new Uint8Array([9]), Channel.UnreliableOrdered);
    context.disconnectPlayer("c");
    context.showInvite();
    context.progress.set(0.5, "textures");
    context.progress.set(7);

    await vi.waitFor(() => expect(harness.events.progress).toHaveLength(3));
    expect(harness.transport.sent).toHaveLength(1);
    expect(harness.transport.sent[0]).toMatchObject({
      playerId: "b",
      channel: Channel.UnreliableOrdered,
    });
    expect(harness.transport.disconnected).toEqual(["c"]);
    expect(harness.events.showInvite).toBe(1);
    expect(harness.events.progress).toEqual(
      expect.arrayContaining([
        { fraction: 0.5, label: "textures", loadedBytes: 0, done: false },
        { fraction: 1, label: "textures", loadedBytes: 0, done: false },
      ]),
    );
  });

  it("relays endGame and requestNextRound from the host", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    harness.launch();
    const context = await harness.startGame().context;

    context.endGame();
    context.requestNextRound({ rounds: 7, hard: true, maps: ["a", "b"], name: "x" });

    await vi.waitFor(() => expect(harness.events.nextRound).toHaveLength(1));
    expect(harness.events.endGame).toBe(1);
    expect(harness.events.nextRound[0]).toEqual({
      rounds: 7,
      hard: true,
      maps: ["a", "b"],
      name: "x",
    });
  });

  it("drops endGame and requestNextRound on a client", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    harness.transport.connection.resolve({ self: player("c1"), server: player("s1") });
    harness.launch("client");
    const context = await harness.startGame().context;

    context.endGame();
    context.requestNextRound({ rounds: 7 });
    context.showInvite();

    await vi.waitFor(() => expect(harness.events.showInvite).toBe(1));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(harness.events.endGame).toBe(0);
    expect(harness.events.nextRound).toEqual([]);
    warn.mockRestore();
  });

  it("ignores end-game and next-round messages from a client's frame", async () => {
    const controlPorts: MessagePort[] = [];
    const frame = {
      postMessage(
        _message: unknown,
        _origin: string,
        transfer?: Transferable[],
      ) {
        controlPorts.push(...((transfer ?? []) as MessagePort[]));
      },
    };
    const listeners = new Set<(event: ParentframeMessageEvent) => void>();
    const requests: string[] = [];
    const transport = new FakeTransport();
    transport.connection.resolve({ self: player("c1"), server: player("s1") });
    const parentframe = new Parentframe({
      transport,
      fetchVersionFile: () => Promise.reject(new Error("unused")),
      messageTarget: {
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
      },
      onShowInviteRequest: () => requests.push("invite"),
      onEndGameRequest: () => requests.push("end"),
      onNextRoundRequest: () => requests.push("next"),
    });
    active = parentframe;
    void parentframe.launch({
      src: "about:blank",
      role: "client",
      iframeFactory: () => ({ contentWindow: frame }),
    });
    for (const listener of listeners) {
      listener({
        source: frame,
        data: { type: "hello", sdkVersion: version },
        ports: [],
      });
    }
    await vi.waitFor(() => expect(controlPorts).toHaveLength(2));

    const gameSide = controlPorts[1];
    gameSide.postMessage({ type: "end-game" });
    gameSide.postMessage({ type: "next-round", settings: { rounds: 1 } });
    gameSide.postMessage({ type: "show-invite" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests).toEqual(["invite"]);
  });

  it("drops malformed and oversized next-round settings", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    harness.launch();
    const context = await harness.startGame().context;
    const send = (settings: unknown) =>
      context.requestNextRound(settings as Record<string, never>);

    send(null);
    send([1, 2]);
    send({ nested: { a: 1 } });
    send({ bad: Number.NaN });
    send({ list: [1, 2] });
    send({ long: "x".repeat(5000) });
    send(
      Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [`k${index}`, 1]),
      ),
    );
    context.requestNextRound({ ok: 1 });

    await vi.waitFor(() => expect(harness.events.nextRound).toHaveLength(1));
    expect(harness.events.nextRound).toEqual([{ ok: 1 }]);
  });

  it("reports done when the start callback resolves", async () => {
    const harness = createHarness();
    active = harness.parentframe;
    harness.transport.connection.resolve(serverIdentity);
    harness.launch();
    await harness.startGame().finished;
    await vi.waitFor(() =>
      expect(harness.events.progress).toContainEqual({
        fraction: 1,
        label: undefined,
        loadedBytes: 0,
        done: true,
      }),
    );
  });
});

describe("packaging", () => {
  it("keeps version.ts in sync with package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(version).toBe(packageJson.version);
  });
});
