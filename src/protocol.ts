// The four delivery guarantees a message can be sent with. The transport
// establishes one data channel per combination between each player and the
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

// The most a game may hand to its next round, in UTF-8 bytes.
export const MAX_CARRY_OVER_BYTES = 1024 * 1024;

// The part a player takes in the game's network.
export type NetworkRole = "server" | "client";

// A participant in the game. The name is the player's display name, supplied
// by the platform; it is not unique, so games identify players by `id`.
export interface Player {
  id: string;
  name: string;
}

// A setting value as the game receives it, carrying the type the setting was
// declared with.
export type SettingValue = boolean | number | string | string[];

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
  role: NetworkRole;
  self: Player;
  server: Player;
  settings: Record<string, SettingValue>;
  initialPlayers: Player[];
  // What the previous round's host game handed over; only ever set for the host.
  carryOver?: string;
};
export type ToGameframeRejectMessage = { type: "reject"; reason: string };
export type ToGameframeWindowMessage =
  | ToGameframeFetchPortMessage
  | ToGameframeInitMessage
  | ToGameframeRejectMessage;

// --- gameframe -> parentframe, via the control port ---

export type FromGameframeSendMessage = {
  type: "send";
  toPlayerId: string;
  channel: Channel;
  data: Uint8Array;
};
export type FromGameframeDisconnectPlayerMessage = {
  type: "disconnect-player";
  playerId: string;
};
// Asks the host page to show its join QR code / invite link.
export type FromGameframeShowInviteMessage = { type: "show-invite" };
export type FromGameframeProgressMessage = {
  type: "progress";
  fraction?: number;
  label?: string;
};
export type FromGameframeProgressDoneMessage = { type: "progress-done" };
// Asks the host page to send everyone back to the lobby; honoured for the host only.
export type FromGameframeEndGameMessage = { type: "end-game" };
// Asks the host page to start the next round with these settings, which replace
// the lobby's complete set; the host confirms first. Honoured for the host only.
// `carryOver` is any string for the host's game in the next round.
export type FromGameframeNextRoundMessage = {
  type: "next-round";
  settings: Record<string, SettingValue>;
  carryOver?: string;
};
export type FromGameframeMessage =
  | FromGameframeSendMessage
  | FromGameframeDisconnectPlayerMessage
  | FromGameframeShowInviteMessage
  | FromGameframeProgressMessage
  | FromGameframeProgressDoneMessage
  | FromGameframeEndGameMessage
  | FromGameframeNextRoundMessage;

// --- parentframe -> gameframe, via the control port ---

export type ToGameframePlayerConnectedMessage = {
  type: "player-connected";
  player: Player;
};
export type ToGameframePlayerDisconnectedMessage = {
  type: "player-disconnected";
  playerId: string;
};
export type ToGameframeDataMessage = {
  type: "message";
  fromPlayerId: string;
  channel: Channel;
  data: Uint8Array;
};
export type ToGameframeMessage =
  | ToGameframePlayerConnectedMessage
  | ToGameframePlayerDisconnectedMessage
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
