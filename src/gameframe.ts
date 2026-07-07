import {
  PROTOCOL,
  ToGameframeDataMessage,
  ToGameframeMessage,
  ToGameframeSettingsMessage,
  ToGrameframeConnectedMessage,
  ToGrameframeDisconnectedMessage,
  ToGrameframeReadyMessage,
} from "./protocol";

let callbacks:
  | undefined
  | {
      onReadyMsg?: (msg: ToGrameframeReadyMessage) => void;
      onConnectMsg?: (msg: ToGrameframeConnectedMessage) => void;
      onDisconnectMsg?: (msg: ToGrameframeDisconnectedMessage) => void;
      onDataMsg?: (msg: ToGameframeDataMessage) => void;
      onSettingsMsg?: (msg: ToGameframeSettingsMessage) => void;
    } = undefined;

let port: undefined | MessagePort = undefined;
let settings: undefined | Record<string, string> = undefined;

export function setupParentFrameCommunication(
  onReadyMsg?: (msg: ToGrameframeReadyMessage) => void,
  onConnectMsg?: (msg: ToGrameframeConnectedMessage) => void,
  onDisconnectMsg?: (msg: ToGrameframeDisconnectedMessage) => void,
  onDataMsg?: (msg: ToGameframeDataMessage) => void,
  onSettingsMsg?: (msg: ToGameframeSettingsMessage) => void,
) {
  callbacks = {
    onReadyMsg: onReadyMsg,
    onConnectMsg: onConnectMsg,
    onDisconnectMsg: onDisconnectMsg,
    onDataMsg: onDataMsg,
    onSettingsMsg: onSettingsMsg,
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    if (e.data?.type === "init" && e.ports[0]) {
      port = e.ports[0];
      port.onmessage = handleParentFrameMessage;
      port.postMessage({ type: "rdy", protocol: PROTOCOL });
      console.log("Gameframe initialized.");
    }
  });
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
  key: "mugon.networkmode" | "mugon.serverid" | "mugon.clientid" | string,
): string | undefined {
  if (!settings) {
    console.warn(
      "getSettingValue called before settings were received from the parent frame",
    );
    return undefined;
  }
  return settings[key];
}

function handleParentFrameMessage(event: MessageEvent) {
  // if (event.origin !== "http://localhost:3000") return; // TODO
  if (!("type" in event.data)) return;
  const msg = event.data as ToGameframeMessage;

  switch (msg.type) {
    case "rdy":
      callbacks?.onReadyMsg?.(msg);
      break;
    case "con":
      callbacks?.onConnectMsg?.(msg);
      break;
    case "dc":
      callbacks?.onDisconnectMsg?.(msg);
      break;
    case "msg":
      callbacks?.onDataMsg?.(msg);
      break;
    case "set":
      settings = msg.settings;
      callbacks?.onSettingsMsg?.(msg);
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
