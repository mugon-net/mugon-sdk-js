import {
  Channel,
  FromGameframeMessage,
  FromGameframeWindowMessage,
  NetworkMode,
  ToGameframeDataMessage,
  ToGameframeInitMessage,
  ToGameframeMessage,
  ToGameframeWindowMessage,
  SettingValue,
} from "./protocol";
import { serveFetchPort } from "./fetch-proxy";
import type { FetchVersionFile } from "./fetch-proxy";
import { major as ownMajor, majorOf } from "./version";

export { createVersionFileFetcher } from "./version-file-fetcher";
export type {
  VersionFileCache,
  VersionFileFetcherOptions,
} from "./version-file-fetcher";
export type { FetchVersionFile, VersionFileRequest } from "./fetch-proxy";

export type { NetworkMode } from "./protocol";
export { major as sdkMajor } from "./version";

// The identity a transport assigns this peer once connected.
export interface TransportIdentity {
  clientId: string;
  // The server peer's id, present when this peer connected as a client.
  serverId?: string;
}

// The events a transport delivers to the parentframe; the parentframe forwards
// each of them to the gameframe.
export interface TransportHandlers {
  onData(peerId: string, channel: Channel, data: Uint8Array): void;
  onPeerConnected(peerId: string): void;
  onPeerDisconnected(peerId: string): void;
}

// A ParentframeTransport moves data between this peer and the others. The
// parentframe stays transport-agnostic: the dev CLI supplies a transport backed
// by a local relay, the production frontend supplies its own.
export interface ParentframeTransport {
  connect(
    mode: NetworkMode,
    handlers: TransportHandlers,
  ): Promise<TransportIdentity>;
  send(peerId: string, channel: Channel, data: Uint8Array): void;
  drop(peerId: string): void;
  close(): void;
}

// Thrown when a client can't find a server peer yet, so the caller can surface
// a distinct message.
export class NoServerAvailableError extends Error {
  constructor() {
    super("no server has connected yet");
    this.name = "NoServerAvailableError";
  }
}

export class HandshakeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `no \`hello\` received from the game within ${timeoutMs / 1000}s: is the game built with \`@mugon/sdk\` ${ownMajor}.x and does it load the SDK first?`,
    );
    this.name = "HandshakeTimeoutError";
  }
}

export class SdkMajorMismatchError extends Error {
  constructor(
    readonly declaredMajor: number,
    readonly gameSdkVersion: string,
  ) {
    super(
      `game declares SDK major ${declaredMajor} but bundles SDK ${gameSdkVersion}`,
    );
    this.name = "SdkMajorMismatchError";
  }
}

// The steps of a launch, reported as each one completes. `frame-created`,
// `network-ready` and `hello-received` happen in parallel and in any order.
export type LaunchPhase =
  | "frame-created"
  | "network-ready"
  | "hello-received"
  | "running";

export interface LoadProgress {
  // What the game reported through `ctx.progress`, or else the share of
  // `totalBytes` served so far (kept below 1 until the game is done).
  fraction?: number;
  label?: string;
  loadedBytes: number;
  done: boolean;
}

export interface GameframeHandle {
  readonly contentWindow: {
    postMessage(
      message: unknown,
      targetOrigin: string,
      transfer?: Transferable[],
    ): void;
  } | null;
}

export interface ParentframeMessageEvent {
  source: unknown;
  data: unknown;
  ports: readonly MessagePort[];
}

export interface ParentframeMessageTarget {
  addEventListener(
    type: "message",
    listener: (event: ParentframeMessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: ParentframeMessageEvent) => void,
  ): void;
}

