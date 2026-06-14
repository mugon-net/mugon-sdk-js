import {
  PROTOCOL,
  ToGameframeDataMessage,
  ToGameframeMessage,
  ToGrameframeConnectedMessage,
  ToGrameframeDisconnectedMessage,
  ToGrameframeReadyMessage,
} from "./protocol";

let callbacks:
  | undefined
  | {
      onReadyMsg: (msg: ToGrameframeReadyMessage) => void;
      onConnectMsg: (msg: ToGrameframeConnectedMessage) => void;
      onDisconnectMsg: (msg: ToGrameframeDisconnectedMessage) => void;
      onDataMsg: (msg: ToGameframeDataMessage) => void;
    } = undefined;

export function setupParentFrameCommunication(
  onReadyMsg: (msg: ToGrameframeReadyMessage) => void,
  onConnectMsg: (msg: ToGrameframeConnectedMessage) => void,
  onDisconnectMsg: (msg: ToGrameframeDisconnectedMessage) => void,
  onDataMsg: (msg: ToGameframeDataMessage) => void,
) {
  callbacks = {
    onReadyMsg: onReadyMsg,
    onConnectMsg: onConnectMsg,
    onDisconnectMsg: onDisconnectMsg,
    onDataMsg: onDataMsg,
  };
  window.onmessage = handleParentFrameMessage;

  window.parent.postMessage(
    { type: "rdy", protocol: PROTOCOL },
    { targetOrigin: "*" },
  );
  console.log("Gameframe ready");
}

export function startCanvasManager() {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      canvas.width = entry.contentRect.width;
      canvas.height = entry.contentRect.height;
    }
  });
  observer.observe(canvas);
}

export function disconnect(id: string) {}

export function sendDataMessage(id: string, data: Uint8Array) {}

export function getSettingValue(
  id: "mugon.networkmode" | "mugon.serverid" | "mugon.clientid" | string,
): string {
  // todo request from parent frame, wait for response, return response
  return "TODO";
}

function handleParentFrameMessage(event: MessageEvent) {
  // if (event.origin !== "http://localhost:3000") return; // TODO
  if (!("type" in event.data)) return;
  const msg = event.data as ToGameframeMessage;

  switch (msg.type) {
    case "rdy":
      callbacks?.onReadyMsg(msg);
      break;
    case "con":
      callbacks?.onConnectMsg(msg);
      break;
    case "dc":
      callbacks?.onDisconnectMsg(msg);
      break;
    case "msg":
      callbacks?.onDataMsg(msg);
      break;
  }
}

// For cases where the calling party can't import this library
// e.g. when calling functions from wasm
export function injectClientApiIntoWindowObject() {
  window.setupParentFrameCommunication = setupParentFrameCommunication;
  window.startCanvasManager = startCanvasManager;
  window.disconnect = disconnect;
  window.sendDataMessage = sendDataMessage;
  window.getSettingValue = getSettingValue;
}
