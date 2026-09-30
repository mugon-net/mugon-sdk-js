export interface BoundedTee {
  // The branch whose consumer must never be held up by the other one.
  primary: ReadableStream<Uint8Array>;
  secondary: ReadableStream<Uint8Array>;
  // Starts holding the source back for the secondary branch instead of dropping
  // the branch when it falls too far behind. Returns false if it was dropped
  // already.
  admitSecondary(): boolean;
}

// Like `ReadableStream.tee()`, but the source is only read while neither branch
// holds more than `limitBytes`, so the faster consumer can't make the slower
// one's backlog (and so memory) grow without bound. A secondary branch that has
// not been admitted yet is dropped when it overflows, because waiting for it
// would stall the primary consumer.
export function teeBounded(
  source: ReadableStream<Uint8Array>,
  limitBytes: number,
): BoundedTee {
  interface Branch {
    controller?: ReadableStreamDefaultController<Uint8Array>;
    finished: boolean;
    admitted: boolean;
    dropped: boolean;
  }
  const reader = source.getReader();
  const primary: Branch = { finished: false, admitted: true, dropped: false };
  const secondary: Branch = {
    finished: false,
    admitted: false,
    dropped: false,
  };
  let pumping = false;
  let sourceDone = false;

  const createStream = (branch: Branch) =>
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          branch.controller = controller;
        },
        pull() {
          void pump();
        },
        cancel() {
          branch.finished = true;
          void pump();
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: limitBytes }),
    );

  const isFull = (branch: Branch) => (branch.controller!.desiredSize ?? 0) <= 0;

  function drop(branch: Branch) {
    branch.finished = true;
    branch.dropped = true;
    branch.controller!.error(new Error("branch fell behind and was dropped"));
  }

  async function pump() {
    if (pumping || sourceDone) return;
    pumping = true;
    try {
      while (true) {
        const live = [primary, secondary].filter((branch) => !branch.finished);
        if (live.length === 0) {
          sourceDone = true;
          await reader.cancel().catch(() => {});
          return;
        }
        const full = live.find(isFull);
        if (full) {
          if (full.admitted) return;
          drop(full);
          continue;
        }
        const { done, value } = await reader.read();
        if (done) {
          sourceDone = true;
          for (const branch of live) {
            if (!branch.finished) branch.controller!.close();
            branch.finished = true;
          }
          return;
        }
        // A consumer may transfer its chunk away, so each branch gets its own copy.
        const copy = secondary.finished ? undefined : value.slice();
        if (!primary.finished) primary.controller!.enqueue(value);
        if (copy && !secondary.finished) secondary.controller!.enqueue(copy);
      }
    } catch (error) {
      sourceDone = true;
      for (const branch of [primary, secondary]) {
        if (!branch.finished) branch.controller!.error(error);
        branch.finished = true;
      }
    } finally {
      pumping = false;
    }
  }

  return {
    primary: createStream(primary),
    secondary: createStream(secondary),
    admitSecondary() {
      if (secondary.dropped) return false;
      secondary.admitted = true;
      void pump();
      return true;
    },
  };
}
