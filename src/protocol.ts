// The four delivery guarantees a message can be sent with. The transport
// establishes one data channel per combination between each peer and the
// server; the game chooses per message which one to use.
//
// The numeric values are the channel index shared across the SDK, the
// parentframe and the relay — do not reorder.
export const Channel = {
  ReliableOrdered: 0,
  ReliableUnordered: 1,
  UnreliableOrdered: 2,
  UnreliableUnordered: 3,
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export const CHANNEL_COUNT = 4;

export type NetworkMode = "server" | "client";

// Within one SDK major these shapes only ever grow (new optional fields, new
// message types); published games keep their bundled SDK forever.

// --- gameframe -> parentframe, via window.postMessage ---

export type FromGameframeHelloMessage = { type: "hello"; sdkVersion: string };
export type FromGameframeWindowMessage = FromGameframeHelloMessage;

// --- parentframe -> gameframe, via window.postMessage ---

// Carries the port the gameframe sends its (proxied) file requests through.
export type ToGameframeFetchPortMessage = { type: "fetch-port" };
// Carries the control port; once received the game may start.
export type ToGameframeInitMessage = {
  type: "init";
  role: NetworkMode;
  ownId: string;
  serverId: string;
  settings: Record<string, string>;
  initialPeers: string[];
};
export type ToGameframeRejectMessage = { type: "reject"; reason: string };
export type ToGameframeWindowMessage =
  | ToGameframeFetchPortMessage
  | ToGameframeInitMessage
  | ToGameframeRejectMessage;

// --- gameframe -> parentframe, via the control port ---

export type FromGameframeDataMessage = {
  type: "msg";
  toclientid: string;
  channel: Channel;
  data: Uint8Array;
};
export type FromGameframeDroppedMessage = { type: "drp"; clientid: string };
// Asks the host page to show its join QR code / invite link.
export type FromGameframeShowInviteMessage = { type: "showinvite" };
export type FromGameframeProgressMessage = {
  type: "progress";
  fraction?: number;
  label?: string;
};
export type FromGameframeDoneMessage = { type: "done" };
export type FromGameframeMessage =
  | FromGameframeDataMessage
  | FromGameframeDroppedMessage
  | FromGameframeShowInviteMessage
  | FromGameframeProgressMessage
  | FromGameframeDoneMessage;

// --- parentframe -> gameframe, via the control port ---

export type ToGameframeConnectedMessage = { type: "con"; clientid: string };
export type ToGameframeDisconnectedMessage = { type: "dc"; clientid: string };
export type ToGameframeDataMessage = {
  type: "msg";
  fromclientid: string;
  channel: Channel;
  data: Uint8Array;
};
export type ToGameframeMessage =
  | ToGameframeConnectedMessage
  | ToGameframeDisconnectedMessage
  | ToGameframeDataMessage;

// --- fetch port (transferred with `fetch-port`), gameframe -> parentframe ---

export type FetchRequestMessage = {
  type: "fetch";
  id: number;
  // Relative to the version's root, still percent-encoded as in the URL.
  path: string;
  query: string;
  method: "GET" | "HEAD";
  range?: string;
};
export type FetchCancelMessage = { type: "cancel"; id: number };
// Returns `bytes` of the parentframe's send window once the game consumed them.
export type FetchCreditMessage = { type: "credit"; id: number; bytes: number };
export type FromGameframeFetchMessage =
  FetchRequestMessage | FetchCancelMessage | FetchCreditMessage;

// --- fetch port, parentframe -> gameframe ---

export type ToGameframeFetchHeadMessage = {
  type: "head";
  id: number;
  status: number;
  statusText: string;
  headers: [string, string][];
};
export type ToGameframeFetchChunkMessage = {
  type: "chunk";
  id: number;
  data: Uint8Array;
};
export type ToGameframeFetchEndMessage = { type: "end"; id: number };
export type ToGameframeFetchErrorMessage = {
  type: "error";
  id: number;
  message: string;
};
export type ToGameframeFetchMessage =
  | ToGameframeFetchHeadMessage
  | ToGameframeFetchChunkMessage
  | ToGameframeFetchEndMessage
  | ToGameframeFetchErrorMessage;
