// global.d.ts
import type {
  disconnect,
  getSettingValue,
  requestFullscreen,
  sendDataMessage,
  setupParentFrameCommunication,
  showInvite,
  startCanvasManager,
} from "./gameframe";

declare global {
  interface Window {
    setupParentFrameCommunication?: typeof setupParentFrameCommunication;
    startCanvasManager?: typeof startCanvasManager;
    disconnect?: typeof disconnect;
    sendDataMessage?: typeof sendDataMessage;
    requestFullscreen?: typeof requestFullscreen;
    showInvite?: typeof showInvite;
    getSettingValue?: typeof getSettingValue;
  }
}
