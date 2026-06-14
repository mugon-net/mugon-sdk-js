// global.d.ts
import type {
  disconnect,
  getSettingValue,
  sendDataMessage,
  setupParentFrameCommunication,
  startCanvasManager,
} from "./gameframe";

declare global {
  interface Window {
    setupParentFrameCommunication?: typeof setupParentFrameCommunication;
    startCanvasManager?: typeof startCanvasManager;
    disconnect?: typeof disconnect;
    sendDataMessage?: typeof sendDataMessage;
    getSettingValue?: typeof getSettingValue;
  }
}
