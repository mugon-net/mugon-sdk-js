export const PROTOCOL = "mugonframe/1" as const;

export type ToGrameframeReadyMessage = { type: "rdy"; protocol: string };
export type ToGrameframeConnectedMessage = { type: "con"; clientid: string };
export type ToGrameframeDisconnectedMessage = { type: "dc"; clientid: string };
export type ToGameframeDataMessage = {
  type: "msg";
  fromclientid: string;
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
  data: Uint8Array;
};
export type FromGameframeDroppedMessage = { type: "drp"; clientid: string };
export type FromGameframeMessage =
  | FromGameframeReadyMessage
  | FromGameframeDataMessage
  | FromGameframeDroppedMessage;
