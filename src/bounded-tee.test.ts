import { describe, expect, it, vi } from "vitest";
import { teeBounded } from "./bounded-tee";

const CHUNK = 1000;
const LIMIT = 4 * CHUNK;

function makeSource(chunkCount: number, onCancel?: () => void) {
  const state = { produced: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.produced === chunkCount) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(CHUNK).fill(state.produced % 251));
        state.produced++;
      },
      cancel: onCancel,
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function readAll(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

describe("teeBounded", () => {
  it("gives both branches the whole content as independent copies", async () => {
    const { stream } = makeSource(10);
    const tee = teeBounded(stream, LIMIT);
    tee.admitSecondary();

    const readPrimary = async () => {
      const chunks: Uint8Array[] = [];
      const reader = tee.primary.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) return chunks;
        chunks.push(value.slice());
        // A consumer that transfers its chunk away must not corrupt the other branch.
        structuredClone(value.buffer, { transfer: [value.buffer] });
      }
    };
    const [primary, secondary] = await Promise.all([
      readPrimary(),
      readAll(tee.secondary),
    ]);
    for (const chunks of [primary, secondary]) {
      expect(chunks).toHaveLength(10);
      chunks.forEach((chunk, index) =>
        expect([...chunk]).toEqual(new Array(CHUNK).fill(index % 251)),
      );
    }
  });

  it("holds the source back while an admitted branch is slow", async () => {
    const { stream, state } = makeSource(100);
    const tee = teeBounded(stream, LIMIT);
    tee.admitSecondary();

    const primary = tee.primary.getReader();
    let received = 0;
    void (async () => {
      while (true) {
        const { done } = await primary.read();
        if (done) return;
        received++;
      }
    })();
    await settle();

    // The secondary consumer has not read anything: at most its limit (plus
    // the chunk in flight) may have been read from the source.
    expect(state.produced).toBeLessThanOrEqual(LIMIT / CHUNK + 2);
    expect(received).toBeLessThanOrEqual(LIMIT / CHUNK + 2);

    const secondary = await readAll(tee.secondary);
    await vi.waitFor(() => expect(received).toBe(100));
    expect(secondary).toHaveLength(100);
  });

  it("drops a branch that overflows before it is admitted, without stalling the primary", async () => {
    const { stream } = makeSource(100);
    const tee = teeBounded(stream, LIMIT);
    const primary = await readAll(tee.primary);
    expect(primary).toHaveLength(100);
    expect(tee.admitSecondary()).toBe(false);
    await expect(readAll(tee.secondary)).rejects.toThrow();
  });

  it("keeps a branch that is admitted before it overflows", async () => {
    const { stream } = makeSource(3);
    const tee = teeBounded(stream, LIMIT);
    expect(await readAll(tee.primary)).toHaveLength(3);
    expect(tee.admitSecondary()).toBe(true);
    expect(await readAll(tee.secondary)).toHaveLength(3);
  });

  it("keeps serving the secondary when the primary is cancelled, and cancels the source once both are", async () => {
    const onCancel = vi.fn();
    const { stream } = makeSource(10, onCancel);
    const tee = teeBounded(stream, LIMIT);
    tee.admitSecondary();
    await tee.primary.cancel();
    expect(await readAll(tee.secondary)).toHaveLength(10);

    const cancelled = makeSource(10, onCancel);
    const second = teeBounded(cancelled.stream, LIMIT);
    await second.primary.cancel();
    await second.secondary.cancel();
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it("errors both branches when the source fails", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error("connection lost"));
      },
    });
    const tee = teeBounded(failing, LIMIT);
    tee.admitSecondary();
    await expect(readAll(tee.primary)).rejects.toThrow("connection lost");
    await expect(readAll(tee.secondary)).rejects.toThrow("connection lost");
  });
});