export interface ParentframeOptions {
  transport: ParentframeTransport;
  fetchVersionFile: FetchVersionFile;
  onPhase?: (phase: LaunchPhase) => void;
  onProgress?: (progress: LoadProgress) => void;
  // Called when the game asks the host page to show its join QR code / invite link.
  onShowInviteRequest?: () => void;
  // Called when the host's game asks to end the session. Never called for a client.
  onEndGameRequest?: () => void;
  // Called when the host's game asks for a next round; `settings` is the
  // game's complete, shape-checked set. Never called for a client.
  onNextGameRequest?: (settings: Record<string, SettingValue>) => void;
  // How long to wait for the game's `hello` before giving up.
  handshakeTimeoutMs?: number;
  // Where the window `message` events arrive; defaults to `window`.
  messageTarget?: ParentframeMessageTarget;
}

export type LaunchOptions = {
  src: string;
  mode: NetworkMode;
  settings?: Record<string, SettingValue>;
  // Size of all the game's files; enables the byte-based progress estimate.
  totalBytes?: number;
  // The SDK major the game version is recorded with; defaults to this
  // package's own major.
  expectedMajor?: number;
} & (
  | { container: HTMLElement; iframeFactory?: never }
  // The factory attaches the iframe and points it at `src`.
  | { iframeFactory: (src: string) => GameframeHandle; container?: never }
);

export interface ParentframeConnection {
  mode: NetworkMode;
  clientId: string;
  serverId: string;
  close(): void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const MAX_NEXT_GAME_SETTINGS = 256;
const MAX_NEXT_GAME_STRING_LENGTH = 4096;
const MAX_NEXT_GAME_SELECTIONS = 256;
const PROGRESS_INTERVAL_MS = 100;
const MAX_ESTIMATED_FRACTION = 0.99;

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

function isSettingValue(value: unknown): value is SettingValue {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string")
    return value.length <= MAX_NEXT_GAME_STRING_LENGTH;
  return (
    Array.isArray(value) &&
    value.length <= MAX_NEXT_GAME_SELECTIONS &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length <= MAX_NEXT_GAME_STRING_LENGTH,
    )
  );
}

// The game is untrusted, so what it sends for `nextGame` is checked before it
// goes anywhere near the platform; the platform validates the values themselves.
function parseNextGameSettings(
  raw: unknown,
): Record<string, SettingValue> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const entries = Object.entries(raw);
  if (entries.length > MAX_NEXT_GAME_SETTINGS) return;
  const settings: Record<string, SettingValue> = {};
  for (const [key, value] of entries) {
    if (key.length > MAX_NEXT_GAME_STRING_LENGTH || !isSettingValue(value))
      return;
    settings[key] = value;
  }
  return settings;
}

// Parentframe bridges the host page and the embedded gameframe: it hands the
// game its files and, once both the game has said hello and the network is up,
// its context, and from then on forwards messages between the gameframe (over
// a MessageChannel) and a transport.
export class Parentframe {
  private readonly options: ParentframeOptions;
  private readonly messageTarget: ParentframeMessageTarget;
  private readonly onWindowMessage = (event: ParentframeMessageEvent) =>
    this.handleWindowMessage(event);

  private frame?: GameframeHandle;
  private createdIframe?: HTMLIFrameElement;
  private launchOptions?: LaunchOptions;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  private helloReceived = false;
  private stopServingFiles?: () => void;
  private controlPort?: MessagePort;
  private initialized = false;

  private identity?: TransportIdentity;
  private readonly peers = new Set<string>();
  private pendingData: ToGameframeDataMessage[] = [];
  private connection = defer<ParentframeConnection>();

  private loadedBytes = 0;
  private explicitFraction?: number;
  private explicitLabel?: string;
  private lastProgressAt = 0;
  // Once the game says it is done, late file-proxy byte counts must not reopen the overlay.
  private loadingDone = false;
  private progressTimer?: ReturnType<typeof setTimeout>;

  constructor(options: ParentframeOptions) {
    this.options = options;
    this.messageTarget = options.messageTarget ?? window;
  }

