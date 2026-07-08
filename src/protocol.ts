export const PROTOCOL = "mugonframe/1" as const;

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

export type ToGrameframeReadyMessage = { type: "rdy"; protocol: string };
export type ToGrameframeConnectedMessage = { type: "con"; clientid: string };
export type ToGrameframeDisconnectedMessage = { type: "dc"; clientid: string };
export type ToGameframeDataMessage = {
  type: "msg";
  fromclientid: string;
  channel: Channel;
  data: Uint8Array;
};
export type ToGameframeSettingsMessage = {
  type: "set";
  settings: Record<string, string>;
};
export type ToGameframeMessage =
  | ToGrameframeReadyMessage
  | ToGrameframeConnectedMessage
  | ToGrameframeDisconnectedMessage
  | ToGameframeDataMessage
  | ToGameframeSettingsMessage;

export type FromGameframeReadyMessage = { type: "rdy"; protocol: string };
export type FromGameframeDataMessage = {
  type: "msg";
  toclientid: string;
  channel: Channel;
  data: Uint8Array;
};
export type FromGameframeDroppedMessage = { type: "drp"; clientid: string };
export type FromGameframeMessage =
  | FromGameframeReadyMessage
  | FromGameframeDataMessage
  | FromGameframeDroppedMessage;
