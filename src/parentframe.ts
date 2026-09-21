import {
  Channel,
  FromGameframeMessage,
  PROTOCOL,
  ToGameframeDataMessage,
  ToGameframeSettingsMessage,
  ToGrameframeConnectedMessage,
  ToGrameframeDisconnectedMessage,
} from "./protocol";

export type NetworkMode = "server" | "client";

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

// Thrown by Parentframe.connect("client") when no server peer is available yet,
// so the caller can surface a distinct message.
export class NoServerAvailableError extends Error {
  constructor() {
    super("no server has connected yet");
    this.name = "NoServerAvailableError";
  }
}

export interface ParentframeOptions {
  // The iframe hosting the game; the parentframe hands it one end of a
  // MessageChannel once it loads.
  gameFrame: HTMLIFrameElement;
  // The transport used to reach the other peers.
  transport: ParentframeTransport;
  // Called when the gameframe reports a protocol version different from the one
  // this SDK speaks; the connection is unusable in that case.
  onProtocolMismatch?: (gameProtocol: string, expected: string) => void;
  // Called once the gameframe acknowledges the handshake with a matching
  // protocol version.
  onHandshakeComplete?: () => void;
}

export interface ParentframeConnection {
  mode: NetworkMode;
  clientId: string;
  serverId?: string;
  close(): void;
}

// Parentframe bridges the host page and the embedded gameframe: it forwards
// messages between the gameframe (over a MessageChannel) and a transport,
// translating the SDK's gameframe protocol into transport calls and back.
export class Parentframe {
  private readonly options: ParentframeOptions;
  private readonly transport: ParentframeTransport;
  private port!: MessagePort;
  private settings: Record<string, string> = {};
  // Resolves once the gameframe has acked our "init" with its own "rdy" -- see
  // establishChildHandshake for why this can't just happen once in the constructor.
  private readonly childReady: Promise<void>;

  constructor(options: ParentframeOptions) {
    this.options = options;
    this.transport = options.transport;
    this.childReady = this.establishChildHandshake();
  }

  // The gameframe only starts listening for our "init" message once its own code
  // (wasm or otherwise) has loaded far enough to call setupParentFrameCommunication
  // -- which, for a large wasm module (seen in practice: 100+ MB uncompressed), can
  // take many seconds. A plain `window.postMessage` isn't buffered for a listener
  // that doesn't exist yet, so a one-shot send silently drops both the message and
  // its one-use transferable MessagePort if the gameframe isn't ready in time -- and
  // everything downstream (settings, connect/disconnect, data) rides on that same
  // port, so nothing ever arrives again. Fix: keep resending "init" with a fresh
  // MessageChannel (a transferred port can't be reused) until the gameframe's own
  // "rdy" ack comes back.
  //
  // Retrying on a plain interval, not gated behind the iframe's own "load" event:
  // "load" fires once the surrounding HTML/JS shell's own top-level script execution
  // finishes, which for a wasm-based game is long before the wasm itself has
  // actually loaded and registered a listener -- so a slow-booting game leaves a
  // multi-second window during which anything that reconstructs this `Parentframe`
  // (e.g. a parent-component re-render) would attach a fresh "load" listener that
  // can never fire again for a navigation that already happened, permanently
  // stalling the handshake. Starting the retry loop immediately removes that
  // dependency entirely: an attempt sent before the gameframe's listener exists is
  // simply dropped, exactly like an attempt sent too early already was.
  private establishChildHandshake(): Promise<void> {
    return new Promise((resolve) => {
      let acked = false;
      let intervalId: ReturnType<typeof setInterval> | undefined;

      const trySend = () => {
        if (acked) return;
        const channel = new MessageChannel();
        this.port = channel.port1;
        this.port.onmessage = (event) => {
          if (
            !acked &&
            (event.data as FromGameframeMessage | undefined)?.type === "rdy"
          ) {
            acked = true;
            if (intervalId !== undefined) clearInterval(intervalId);
            resolve();
          }
          this.handleChildFrameMessage(event);
        };
        this.options.gameFrame.contentWindow?.postMessage(
          { type: "init" },
          "*",
          [channel.port2],
        );
      };

      trySend();
      intervalId = setInterval(trySend, 300);
    });
  }

  async connect(mode: NetworkMode): Promise<ParentframeConnection> {
    await this.childReady;
    const identity = await this.transport.connect(mode, {
      onData: (peerId, channel, data) => {
        const msg: ToGameframeDataMessage = {
          type: "msg",
          fromclientid: peerId,
          channel,
          data,
        };
        this.port.postMessage(msg, [data.buffer]);
      },
      onPeerConnected: (peerId) => {
        const msg: ToGrameframeConnectedMessage = {
          type: "con",
          clientid: peerId,
        };
        this.port.postMessage(msg);
      },
      onPeerDisconnected: (peerId) => {
        const msg: ToGrameframeDisconnectedMessage = {
          type: "dc",
          clientid: peerId,
        };
        this.port.postMessage(msg);
      },
    });

    if (mode === "client" && !identity.serverId) {
      this.transport.close();
      throw new NoServerAvailableError();
    }

    this.settings = { "mugon.networkmode": mode };
    if (mode === "server") {
      this.settings["mugon.serverid"] = identity.clientId;
    } else {
      this.settings["mugon.clientid"] = identity.clientId;
      this.settings["mugon.serverid"] = identity.serverId!;
    }

    this.sendSettings();
    setTimeout(() => this.sendReady(), 250);

    return {
      mode,
      clientId: identity.clientId,
      serverId: identity.serverId,
      close: () => this.transport.close(),
    };
  }

  private handleChildFrameMessage(event: MessageEvent<FromGameframeMessage>) {
    const msg = event.data;

    switch (msg.type) {
      case "rdy":
        if (msg.protocol !== PROTOCOL) {
          this.options.onProtocolMismatch?.(msg.protocol, PROTOCOL);
        } else {
          this.options.onHandshakeComplete?.();
        }
        break;
      case "msg":
        this.transport.send(msg.toclientid, msg.channel, msg.data);
        break;
      case "drp":
        this.transport.drop(msg.clientid);
        break;
    }
  }

  private sendSettings() {
    const msg: ToGameframeSettingsMessage = {
      type: "set",
      settings: this.settings,
    };
    this.port.postMessage(msg);
  }

  private sendReady() {
    this.port.postMessage({ type: "rdy", protocol: PROTOCOL });
  }
}
