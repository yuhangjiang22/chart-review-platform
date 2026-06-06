// app/server/message-queue.ts — async iterable user-message queue used by
// long-lived agent sessions (chat-side AgentSession, builder-side BuilderSession).
//
// Pushes messages from the WebSocket layer into a queue that the SDK's `query()`
// reads as its `prompt` async iterable.

export type UserMessage = {
  type: "user";
  message: { role: "user"; content: string };
};

export class MessageQueue {
  private messages: UserMessage[] = [];
  private waiting: ((msg: UserMessage) => void) | null = null;
  private closed = false;

  push(content: string) {
    const msg: UserMessage = {
      type: "user",
      message: { role: "user", content },
    };
    if (this.waiting) {
      this.waiting(msg);
      this.waiting = null;
    } else {
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<UserMessage> {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        yield await new Promise<UserMessage>((resolve) => {
          this.waiting = resolve;
        });
      }
    }
  }

  close() {
    this.closed = true;
  }
}
