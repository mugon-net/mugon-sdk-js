import { version } from "./version";

export type MessageToParentFrame =
  | { type: "rdy"; version: number }
  | { type: "dc" };

export type MessageToGameFrame = { type: "start"; version: number };

export function setupParentFrameCommunication() {
  const initMsg: MessageToParentFrame = { type: "rdy", version: version };
  window.parent.postMessage({ initMsg }, { targetOrigin: "*" });
  console.log("TODO");
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
