export function setupParentFrameCommunication() {
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
