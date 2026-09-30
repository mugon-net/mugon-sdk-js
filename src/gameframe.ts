import {
  Channel,
  FromGameframeMessage,
  FromGameframeWindowMessage,
  NetworkMode,
  ToGameframeInitMessage,
  ToGameframeMessage,
  ToGameframeWindowMessage,
} from "./protocol";
import { createFetchClient, installFetchShim } from "./fetch-shim";
import { version } from "./version";

declare global {
  interface Window {
    // Set by `Mugon.start` before its callback runs.
    readonly mugon?: MugonContext;
  }
}

export interface MugonMessage {
  from: string;
  channel: Channel;
  data: Uint8Array;
}

export interface MugonEvents {
  connect: (peerId: string) => void;
  disconnect: (peerId: string) => void;
  message: (message: MugonMessage) => void;
}

export interface MugonContext {
  readonly role: NetworkMode;
  readonly ownId: string;
  readonly serverId: string;
  readonly settings: Readonly<Record<string, string>>;
  // Snapshot at init; later changes arrive through `on`.
  readonly initialPeers: readonly string[];
  send(peerId: string, data: Uint8Array, channel?: Channel): void;
  drop(peerId: string): void;
  // Events that arrive while no handler is registered for them are queued and
  // delivered to the first handler that subscribes.
  on<Event extends keyof MugonEvents>(
    event: Event,
    handler: MugonEvents[Event],
  ): () => void;
  showInvite(): void;
  toggleFullscreen(): void;
  progress: {
    set(fraction: number, label?: string): void;
    done(): void;
  };
}

export interface GameframeMessageEvent {
  source: unknown;
  data: unknown;
  ports: readonly MessagePort[];
}

export interface GameframeEnv {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(
    type: "message",
    listener: (event: GameframeMessageEvent) => void,
  ): void;
  toggleFullscreen(): void;
  // Makes the context reachable by code that cannot be handed it as an
  // argument, e.g. a wasm module started by the callback.
  publishContext?(context: MugonContext): void;
}

const HELLO_RETRY_MS = 1000;

export function createGameframeRuntime(env: GameframeEnv) {
  let controlPort: MessagePort | undefined;
  const fetchClient = createFetchClient();
  let started = false;
  let resolveContext!: (context: MugonContext) => void;
  let rejectContext!: (error: Error) => void;
  const contextPromise = new Promise<MugonContext>((resolve, reject) => {
    resolveContext = resolve;
    rejectContext = reject;
  });
  contextPromise.catch(() => {});

  const handlers: { [Event in keyof MugonEvents]: Set<MugonEvents[Event]> } = {
    connect: new Set(),
    disconnect: new Set(),
    message: new Set(),
  };
  const queued: {
    [Event in keyof MugonEvents]: Parameters<MugonEvents[Event]>[0][];
  } = {
    connect: [],
    disconnect: [],
    message: [],
  };

  function emit<Event extends keyof MugonEvents>(
    event: Event,
    payload: Parameters<MugonEvents[Event]>[0],
  ) {
    if (handlers[event].size === 0) {
      queued[event].push(payload as never);
      return;
    }
    for (const handler of handlers[event]) {
      (handler as (payload: unknown) => void)(payload);
    }
  }

  function sendToParent(
    message: FromGameframeMessage,
    transfer: Transferable[] = [],
  ) {
    controlPort?.postMessage(message, transfer);
  }

  function handleControlMessage(event: MessageEvent) {
    const message = event.data as ToGameframeMessage | undefined;
    switch (message?.type) {
      case "con":
        emit("connect", message.clientid);
        break;
      case "dc":
        emit("disconnect", message.clientid);
        break;
      case "msg":
        emit("message", {
          from: message.fromclientid,
          channel: message.channel,
          data: message.data,
        });
        break;
    }
  }

  function buildContext(init: ToGameframeInitMessage): MugonContext {
    return Object.freeze<MugonContext>({
      role: init.role,
      ownId: init.ownId,
      serverId: init.serverId,
      settings: Object.freeze({ ...init.settings }),
      initialPeers: Object.freeze([...init.initialPeers]),
      send(peerId, data, channel = Channel.ReliableOrdered) {
        sendToParent({ type: "msg", toclientid: peerId, channel, data }, [
          data.buffer,
        ]);
      },
      drop(peerId) {
        sendToParent({ type: "drp", clientid: peerId });
      },
      on(event, handler) {
        const set = handlers[event] as Set<typeof handler>;
        set.add(handler);
        for (const payload of queued[event].splice(0)) {
          (handler as (payload: unknown) => void)(payload);
        }
        return () => {
          set.delete(handler);
        };
      },
      showInvite() {
        sendToParent({ type: "showinvite" });
      },
      toggleFullscreen: () => env.toggleFullscreen(),
      progress: {
        set(fraction, label) {
          sendToParent({ type: "progress", fraction, label });
        },
        done() {
          sendToParent({ type: "done" });
        },
      },
    });
  }

  function postHello() {
    const hello: FromGameframeWindowMessage = {
      type: "hello",
      sdkVersion: version,
    };
    env.parent.postMessage(hello, "*");
  }

  const helloTimer = setInterval(postHello, HELLO_RETRY_MS);
  const stopHelloRetries = () => clearInterval(helloTimer);

  env.addEventListener("message", (event) => {
    if (event.source !== env.parent) return;
    const message = event.data as ToGameframeWindowMessage | undefined;
    switch (message?.type) {
      case "fetch-port": {
        stopHelloRetries();
        const port = event.ports[0];
        if (port) fetchClient.attach(port);
        break;
      }
      case "reject":
        stopHelloRetries();
        rejectContext(new Error(message.reason));
        break;
      case "init": {
        const port = event.ports[0];
        if (!port || controlPort) return;
        stopHelloRetries();
        controlPort = port;
        port.onmessage = handleControlMessage;
        resolveContext(buildContext(message));
        break;
      }
    }
  });

  postHello();

  return {
    fetchClient,
    async start(callback: (context: MugonContext) => void | Promise<void>) {
      if (started) throw new Error("Mugon.start was already called");
      started = true;
      const context = await contextPromise;
      env.publishContext?.(context);
      await callback(context);
      context.progress.done();
    },
  };
}

function createWindowEnv(): GameframeEnv {
  return {
    parent: window.parent,
    addEventListener: (type, listener) =>
      window.addEventListener(type, (event) =>
        listener({
          source: event.source,
          data: event.data,
          ports: event.ports,
        }),
      ),
    publishContext(context) {
      Object.defineProperty(window, "mugon", {
        value: context,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    },
    toggleFullscreen() {
      // Fullscreens the gameframe's own document rather than relaying to the
      // parent: a click's transient activation doesn't cross frames, so a
      // parent-side requestFullscreen() would be rejected.
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void document.documentElement.requestFullscreen();
      }
    },
  };
}

let runtime: ReturnType<typeof createGameframeRuntime> | undefined;

function installRuntime() {
  if (!runtime) {
    runtime = createGameframeRuntime(createWindowEnv());
    installFetchShim(window, runtime.fetchClient, window.location.href);
  }
  return runtime;
}

const insideParentframe =
  typeof window !== "undefined" && window.parent !== window;

// Importing the SDK is what says hello to the parentframe, so that the parent
// can start serving files before the game's own code gets to run.
if (insideParentframe) {
  installRuntime();
}

export function start(
  callback: (context: MugonContext) => void | Promise<void>,
): Promise<void> {
  if (!insideParentframe) {
    return Promise.reject(
      new Error("Mugon.start must run inside a mugon parentframe iframe"),
    );
  }
  return installRuntime().start(callback);
}