  // Attaches the message listener first, so a `hello` can never be missed,
  // then creates the iframe and starts the network in parallel. Resolves once
  // `init` has been delivered to the game.
  //
  // If the network fails the returned promise rejects but the frame stays
  // parked; `retryNetwork` runs the network step again without reloading it.
  launch(options: LaunchOptions): Promise<ParentframeConnection> {
    if (this.launchOptions) throw new Error("launch was already called");
    this.launchOptions = options;
    this.messageTarget.addEventListener("message", this.onWindowMessage);
    const timeoutMs =
      this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.handshakeTimer = setTimeout(
      () => this.connection.reject(new HandshakeTimeoutError(timeoutMs)),
      timeoutMs,
    );

    if (options.container) {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts allow-pointer-lock");
      iframe.allow = "fullscreen";
      iframe.style.cssText = "width:100%;height:100%;border:0";
      iframe.src = options.src;
      options.container.appendChild(iframe);
      this.createdIframe = iframe;
      this.frame = iframe;
    } else {
      this.frame = options.iframeFactory(options.src);
    }
    this.options.onPhase?.("frame-created");

    void this.startNetwork();
    return this.connection.promise;
  }

  retryNetwork(): Promise<ParentframeConnection> {
    if (!this.launchOptions) throw new Error("launch was not called");
    if (this.initialized) throw new Error("the game was already initialized");
    this.connection = defer();
    this.identity = undefined;
    this.peers.clear();
    this.pendingData = [];
    void this.startNetwork();
    return this.connection.promise;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.progressTimer);
    this.messageTarget.removeEventListener("message", this.onWindowMessage);
    this.closePorts();
    this.options.transport.close();
    this.createdIframe?.remove();
  }

  private async startNetwork() {
    const { mode } = this.launchOptions!;
    try {
      const identity = await this.options.transport.connect(mode, {
        onData: (peerId, channel, data) => {
          const message: ToGameframeDataMessage = {
            type: "msg",
            fromclientid: peerId,
            channel,
            data,
          };
          if (this.initialized) {
            this.postToGame(message, [data.buffer]);
          } else {
            this.pendingData.push(message);
          }
        },
        onPeerConnected: (peerId) => {
          this.peers.add(peerId);
          if (this.initialized)
            this.postToGame({ type: "con", clientid: peerId });
        },
        onPeerDisconnected: (peerId) => {
          this.peers.delete(peerId);
          if (this.initialized)
            this.postToGame({ type: "dc", clientid: peerId });
        },
      });
      if (this.destroyed) return;
      if (mode === "client" && !identity.serverId) {
        this.options.transport.close();
        throw new NoServerAvailableError();
      }
      this.identity = identity;
      this.options.onPhase?.("network-ready");
      this.maybeInit();
    } catch (error) {
      this.connection.reject(error);
    }
  }

  private handleWindowMessage(event: ParentframeMessageEvent) {
    if (!this.frame || event.source !== this.frame.contentWindow) return;
    const message = event.data as FromGameframeWindowMessage | undefined;
    if (message?.type === "hello") this.handleHello(message.sdkVersion);
  }

  private handleHello(sdkVersion: unknown) {
    const expectedMajor = this.launchOptions!.expectedMajor ?? ownMajor;
    const gameVersion = String(sdkVersion);
    if (majorOf(gameVersion) !== expectedMajor) {
      this.postToWindow({
        type: "reject",
        reason: `the platform runs SDK major ${expectedMajor} but the game bundles ${gameVersion}`,
      });
      this.connection.reject(
        new SdkMajorMismatchError(expectedMajor, gameVersion),
      );
      return;
    }

    const firstHello = !this.helloReceived;
    this.helloReceived = true;
    clearTimeout(this.handshakeTimer);
    this.closePorts();
    this.initialized = false;
    this.loadingDone = false;

    const fetchChannel = new MessageChannel();
    this.stopServingFiles = serveFetchPort(fetchChannel.port1, {
      fetchVersionFile: this.options.fetchVersionFile,
      onBytes: (bytes) => this.countBytes(bytes),
    });
    this.postToWindow({ type: "fetch-port" }, [fetchChannel.port2]);
    if (firstHello) this.options.onPhase?.("hello-received");
    this.maybeInit();
  }

  private maybeInit() {
    if (!this.helloReceived || !this.identity || this.initialized) return;
    const { mode, settings } = this.launchOptions!;
    const identity = this.identity;

    const channel = new MessageChannel();
    this.controlPort = channel.port1;
    channel.port1.onmessage = (event) => this.handleGameMessage(event.data);
    const serverId = mode === "server" ? identity.clientId : identity.serverId!;
    // A client always has its server among its peers, whether or not the
    // transport reported it as connected on its own.
    if (mode === "client") this.peers.add(serverId);
    const init: ToGameframeInitMessage = {
      type: "init",
      role: mode,
      ownId: identity.clientId,
      serverId,
      settings: settings ?? {},
      initialPeers: [...this.peers],
    };
    this.postToWindow(init, [channel.port2]);
    this.initialized = true;
    for (const message of this.pendingData.splice(0)) {
      this.postToGame(message, [message.data.buffer]);
    }
    this.options.onPhase?.("running");
    this.connection.resolve({
      mode,
      clientId: identity.clientId,
      serverId: init.serverId,
      close: () => this.options.transport.close(),
    });
  }

  private handleGameMessage(message: FromGameframeMessage | undefined) {
    switch (message?.type) {
      case "msg":
        this.options.transport.send(
          message.toclientid,
          message.channel,
          message.data,
        );
        break;
      case "drp":
        this.options.transport.drop(message.clientid);
        break;
      case "showinvite":
        this.options.onShowInviteRequest?.();
        break;
      case "endgame":
        if (this.launchOptions?.mode === "server")
          this.options.onEndGameRequest?.();
        break;
      case "nextgame": {
        if (this.launchOptions?.mode !== "server") break;
        const settings = parseNextGameSettings(message.settings);
        if (settings) this.options.onNextGameRequest?.(settings);
        break;
      }
      case "progress":
        if (
          typeof message.fraction === "number" &&
          Number.isFinite(message.fraction)
        ) {
          this.explicitFraction = Math.min(1, Math.max(0, message.fraction));
        }
        if (typeof message.label === "string") {
          this.explicitLabel = message.label;
        }
        this.reportProgress(false);
        break;
      case "done":
        this.reportProgress(true);
        break;
    }
  }

  private countBytes(bytes: number) {
    this.loadedBytes += bytes;
    const sinceLastReport = Date.now() - this.lastProgressAt;
    if (sinceLastReport >= PROGRESS_INTERVAL_MS) {
      this.reportProgress(false);
    } else {
      // Without this the last chunks of a fast (cached) download would never show.
      this.progressTimer ??= setTimeout(
        () => this.reportProgress(false),
        PROGRESS_INTERVAL_MS - sinceLastReport,
      );
    }
  }

  private reportProgress(done: boolean) {
    clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    if (this.loadingDone && !done) return;
    this.loadingDone ||= done;
    this.lastProgressAt = Date.now();
    const { totalBytes } = this.launchOptions ?? {};
    const estimate =
      totalBytes && totalBytes > 0
        ? Math.min(MAX_ESTIMATED_FRACTION, this.loadedBytes / totalBytes)
        : undefined;
    this.options.onProgress?.({
      fraction: done ? 1 : (this.explicitFraction ?? estimate),
      label: this.explicitLabel,
      loadedBytes: this.loadedBytes,
      done,
    });
  }

  private postToWindow(
    message: ToGameframeWindowMessage,
    transfer: Transferable[] = [],
  ) {
    this.frame?.contentWindow?.postMessage(message, "*", transfer);
  }

  private postToGame(
    message: ToGameframeMessage,
    transfer: Transferable[] = [],
  ) {
    this.controlPort?.postMessage(message, transfer);
  }

  private closePorts() {
    this.stopServingFiles?.();
    this.controlPort?.close();
    this.stopServingFiles = undefined;
    this.controlPort = undefined;
  }
}
