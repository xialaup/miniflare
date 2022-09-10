import assert from "assert";
import {
  EXTERNAL_SUBREQUEST_LIMIT_BUNDLED,
  InputGatedEventTarget,
  RequestContext,
  getRequestContext,
  kWrapListener,
  waitForOpenOutputGate,
} from "@miniflare/shared";

export class MessageEvent extends Event {
  readonly data: ArrayBuffer | string;

  constructor(type: "message", init: { data: ArrayBuffer | string }) {
    super(type);
    this.data = init.data;
  }
}

export class CloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;

  constructor(
    type: "close",
    init?: { code?: number; reason?: string; wasClean?: boolean }
  ) {
    super(type);
    this.code = init?.code ?? 1005;
    this.reason = init?.reason ?? "";
    this.wasClean = init?.wasClean ?? false;
  }
}

export class ErrorEvent extends Event {
  readonly error: Error | null;

  constructor(type: "error", init?: { error?: Error }) {
    super(type);
    this.error = init?.error ?? null;
  }
}

// Maps web sockets to the other side of their connections, we don't want to
// expose this to the user, but this cannot be a private field as we need to
// construct both sockets before setting the circular references
const kPair = Symbol("kPair");

export const kAccepted = Symbol("kAccepted");
export const kCoupled = Symbol("kCoupled");

// Whether close() has been called on the socket
export const kClosedOutgoing = Symbol("kClosedOutgoing");
// Whether a close event has been dispatched on the socket
export const kClosedIncoming = Symbol("kClosedIncoming");

// Internal send method exposed to bypass accept checking
export const kSend = Symbol("kSend");
// Internal close method exposed to bypass close code checking
export const kClose = Symbol("kClose");

export type WebSocketEventMap = {
  message: MessageEvent;
  close: CloseEvent;
  error: ErrorEvent;
};
export class WebSocket extends InputGatedEventTarget<WebSocketEventMap> {
  // The Workers runtime prefixes these constants with `READY_STATE_`, unlike
  // those in the spec: https://websockets.spec.whatwg.org/#interface-definition
  static readonly READY_STATE_CONNECTING = 0;
  static readonly READY_STATE_OPEN = 1;
  static readonly READY_STATE_CLOSING = 2;
  static readonly READY_STATE_CLOSED = 3;

  #sendQueue?: MessageEvent[] = [];
  [kPair]: WebSocket;
  [kAccepted] = false;
  [kCoupled] = false;
  [kClosedOutgoing] = false;
  [kClosedIncoming] = false;

  protected [kWrapListener]<Type extends keyof WebSocketEventMap>(
    listener: (event: WebSocketEventMap[Type]) => void
  ): (event: WebSocketEventMap[Type]) => void {
    // Get listener that applies input gating
    const wrappedListener = super[kWrapListener](listener);

    // Get the add/remove event listener context, not dispatch
    const addListenerCtx = getRequestContext();

    // Return new listener that dispatches events with the correct
    // request context, and also applies input gating
    return (event) => {
      // TODO: confirm this behaviour
      if (addListenerCtx?.durableObject || addListenerCtx === undefined) {
        // If this listener was registered inside a Durable Object, or outside
        // a request context, create a fresh context, with a new subrequest
        // counter, using the current depths
        const ctx = new RequestContext({
          requestDepth: addListenerCtx?.requestDepth,
          pipelineDepth: addListenerCtx?.pipelineDepth,
          externalSubrequestLimit:
            addListenerCtx?.externalSubrequestLimit ??
            EXTERNAL_SUBREQUEST_LIMIT_BUNDLED,
        });
        ctx.runWith(() => wrappedListener(event));
      } else {
        // Otherwise, if we're in a regular worker handler, share the request
        // context (i.e. share subrequest count)
        addListenerCtx.runWith(() => wrappedListener(event));
      }
    };
  }

  get readyState(): number {
    if (this[kClosedOutgoing] && this[kClosedIncoming]) {
      return WebSocket.READY_STATE_CLOSED;
    } else if (this[kClosedOutgoing] || this[kClosedIncoming]) {
      return WebSocket.READY_STATE_CLOSING;
    }
    return WebSocket.READY_STATE_OPEN;
  }

  accept(): void {
    if (this[kCoupled]) {
      throw new TypeError(
        "Can't accept() WebSocket that was already used in a response."
      );
    }

    if (this[kAccepted]) return;
    this[kAccepted] = true;

    const sendQueue = this.#sendQueue;
    if (sendQueue) {
      for (const event of sendQueue) this.dispatchEvent(event);
      this.#sendQueue = undefined;
    }
  }

  send(message: ArrayBuffer | string): void {
    if (!this[kAccepted]) {
      throw new TypeError(
        "You must call accept() on this WebSocket before sending messages."
      );
    }
    this[kSend](message);
  }

  [kSend](message: ArrayBuffer | string): void {
    if (this[kClosedOutgoing]) {
      throw new TypeError("Can't call WebSocket send() after close().");
    }

    const event = new MessageEvent("message", { data: message });
    void this.#dispatchMessageEvent(event);
  }

  async #dispatchMessageEvent(event: MessageEvent): Promise<void> {
    await waitForOpenOutputGate();
    const pair = this[kPair];
    if (pair[kAccepted]) {
      pair.dispatchEvent(event);
    } else {
      const sendQueue = pair.#sendQueue;
      assert(sendQueue !== undefined);
      sendQueue.push(event);
    }
  }

  close(code?: number, reason?: string): void {
    if (code) {
      // https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
      const validCode =
        code >= 1000 &&
        code < 5000 &&
        code !== 1004 &&
        code !== 1005 &&
        code !== 1006 &&
        code !== 1015;
      if (!validCode) throw new TypeError("Invalid WebSocket close code.");
    }
    if (reason !== undefined && code === undefined) {
      throw new TypeError(
        "If you specify a WebSocket close reason, you must also specify a code."
      );
    }
    this[kClose](code, reason);
  }

  [kClose](code?: number, reason?: string): void {
    // Split from close() so we don't check the close code when forwarding close
    // events from the client
    if (!this[kAccepted]) {
      throw new TypeError(
        "You must call accept() on this WebSocket before sending messages."
      );
    }
    if (this[kClosedOutgoing]) throw new TypeError("WebSocket already closed");
    this[kClosedOutgoing] = true;
    this[kPair][kClosedIncoming] = true;
    void this.#dispatchCloseEvent(code, reason);
  }

  async #dispatchCloseEvent(code?: number, reason?: string): Promise<void> {
    await waitForOpenOutputGate();
    // Send close event to pair, it should then eventually call `close()` on
    // itself which will dispatch a close event to us, completing the closing
    // handshake:
    //               Network
    //  Browser/Server  |   ws                            WebSocketPair
    //     -------      | -------                         -------------
    //     |     |  ... | |     | <--- 2) CloseEvent <--- | inc < out | <--- 1) close()
    //     |     |      | |     |                         |     |     |
    //     |     |  ... | |     | --->    3) close() ---> | out > inc | ---> 4) CloseEvent
    //     -------      | -------                         -------------
    //                  |
    this[kPair].dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

export type WebSocketPair = {
  0: WebSocket;
  1: WebSocket;
};

export const WebSocketPair: { new (): WebSocketPair } = function (
  this: WebSocketPair
) {
  if (!(this instanceof WebSocketPair)) {
    throw new TypeError(
      "Failed to construct 'WebSocketPair': Please use the 'new' operator, this object constructor cannot be called as a function."
    );
  }
  this[0] = new WebSocket();
  this[1] = new WebSocket();
  this[0][kPair] = this[1];
  this[1][kPair] = this[0];
} as any;
