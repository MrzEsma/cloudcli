(() => {
  // cloudcli-plugin-soniox/node_modules/@soniox/client/dist/index.mjs
  var SonioxError = class extends Error {
    /**
    * Error code describing the type of error.
    * Typed as `string` at the base level to allow subclasses (e.g. HTTP errors)
    * to use their own error code unions.
    */
    code;
    /**
    * HTTP status code when applicable (e.g., 401 for auth errors, 500 for server errors).
    */
    statusCode;
    /**
    * The underlying error that caused this error, if any.
    */
    cause;
    constructor(message, code = "soniox_error", statusCode, cause) {
      super(message);
      this.name = "SonioxError";
      this.code = code;
      this.statusCode = statusCode;
      this.cause = cause;
      if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
      Object.setPrototypeOf(this, new.target.prototype);
    }
    /**
    * Creates a human-readable string representation
    */
    toString() {
      const parts = [`${this.name} [${this.code}]: ${this.message}`];
      if (this.statusCode !== void 0) parts.push(`  Status: ${this.statusCode}`);
      return parts.join("\n");
    }
    /**
    * Converts to a plain object for logging/serialization
    */
    toJSON() {
      return {
        name: this.name,
        code: this.code,
        message: this.message,
        ...this.statusCode !== void 0 && { statusCode: this.statusCode }
      };
    }
  };
  var MAX_BODY_TEXT_LENGTH = 4096;
  var SonioxHttpError = class extends SonioxError {
    /** Request URL */
    url;
    /** HTTP method */
    method;
    /** Response headers (only for http_error) */
    headers;
    /** Response body text, capped at 4KB (only for http_error/parse_error) */
    bodyText;
    constructor(details) {
      super(details.message, details.code, details.statusCode, details.cause);
      this.name = "SonioxHttpError";
      this.url = details.url;
      this.method = details.method;
      this.headers = details.headers;
      this.bodyText = details.bodyText;
    }
    /**
    * Creates a human-readable string representation
    */
    toString() {
      const parts = [`SonioxHttpError [${this.code}]: ${this.message}`];
      parts.push(`  Method: ${this.method}`);
      parts.push(`  URL: ${this.url}`);
      if (this.statusCode !== void 0) parts.push(`  Status: ${this.statusCode}`);
      return parts.join("\n");
    }
    /**
    * Converts to a plain object for logging/serialization
    */
    toJSON() {
      return {
        name: this.name,
        code: this.code,
        message: this.message,
        url: this.url,
        method: this.method,
        ...this.statusCode !== void 0 && { statusCode: this.statusCode },
        ...this.headers !== void 0 && { headers: this.headers },
        ...this.bodyText !== void 0 && { bodyText: this.bodyText }
      };
    }
  };
  function createNetworkError(url, method, cause) {
    return new SonioxHttpError({
      code: "network_error",
      message: `Network error: ${cause instanceof Error ? cause.message : "Network request failed"}`,
      url,
      method,
      cause
    });
  }
  function createAbortError(url, method, cause) {
    return new SonioxHttpError({
      code: "aborted",
      message: "Request was aborted",
      url,
      method,
      cause
    });
  }
  function createHttpError(url, method, statusCode, headers, bodyText) {
    const cappedBody = truncateBodyText(bodyText);
    return new SonioxHttpError({
      code: "http_error",
      message: `HTTP ${statusCode}`,
      url,
      method,
      statusCode,
      headers,
      bodyText: cappedBody
    });
  }
  function truncateBodyText(text) {
    if (text.length <= MAX_BODY_TEXT_LENGTH) return text;
    return text.slice(0, MAX_BODY_TEXT_LENGTH) + "... [truncated]";
  }
  var DEFAULT_BASE_DOMAIN = "soniox.com";
  function urlsFromBase(base) {
    return {
      api_domain: `https://api.${base}`,
      stt_ws_url: `wss://stt-rt.${base}/transcribe-websocket`,
      tts_api_url: `https://tts-rt.${base}`,
      tts_ws_url: `wss://tts-rt.${base}/tts-websocket`
    };
  }
  function resolveConnectionConfig(config) {
    const { region, base_domain, api_domain, stt_ws_url, tts_api_url, tts_ws_url } = config;
    const normalizedRegion = region !== void 0 && region.toLowerCase() !== "us" ? region : void 0;
    const derived = urlsFromBase(base_domain ?? (normalizedRegion !== void 0 ? `${normalizedRegion}.soniox.com` : DEFAULT_BASE_DOMAIN));
    const sttDefaults = config.stt_defaults ?? config.session_defaults ?? {};
    return {
      api_key: config.api_key,
      api_domain: api_domain ?? derived.api_domain,
      stt_ws_url: stt_ws_url ?? derived.stt_ws_url,
      tts_api_url: tts_api_url ?? derived.tts_api_url,
      tts_ws_url: tts_ws_url ?? derived.tts_ws_url,
      stt_defaults: sttDefaults,
      tts_defaults: config.tts_defaults ?? {},
      session_defaults: sttDefaults
    };
  }
  var AsyncEventQueue = class {
    queue = [];
    waiters = [];
    done = false;
    error = null;
    /**
    * Push an event to the queue.
    * If there are waiting consumers, delivers immediately.
    */
    push(event) {
      if (this.done) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve({
        value: event,
        done: false
      });
      else this.queue.push(event);
    }
    /**
    * End the queue normally.
    * Waiting consumers will receive `{ done: true }`.
    */
    end() {
      if (this.done) return;
      this.done = true;
      this.flushWaiters();
    }
    /**
    * End the queue with an error.
    * Waiting consumers will have their promises rejected.
    * Future `next()` calls will also reject with this error.
    * Any queued events are discarded.
    */
    abort(error) {
      if (this.done) return;
      this.done = true;
      this.error = error;
      this.queue = [];
      this.flushWaiters();
    }
    /**
    * Whether the queue has ended (normally or with error).
    */
    get isDone() {
      return this.done;
    }
    /**
    * Drop buffered events without ending the queue.
    *
    * Intended for owners that know their consumer has gone away (e.g. an
    * async-iterator consumer broke out of its `for await` loop). The queue
    * remains active and accepts future pushes. Callers must ensure no other
    * iterator is concurrently consuming this queue, since this also drops
    * events those consumers would have observed.
    */
    clear() {
      this.queue = [];
    }
    /**
    * Async iterator implementation.
    *
    * The returned iterator implements `return()` so consumers that exit
    * `for await` early (via `break`, `throw`, or an outer `return`) cleanly
    * release the iteration without further work. The queue itself is left
    * in place — call {@link clear} or {@link end}/{@link abort} if buffered
    * events should also be dropped.
    */
    [Symbol.asyncIterator]() {
      return {
        next: () => this.next(),
        return: (value) => Promise.resolve({
          value,
          done: true
        })
      };
    }
    /**
    * Get the next event from the queue.
    */
    next() {
      const error = this.error;
      if (error) return Promise.reject(error);
      const event = this.queue.shift();
      if (event !== void 0) return Promise.resolve({
        value: event,
        done: false
      });
      if (this.done) return Promise.resolve({
        value: void 0,
        done: true
      });
      return new Promise((resolve, reject) => {
        this.waiters.push({
          resolve,
          reject
        });
      });
    }
    /**
    * Flush all waiting consumers when queue ends.
    */
    flushWaiters() {
      for (const { resolve, reject } of this.waiters) if (this.error) reject(this.error);
      else resolve({
        value: void 0,
        done: true
      });
      this.waiters = [];
    }
  };
  var TypedEmitter = class {
    listeners = /* @__PURE__ */ new Map();
    errorEvent = "error";
    /**
    * Register an event handler.
    */
    on(event, handler) {
      let handlers = this.listeners.get(event);
      if (!handlers) {
        handlers = /* @__PURE__ */ new Set();
        this.listeners.set(event, handlers);
      }
      handlers.add(handler);
      return this;
    }
    /**
    * Register a one-time event handler.
    */
    once(event, handler) {
      const wrapper = ((...args) => {
        this.off(event, wrapper);
        handler(...args);
      });
      return this.on(event, wrapper);
    }
    /**
    * Remove an event handler.
    */
    off(event, handler) {
      const handlers = this.listeners.get(event);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) this.listeners.delete(event);
      }
      return this;
    }
    /**
    * Emit an event to all registered handlers.
    * Handler errors do not prevent other handlers from running.
    * Errors are reported to an `error` event if present, otherwise rethrown async.
    */
    emit(event, ...args) {
      const handlers = this.listeners.get(event);
      if (handlers) for (const handler of [...handlers]) try {
        handler(...args);
      } catch (error) {
        if (event === this.errorEvent) this.scheduleThrow(this.normalizeError(error));
        else this.reportListenerError(error);
      }
    }
    /**
    * Remove all event handlers.
    */
    removeAllListeners(event) {
      if (event !== void 0) this.listeners.delete(event);
      else this.listeners.clear();
    }
    reportListenerError(error) {
      const normalizedError = this.normalizeError(error);
      const handlers = this.listeners.get(this.errorEvent);
      if (!handlers || handlers.size === 0) {
        this.scheduleThrow(normalizedError);
        return;
      }
      for (const handler of [...handlers]) try {
        handler(normalizedError);
      } catch (handlerError) {
        this.scheduleThrow(this.normalizeError(handlerError));
      }
    }
    normalizeError(error) {
      if (error instanceof Error) return error;
      return new Error(String(error));
    }
    scheduleThrow(error) {
      setTimeout(() => {
        throw error;
      }, 0);
    }
  };
  var RealtimeError = class extends SonioxError {
    /**
    * Original response payload for debugging.
    * Contains the raw WebSocket message that caused the error.
    */
    raw;
    constructor(message, code = "realtime_error", statusCode, raw) {
      super(message, code, statusCode);
      this.name = "RealtimeError";
      this.raw = raw;
    }
    /**
    * Creates a human-readable string representation
    */
    toString() {
      const parts = [`${this.name} [${this.code}]: ${this.message}`];
      if (this.statusCode !== void 0) parts.push(`  Status: ${this.statusCode}`);
      return parts.join("\n");
    }
    /**
    * Converts to a plain object for logging/serialization
    */
    toJSON() {
      return {
        name: this.name,
        code: this.code,
        message: this.message,
        ...this.statusCode !== void 0 && { statusCode: this.statusCode },
        ...this.raw !== void 0 && { raw: this.raw }
      };
    }
  };
  var AuthError = class extends RealtimeError {
    constructor(message, statusCode, raw) {
      super(message, "auth_error", statusCode, raw);
      this.name = "AuthError";
    }
  };
  var BadRequestError = class extends RealtimeError {
    constructor(message, statusCode, raw) {
      super(message, "bad_request", statusCode, raw);
      this.name = "BadRequestError";
    }
  };
  var QuotaError = class extends RealtimeError {
    constructor(message, statusCode, raw) {
      super(message, "quota_exceeded", statusCode, raw);
      this.name = "QuotaError";
    }
  };
  var ConnectionError = class extends RealtimeError {
    constructor(message, raw) {
      super(message, "connection_error", void 0, raw);
      this.name = "ConnectionError";
    }
  };
  var NetworkError = class extends RealtimeError {
    constructor(message, statusCode, raw) {
      super(message, "network_error", statusCode, raw);
      this.name = "NetworkError";
    }
  };
  var AbortError = class extends RealtimeError {
    constructor(message = "Operation aborted") {
      super(message, "aborted");
      this.name = "AbortError";
    }
  };
  var StateError = class extends RealtimeError {
    constructor(message) {
      super(message, "state_error");
      this.name = "StateError";
    }
  };
  function isRetriableError(error) {
    return error instanceof ConnectionError || error instanceof NetworkError;
  }
  function mapErrorResponse(response) {
    const { error_code, error_message } = response;
    const message = error_message ?? "Unknown error";
    switch (error_code) {
      case 401:
        return new AuthError(message, error_code, response);
      case 400:
        return new BadRequestError(message, error_code, response);
      case 402:
      case 429:
        return new QuotaError(message, error_code, response);
      case 408:
      case 500:
      case 503:
        return new NetworkError(message, error_code, response);
      default:
        return new RealtimeError(message, "realtime_error", error_code, response);
    }
  }
  var DEFAULT_KEEPALIVE_INTERVAL_MS$1 = 5e3;
  var MIN_KEEPALIVE_INTERVAL_MS$1 = 1e3;
  var DEFAULT_CONNECT_TIMEOUT_MS$1 = 2e4;
  function toUint8Array(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  function buildConfigMessage(config, apiKey) {
    return {
      api_key: apiKey,
      model: config.model,
      audio_format: config.audio_format ?? "auto",
      sample_rate: config.sample_rate,
      num_channels: config.num_channels,
      language_hints: config.language_hints,
      language_hints_strict: config.language_hints_strict,
      enable_speaker_diarization: config.enable_speaker_diarization,
      enable_language_identification: config.enable_language_identification,
      enable_endpoint_detection: config.enable_endpoint_detection,
      client_reference_id: config.client_reference_id,
      max_endpoint_delay_ms: config.max_endpoint_delay_ms,
      endpoint_sensitivity: config.endpoint_sensitivity,
      endpoint_latency_adjustment_level: config.endpoint_latency_adjustment_level,
      context: config.context,
      translation: config.translation
    };
  }
  function parseResultMessage(data) {
    const raw = JSON.parse(data);
    if ("error_code" in raw || "error_message" in raw) throw mapErrorResponse(raw);
    return {
      tokens: (raw.tokens ?? []).map((t) => ({
        text: typeof t.text === "string" ? t.text : "",
        start_ms: typeof t.start_ms === "number" ? t.start_ms : void 0,
        end_ms: typeof t.end_ms === "number" ? t.end_ms : void 0,
        confidence: typeof t.confidence === "number" ? t.confidence : 0,
        is_final: Boolean(t.is_final),
        speaker: typeof t.speaker === "string" ? t.speaker : void 0,
        language: typeof t.language === "string" ? t.language : void 0,
        translation_status: t.translation_status === "none" || t.translation_status === "original" || t.translation_status === "translation" ? t.translation_status : void 0,
        source_language: typeof t.source_language === "string" ? t.source_language : void 0
      })),
      final_audio_proc_ms: typeof raw.final_audio_proc_ms === "number" ? raw.final_audio_proc_ms : 0,
      total_audio_proc_ms: typeof raw.total_audio_proc_ms === "number" ? raw.total_audio_proc_ms : 0,
      finished: raw.finished === true,
      raw
    };
  }
  function isSpecialToken(text) {
    return text === "<end>" || text === "<fin>";
  }
  function filterSpecialTokens(tokens) {
    return tokens.filter((t) => !isSpecialToken(t.text));
  }
  var RealtimeSttSession = class {
    emitter = new TypedEmitter();
    eventQueue = new AsyncEventQueue();
    iteratorAttached = false;
    apiKey;
    wsBaseUrl;
    config;
    keepaliveIntervalMs;
    connectTimeoutMs;
    signal;
    ws = null;
    _state = "idle";
    _paused = false;
    _pauseWarned = false;
    keepaliveInterval = null;
    finishResolver = null;
    finishRejecter = null;
    abortHandler = null;
    constructor(apiKey, wsBaseUrl, config, options) {
      this.apiKey = apiKey;
      this.wsBaseUrl = wsBaseUrl;
      this.config = config;
      const keepaliveMs = options?.keepalive_interval_ms ?? DEFAULT_KEEPALIVE_INTERVAL_MS$1;
      this.keepaliveIntervalMs = Number.isFinite(keepaliveMs) && keepaliveMs > 0 ? Math.max(keepaliveMs, MIN_KEEPALIVE_INTERVAL_MS$1) : DEFAULT_KEEPALIVE_INTERVAL_MS$1;
      const connectMs = options?.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS$1;
      this.connectTimeoutMs = Number.isFinite(connectMs) && connectMs > 0 ? connectMs : DEFAULT_CONNECT_TIMEOUT_MS$1;
      this.signal = options?.signal;
      if (this.signal) {
        this.abortHandler = () => this.handleAbort();
        this.signal.addEventListener("abort", this.abortHandler);
      }
    }
    /**
    * Current session state.
    */
    get state() {
      return this._state;
    }
    /**
    * Whether the session is currently paused.
    */
    get paused() {
      return this._paused;
    }
    /**
    * Connect to the Soniox WebSocket API.
    *
    * @throws {@link AbortError} If aborted
    * @throws {@link ConnectionError} If connection fails
    * @throws {@link StateError} If already connected
    */
    async connect() {
      if (this._state !== "idle") throw new StateError(`Cannot connect: session is in "${this._state}" state`);
      this.checkAborted();
      this.setState("connecting", "user_action");
      let connectTimer;
      try {
        await Promise.race([this.createWebSocket().then((v) => {
          clearTimeout(connectTimer);
          return v;
        }), new Promise((_resolve, reject) => {
          connectTimer = setTimeout(() => {
            if (this.ws) this.ws.close();
            reject(new ConnectionError("Connection timed out"));
          }, this.connectTimeoutMs);
        })]);
        this.setState("connected", "connected");
        this.emitter.emit("connected");
        this.updateKeepalive();
      } catch (error) {
        clearTimeout(connectTimer);
        if (!this.isTerminalState(this._state)) {
          const err = error instanceof Error ? error : new ConnectionError("Connection failed", error);
          this.cleanup("error", err, "error");
        }
        throw error;
      }
    }
    /**
    * Send audio data to the server
    *
    * @param data - Audio data as Uint8Array or ArrayBuffer
    * @throws {@link AbortError} If aborted
    * @throws {@link StateError} If not connected
    */
    sendAudio(data) {
      this.checkAborted();
      if (this._state !== "connected") throw new StateError(`Cannot send audio: session is in "${this._state}" state`);
      if (this._paused) return;
      const chunk = toUint8Array(data);
      this.sendMessage(chunk, true);
    }
    /**
    * Stream audio data from an async iterable source.
    *
    * @param stream - Async iterable yielding audio chunks
    * @param options - Optional pacing and auto-finish settings
    * @throws {@link AbortError} If aborted during streaming
    * @throws {@link StateError} If not connected
    */
    async sendStream(stream, options) {
      for await (const chunk of stream) {
        this.sendAudio(chunk);
        if (options?.pace_ms) await new Promise((resolve) => setTimeout(resolve, options.pace_ms));
      }
      if (options?.finish) await this.finish();
    }
    /**
    * Pause audio transmission and starts automatic keepalive messages
    */
    pause() {
      if (this._paused) return;
      this._paused = true;
      this.finalize();
      if (!this._pauseWarned && typeof process !== "undefined" && true) {
        this._pauseWarned = true;
        console.warn("[Soniox] You are billed for the full stream duration even when session is paused.");
      }
      this.updateKeepalive();
    }
    /**
    * Resume audio transmission
    */
    resume() {
      if (!this._paused) return;
      this._paused = false;
      this.updateKeepalive();
    }
    /**
    * Requests the server to finalize current transcription
    */
    finalize(options) {
      if (this._state !== "connected" && this._state !== "finishing") return;
      const message = { type: "finalize" };
      if (options?.trailing_silence_ms !== void 0) message.trailing_silence_ms = options.trailing_silence_ms;
      this.sendMessage(JSON.stringify(message), false);
    }
    /**
    * Send a keepalive message
    */
    keepAlive() {
      if (this._state !== "connected" && this._state !== "finishing") return;
      this.sendMessage(JSON.stringify({ type: "keepalive" }), false);
    }
    /**
    * Gracefully finish the session
    */
    async finish() {
      this.checkAborted();
      if (this._state !== "connected") throw new StateError(`Cannot finish: session is in "${this._state}" state`);
      if (this._paused) this.resume();
      this.setState("finishing", "user_action");
      this.updateKeepalive();
      const finishPromise = new Promise((resolve, reject) => {
        this.finishResolver = resolve;
        this.finishRejecter = reject;
      });
      this.sendMessage("", false);
      return finishPromise;
    }
    /**
    * Close (cancel) the session immediately without waiting
    */
    close() {
      if (this.isTerminalState(this._state)) return;
      this.emitter.emit("disconnected", "client_closed");
      this.settleFinish(new StateError("Session canceled"));
      this.cleanup("canceled", void 0, "user_action");
    }
    /**
    * Register an event handler
    */
    on(event, handler) {
      this.emitter.on(event, handler);
      return this;
    }
    /**
    * Register a one-time event handler
    */
    once(event, handler) {
      this.emitter.once(event, handler);
      return this;
    }
    /**
    * Remove an event handler
    */
    off(event, handler) {
      this.emitter.off(event, handler);
      return this;
    }
    /**
    * Async iterator for consuming events.
    *
    * The returned iterator's `return()` resets the internal iterator-attach
    * flag and drops any buffered events, so consumers that exit `for await`
    * early (via `break` etc.) stop accruing memory while the session keeps
    * running.
    */
    [Symbol.asyncIterator]() {
      this.iteratorAttached = true;
      const inner = this.eventQueue[Symbol.asyncIterator]();
      return {
        next: () => inner.next(),
        return: (value) => {
          this.iteratorAttached = false;
          this.eventQueue.clear();
          return inner.return?.(value) ?? Promise.resolve({
            value,
            done: true
          });
        }
      };
    }
    /**
    * @internal Debug-only: forcefully close the underlying WebSocket to
    * simulate an unexpected network disconnection.
    */
    __debugForceDisconnect() {
      this.ws?.close(4999, "debug: simulated disconnect");
    }
    /**
    * Push an event to the async iterator queue only when a consumer has
    * attached via `[Symbol.asyncIterator]()`. Listener-only consumers
    * (the documented `.on()` pattern) never drain the queue, so pushing
    * unconditionally would leak buffered events on long-running sessions.
    */
    enqueueIfIterating(event) {
      if (this.iteratorAttached) this.eventQueue.push(event);
    }
    async createWebSocket() {
      return new Promise((resolve, reject) => {
        try {
          const ws = new WebSocket(this.wsBaseUrl);
          this.ws = ws;
          ws.binaryType = "arraybuffer";
          const cleanup = () => {
            ws.removeEventListener("open", onOpen);
            ws.removeEventListener("error", onError);
          };
          const onOpen = () => {
            cleanup();
            const configMessage = buildConfigMessage(this.config, this.apiKey);
            ws.send(JSON.stringify(configMessage));
            ws.addEventListener("message", this.handleMessage.bind(this));
            ws.addEventListener("close", this.handleClose.bind(this));
            ws.addEventListener("error", this.handleError.bind(this));
            resolve();
          };
          const onError = (event) => {
            cleanup();
            reject(new ConnectionError("WebSocket connection failed", event));
          };
          ws.addEventListener("open", onOpen);
          ws.addEventListener("error", onError);
          if (this.signal) this.signal.addEventListener("abort", () => {
            cleanup();
            ws.close();
            reject(new AbortError());
          }, { once: true });
        } catch (error) {
          reject(new ConnectionError("Failed to create WebSocket", error));
        }
      });
    }
    handleMessage(event) {
      if (typeof event.data !== "string") return;
      const data = event.data;
      try {
        const result = parseResultMessage(data);
        const hasEndpoint = result.tokens.some((t) => t.text === "<end>");
        const hasFinalized = result.tokens.some((t) => t.text === "<fin>");
        const userTokens = filterSpecialTokens(result.tokens);
        for (const token of userTokens) this.emitter.emit("token", token);
        const filteredResult = {
          ...result,
          tokens: userTokens
        };
        this.emitter.emit("result", filteredResult);
        this.enqueueIfIterating({
          kind: "result",
          data: filteredResult
        });
        if (hasEndpoint) {
          this.emitter.emit("endpoint");
          this.enqueueIfIterating({ kind: "endpoint" });
        }
        if (hasFinalized) {
          this.emitter.emit("finalized");
          this.enqueueIfIterating({ kind: "finalized" });
        }
        if (result.finished) {
          this.emitter.emit("finished");
          this.enqueueIfIterating({ kind: "finished" });
          this.settleFinish();
          this.cleanup("finished", void 0, "finished");
        }
      } catch (error) {
        const err = error;
        this.emitter.emit("error", err);
        this.settleFinish(err);
        this.cleanup("error", err, "error");
      }
    }
    handleClose(event) {
      if (this.isTerminalState(this._state)) return;
      this.emitter.emit("disconnected", event.reason || void 0);
      if (this._state === "finishing") {
        const error$1 = new ConnectionError("WebSocket closed before finished response", event);
        this.emitter.emit("error", error$1);
        this.settleFinish(error$1);
        this.cleanup("error", error$1, "connection_lost");
        return;
      }
      const error = new ConnectionError("WebSocket closed unexpectedly", event);
      this.emitter.emit("error", error);
      this.cleanup("closed", error, "connection_lost");
    }
    handleError(event) {
      const error = new ConnectionError("WebSocket error", event);
      this.emitter.emit("error", error);
      this.settleFinish(error);
      this.cleanup("error", error, "error");
    }
    handleAbort() {
      const error = new AbortError();
      this.emitter.emit("error", error);
      this.settleFinish(error);
      this.cleanup("canceled", error, "user_action");
    }
    setState(newState, reason) {
      if (this._state === newState) return;
      const oldState = this._state;
      this._state = newState;
      const update = {
        old_state: oldState,
        new_state: newState
      };
      if (reason !== void 0) update.reason = reason;
      this.emitter.emit("state_change", update);
    }
    cleanup(finalState, error, reason) {
      this.setState(finalState, reason);
      this.stopKeepalive();
      if (this.signal && this.abortHandler) {
        this.signal.removeEventListener("abort", this.abortHandler);
        this.abortHandler = null;
      }
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      if (error) this.eventQueue.abort(error);
      else this.eventQueue.end();
      this.emitter.removeAllListeners();
    }
    isTerminalState(state) {
      return state === "closed" || state === "error" || state === "finished" || state === "canceled";
    }
    checkAborted() {
      if (this.signal?.aborted) throw new AbortError();
    }
    settleFinish(error) {
      if (!this.finishResolver && !this.finishRejecter) return;
      const resolve = this.finishResolver;
      const reject = this.finishRejecter;
      this.finishResolver = null;
      this.finishRejecter = null;
      if (error) reject?.(error);
      else resolve?.();
    }
    sendMessage(data, shouldThrow) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const error = new ConnectionError("WebSocket is not open");
        this.emitter.emit("error", error);
        this.settleFinish(error);
        this.cleanup("error", error, "error");
        if (shouldThrow) throw error;
        return;
      }
      try {
        this.ws.send(data);
      } catch (err) {
        const error = new ConnectionError("WebSocket send failed", err);
        this.emitter.emit("error", error);
        this.settleFinish(error);
        this.cleanup("error", error, "error");
        if (shouldThrow) throw error;
      }
    }
    startKeepalive() {
      if (this.keepaliveInterval) return;
      this.keepaliveInterval = setInterval(() => {
        this.keepAlive();
      }, this.keepaliveIntervalMs);
    }
    stopKeepalive() {
      if (this.keepaliveInterval) {
        clearInterval(this.keepaliveInterval);
        this.keepaliveInterval = null;
      }
    }
    updateKeepalive() {
      if ((this._state === "connected" || this._state === "finishing") && this._paused) this.startKeepalive();
      else this.stopKeepalive();
    }
  };
  var MAX_STREAMS_PER_CONNECTION = 5;
  var DEFAULT_KEEPALIVE_INTERVAL_MS = 5e3;
  var MIN_KEEPALIVE_INTERVAL_MS = 1e3;
  var DEFAULT_CONNECT_TIMEOUT_MS = 2e4;
  function generateStreamId() {
    return globalThis.crypto.randomUUID();
  }
  function decodeBase64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes;
  }
  function resolveStreamConfig(input, defaults) {
    const merged = {
      ...defaults,
      ...input
    };
    const model = merged.model;
    const language = merged.language;
    const voice = merged.voice;
    const audio_format = merged.audio_format;
    const missing = [];
    if (!model) missing.push("model");
    if (!language) missing.push("language");
    if (!voice) missing.push("voice");
    if (!audio_format) missing.push("audio_format");
    if (missing.length > 0) throw new Error(`Missing required TTS stream fields: ${missing.join(", ")}. Provide them directly or via tts_defaults in your connection config.`);
    return {
      model,
      language,
      voice,
      audio_format,
      ...merged.sample_rate !== void 0 && { sample_rate: merged.sample_rate },
      ...merged.bitrate !== void 0 && { bitrate: merged.bitrate },
      ...merged.speed !== void 0 && { speed: merged.speed },
      ...merged.return_timestamps !== void 0 && { return_timestamps: merged.return_timestamps },
      stream_id: merged.stream_id ?? generateStreamId()
    };
  }
  var RealtimeTtsStream = class extends TypedEmitter {
    streamId;
    _state = "active";
    audioQueue = new AsyncEventQueue();
    iteratorAttached = false;
    connection;
    ownsConnection;
    /** @internal */
    constructor(streamId, connection, ownsConnection) {
      super();
      this.streamId = streamId;
      this.connection = connection;
      this.ownsConnection = ownsConnection;
    }
    /** Current stream lifecycle state. */
    get state() {
      return this._state;
    }
    /**
    * Send one text chunk to the TTS stream.
    *
    * @param text - Text to synthesize
    * @param options.end - If true, signals this is the final text chunk
    */
    sendText(text, options) {
      if (this._state !== "active") throw new StateError(`Cannot send text in state '${this._state}'`);
      const payload = {
        text,
        text_end: options?.end ?? false,
        stream_id: this.streamId
      };
      this.connection._sendJson(payload);
      if (options?.end) this._state = "finishing";
    }
    /**
    * Pipe an async iterable of text chunks into the stream.
    * Automatically calls {@link finish} when the iterable completes.
    *
    * Designed for concurrent use: call `sendStream()` and consume audio
    * via `for await` or events simultaneously.
    *
    * @example LLM token piping
    * ```typescript
    * stream.sendStream(llmTokenStream);
    * for await (const audio of stream) { forward(audio); }
    * ```
    */
    async sendStream(source) {
      for await (const chunk of source) {
        if (this._state !== "active") break;
        this.sendText(chunk);
      }
      if (this._state === "active") this.finish();
    }
    /**
    * Signal that no more text will be sent for this stream.
    * The server will finish generating audio and send `terminated`.
    */
    finish() {
      if (this._state !== "active") throw new StateError(`Cannot finish in state '${this._state}'`);
      this.sendText("", { end: true });
    }
    /**
    * Cancel this stream. The server will stop generating and send `terminated`.
    */
    cancel() {
      if (this._state === "ended" || this._state === "error") return;
      const payload = {
        stream_id: this.streamId,
        cancel: true
      };
      try {
        this.connection._sendJson(payload);
      } catch {
      }
    }
    /**
    * Close this stream. For single-stream usage (created via `tts(input)`),
    * also closes the underlying WebSocket connection.
    */
    close() {
      this._endStream();
      if (this.ownsConnection) this.connection.close();
    }
    /**
    * Async iterator that yields decoded audio chunks.
    *
    * The returned iterator's `return()` resets the internal iterator-attach
    * flag and drops any buffered audio, so consumers that exit `for await`
    * early (via `break` etc.) stop accruing memory while the stream keeps
    * receiving server audio.
    */
    [Symbol.asyncIterator]() {
      this.iteratorAttached = true;
      const inner = this.audioQueue[Symbol.asyncIterator]();
      return {
        next: () => inner.next(),
        return: (value) => {
          this.iteratorAttached = false;
          this.audioQueue.clear();
          return inner.return?.(value) ?? Promise.resolve({
            value,
            done: true
          });
        }
      };
    }
    /**
    * Push an audio chunk to the async iterator queue only when a consumer
    * has attached via `[Symbol.asyncIterator]()`. Listener-only consumers
    * (the documented `.on('audio', ...)` pattern) never drain the queue,
    * so pushing unconditionally would leak buffered chunks.
    */
    enqueueIfIterating(chunk) {
      if (this.iteratorAttached) this.audioQueue.push(chunk);
    }
    /** @internal Dispatch a server event to this stream. */
    _handleEvent(event) {
      if (event.error_code !== void 0) {
        const errPayload = { error_code: event.error_code };
        if (event.error_message !== void 0) errPayload.error_message = event.error_message;
        const error = mapErrorResponse(errPayload);
        this._state = "error";
        this.emit("error", error);
        this.audioQueue.abort(error);
        this.connection._deactivateStream(this.streamId);
        return;
      }
      if (event.audio !== void 0) {
        const chunk = decodeBase64ToUint8Array(event.audio);
        this.emit("audio", chunk, event.timestamps);
        this.enqueueIfIterating(chunk);
      }
      if (event.audio_end) this.emit("audioEnd");
      if (event.terminated) this._endStream();
    }
    /** @internal Force-end this stream (connection closing). */
    _forceEnd() {
      if (this._state === "ended" || this._state === "error") return;
      this._state = "ended";
      this.audioQueue.end();
    }
    _endStream() {
      if (this._state === "ended") return;
      this._state = "ended";
      this.emit("terminated");
      this.audioQueue.end();
      this.connection._deactivateStream(this.streamId);
    }
  };
  var RealtimeTtsConnection = class extends TypedEmitter {
    apiKey;
    wsUrl;
    ttsDefaults;
    keepaliveIntervalMs;
    connectTimeoutMs;
    ws = null;
    connected = false;
    connecting = false;
    keepaliveTimer = null;
    activeStreams = /* @__PURE__ */ new Map();
    constructor(apiKey, wsUrl, ttsDefaults = {}, options) {
      super();
      this.apiKey = apiKey;
      this.wsUrl = wsUrl;
      this.ttsDefaults = ttsDefaults;
      const keepaliveMs = options?.keepalive_interval_ms ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
      this.keepaliveIntervalMs = Number.isFinite(keepaliveMs) && keepaliveMs > 0 ? Math.max(keepaliveMs, MIN_KEEPALIVE_INTERVAL_MS) : DEFAULT_KEEPALIVE_INTERVAL_MS;
      const connectMs = options?.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS;
      this.connectTimeoutMs = Number.isFinite(connectMs) && connectMs > 0 ? connectMs : DEFAULT_CONNECT_TIMEOUT_MS;
    }
    /** Whether the WebSocket is connected. */
    get isConnected() {
      return this.connected;
    }
    /**
    * Open the WebSocket connection and start keepalive.
    * Called automatically by {@link stream} if not yet connected.
    */
    async connect() {
      if (this.connected) return;
      if (this.connecting) throw new StateError("Connection is already being established");
      this.connecting = true;
      try {
        await this.createWebSocket();
        this.connected = true;
        this.startKeepalive();
      } finally {
        this.connecting = false;
      }
    }
    /**
    * Open a new TTS stream on this connection.
    * Auto-connects if the WebSocket is not yet open.
    *
    * @param input - Stream configuration (merged with tts_defaults)
    * @returns A ready-to-use stream handle
    */
    async stream(input = {}) {
      return this._openStream(input, false);
    }
    /** @internal Open a stream, optionally marking it as connection-owning. */
    async _openStream(input, ownsConnection) {
      if (!this.connected) await this.connect();
      if (this.activeStreams.size >= MAX_STREAMS_PER_CONNECTION) throw new StateError(`Maximum concurrent streams (${MAX_STREAMS_PER_CONNECTION}) reached`);
      const config = resolveStreamConfig(input, this.ttsDefaults);
      if (this.activeStreams.has(config.stream_id)) throw new StateError(`Stream '${config.stream_id}' is already active on this connection`);
      const stream = new RealtimeTtsStream(config.stream_id, this, ownsConnection);
      this.activeStreams.set(config.stream_id, stream);
      const configPayload = {
        api_key: this.apiKey,
        ...config
      };
      this._sendJson(configPayload);
      return stream;
    }
    /**
    * Close the WebSocket connection and terminate all active streams.
    */
    close() {
      this.stopKeepalive();
      for (const stream of this.activeStreams.values()) stream._forceEnd();
      this.activeStreams.clear();
      if (this.ws) {
        try {
          this.ws.close();
        } catch {
        }
        this.ws = null;
      }
      this.connected = false;
      this.emit("close");
    }
    /** @internal Send a JSON payload on the WebSocket. */
    _sendJson(payload) {
      if (!this.ws || !this.connected) throw new StateError("TTS connection is not open");
      this.ws.send(JSON.stringify(payload));
    }
    /** @internal Remove a stream from the active set. */
    _deactivateStream(streamId) {
      this.activeStreams.delete(streamId);
    }
    async createWebSocket() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
          }
          reject(new ConnectionError("TTS WebSocket connection timed out"));
        }, this.connectTimeoutMs);
        let ws;
        try {
          ws = new WebSocket(this.wsUrl);
          ws.binaryType = "arraybuffer";
        } catch (err) {
          clearTimeout(timer);
          reject(new ConnectionError(`Failed to create TTS WebSocket: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
        const onOpen = () => {
          clearTimeout(timer);
          ws.removeEventListener("error", onError);
          this.ws = ws;
          ws.addEventListener("message", (event) => {
            this.handleMessage(event);
          });
          ws.addEventListener("close", () => {
            if (this.connected) {
              this.connected = false;
              this.stopKeepalive();
              for (const stream of this.activeStreams.values()) stream._forceEnd();
              this.activeStreams.clear();
              this.emit("close");
            }
          });
          resolve();
        };
        const onError = () => {
          clearTimeout(timer);
          ws.removeEventListener("open", onOpen);
          reject(new ConnectionError("TTS WebSocket connection failed"));
        };
        ws.addEventListener("open", onOpen);
        ws.addEventListener("error", onError);
      });
    }
    handleMessage(event) {
      if (typeof event.data !== "string") return;
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const streamId = parsed.stream_id;
      if (streamId !== void 0) {
        const stream = this.activeStreams.get(streamId);
        if (stream) stream._handleEvent(parsed);
        return;
      }
      if (parsed.error_code !== void 0) {
        const errPayload = { error_code: parsed.error_code };
        if (parsed.error_message !== void 0) errPayload.error_message = parsed.error_message;
        const error = mapErrorResponse(errPayload);
        this.emit("error", error);
      }
    }
    startKeepalive() {
      if (this.keepaliveTimer) return;
      this.keepaliveTimer = setInterval(() => {
        if (this.connected && this.ws) try {
          this.ws.send(JSON.stringify({ keep_alive: true }));
        } catch {
        }
      }, this.keepaliveIntervalMs);
    }
    stopKeepalive() {
      if (this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }
    }
  };
  var DEFAULT_MODEL = "tts-rt-v1";
  var DEFAULT_LANGUAGE = "en";
  var DEFAULT_AUDIO_FORMAT = "wav";
  function buildPayload(options) {
    const payload = {
      model: options.model ?? DEFAULT_MODEL,
      language: options.language ?? DEFAULT_LANGUAGE,
      voice: options.voice,
      audio_format: options.audio_format ?? DEFAULT_AUDIO_FORMAT,
      text: options.text
    };
    if (options.sample_rate !== void 0) payload.sample_rate = options.sample_rate;
    if (options.bitrate !== void 0) payload.bitrate = options.bitrate;
    if (options.speed !== void 0) payload.speed = options.speed;
    return payload;
  }
  function headersToObject(headers) {
    const result = {};
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }
  function isAbortLikeError(error) {
    if (error instanceof Error) return error.name === "AbortError" || error.name === "TimeoutError";
    return false;
  }
  var TtsRestClient = class {
    apiKey;
    ttsApiUrl;
    constructor(apiKey, ttsApiUrl) {
      this.apiKey = apiKey;
      this.ttsApiUrl = ttsApiUrl;
    }
    /**
    * Generate speech audio from text. Returns the full audio as a `Uint8Array`.
    *
    * @throws {@link SonioxHttpError} on non-2xx responses, network failures,
    * or aborted requests.
    */
    async generate(options) {
      const url = `${this.ttsApiUrl}/tts`;
      const buffer = await (await this.sendRequest(url, options)).arrayBuffer();
      return new Uint8Array(buffer);
    }
    /**
    * Generate speech audio from text as a streaming async iterable.
    *
    * Yields `Uint8Array` chunks as they arrive from the server response body.
    * Lower time-to-first-audio than {@link generate}.
    *
    * **Known limitation:** Mid-stream server errors (reported via HTTP trailers)
    * cannot be detected through the `fetch` API. The iterator may end early
    * without an explicit error. Use WebSocket TTS for reliable error detection.
    *
    * @throws {@link SonioxHttpError} on non-2xx responses, network failures,
    * or aborted requests (before the stream starts).
    */
    async *generateStream(options) {
      const url = `${this.ttsApiUrl}/tts`;
      const response = await this.sendRequest(url, options);
      if (!response.body) throw createHttpError(url, "POST", response.status, headersToObject(response.headers), "Response has no body stream");
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    /**
    * Internal request helper. Performs the fetch, maps network/abort failures
    * to {@link SonioxHttpError}, and throws on non-2xx responses.
    */
    async sendRequest(url, options) {
      const payload = buildPayload(options);
      let response;
      try {
        response = await globalThis.fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload),
          ...options.signal && { signal: options.signal }
        });
      } catch (cause) {
        if (isAbortLikeError(cause)) throw createAbortError(url, "POST", cause);
        throw createNetworkError(url, "POST", cause);
      }
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw createHttpError(url, "POST", response.status, headersToObject(response.headers), bodyText);
      }
      return response;
    }
  };
  var AudioPermissionError = class extends SonioxError {
    constructor(message = "Microphone access denied", cause) {
      super(message, "permission_denied", void 0, cause);
      this.name = "AudioPermissionError";
    }
  };
  var AudioDeviceError = class extends SonioxError {
    constructor(message = "No audio input device found", cause) {
      super(message, "device_not_found", void 0, cause);
      this.name = "AudioDeviceError";
    }
  };
  var AudioUnavailableError = class extends SonioxError {
    constructor(message = "Audio capture is not supported in this environment", cause) {
      super(message, "audio_unavailable", void 0, cause);
      this.name = "AudioUnavailableError";
    }
  };
  var DEFAULT_TIMESLICE_MS = 60;
  var DEFAULT_AUDIO_CONSTRAINTS = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 16e3
  };
  var MicrophoneSource = class {
    constraints;
    recorderOptions;
    timesliceMs;
    mediaRecorder = null;
    stream = null;
    boundOnData = null;
    boundOnError = null;
    boundOnMute = null;
    boundOnUnmute = null;
    startGeneration = 0;
    constructor(options = {}) {
      this.constraints = options.constraints ?? DEFAULT_AUDIO_CONSTRAINTS;
      this.recorderOptions = options.recorderOptions ?? {};
      this.timesliceMs = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
    }
    /**
    * Request microphone access and start recording
    *
    * @throws AudioUnavailableError if getUserMedia or MediaRecorder is not supported
    * @throws AudioPermissionError if microphone access is denied
    * @throws AudioDeviceError if no microphone is found
    */
    async start(handlers) {
      this.stop();
      const generation = ++this.startGeneration;
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new AudioUnavailableError("navigator.mediaDevices.getUserMedia is not available");
      if (typeof MediaRecorder === "undefined") throw new AudioUnavailableError("MediaRecorder is not available");
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: this.constraints });
      } catch (err) {
        if (err instanceof DOMException) {
          if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") throw new AudioPermissionError("Microphone access denied by user", err);
          if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") throw new AudioDeviceError("No microphone found", err);
          if (err.name === "NotReadableError" || err.name === "TrackStartError") throw new AudioDeviceError("Microphone is already in use or not readable", err);
        }
        throw new AudioUnavailableError(err instanceof Error ? err.message : "Failed to access microphone", err);
      }
      if (generation !== this.startGeneration) {
        stream.getTracks().forEach((track$1) => track$1.stop());
        return;
      }
      this.stream = stream;
      const track = stream.getAudioTracks()[0];
      if (track) {
        const { onMuted, onUnmuted } = handlers;
        this.boundOnMute = onMuted ? () => {
          onMuted();
        } : null;
        this.boundOnUnmute = onUnmuted ? () => {
          onUnmuted();
        } : null;
        if (this.boundOnMute) track.addEventListener("mute", this.boundOnMute);
        if (this.boundOnUnmute) track.addEventListener("unmute", this.boundOnUnmute);
      }
      try {
        const recorder = new MediaRecorder(stream, this.recorderOptions);
        this.mediaRecorder = recorder;
        this.boundOnData = (event) => {
          if (event.data.size > 0) event.data.arrayBuffer().then((buffer) => handlers.onData(buffer), (err) => handlers.onError(err instanceof Error ? err : new Error(String(err))));
        };
        this.boundOnError = (event) => {
          const errorEvent = event;
          const error = new Error(errorEvent.message || "MediaRecorder error");
          handlers.onError(error);
        };
        recorder.addEventListener("dataavailable", this.boundOnData);
        recorder.addEventListener("error", this.boundOnError);
        recorder.start(this.timesliceMs);
      } catch (err) {
        stream.getTracks().forEach((track$1) => track$1.stop());
        this.stream = null;
        this.mediaRecorder = null;
        this.boundOnMute = null;
        this.boundOnUnmute = null;
        throw new AudioUnavailableError(err instanceof Error ? err.message : "Failed to start MediaRecorder", err);
      }
    }
    /**
    * Stop recording and release all resources
    */
    stop() {
      if (this.mediaRecorder) {
        if (this.mediaRecorder.state !== "inactive") {
          const recorder = this.mediaRecorder;
          const onData = this.boundOnData;
          const onError = this.boundOnError;
          recorder.addEventListener("stop", () => {
            if (onData) recorder.removeEventListener("dataavailable", onData);
            if (onError) recorder.removeEventListener("error", onError);
          }, { once: true });
          recorder.stop();
        } else {
          if (this.boundOnData) this.mediaRecorder.removeEventListener("dataavailable", this.boundOnData);
          if (this.boundOnError) this.mediaRecorder.removeEventListener("error", this.boundOnError);
        }
        this.boundOnData = null;
        this.boundOnError = null;
        this.mediaRecorder = null;
      }
      if (this.stream) {
        if (this.boundOnMute || this.boundOnUnmute) {
          const track = this.stream.getAudioTracks()[0];
          if (track) {
            if (this.boundOnMute) track.removeEventListener("mute", this.boundOnMute);
            if (this.boundOnUnmute) track.removeEventListener("unmute", this.boundOnUnmute);
          }
          this.boundOnMute = null;
          this.boundOnUnmute = null;
        }
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
    }
    /**
    * Pause audio capture
    */
    pause() {
      if (this.mediaRecorder && this.mediaRecorder.state === "recording") this.mediaRecorder.pause();
    }
    /**
    * Resume audio capture
    */
    resume() {
      if (this.mediaRecorder && this.mediaRecorder.state === "paused") this.mediaRecorder.resume();
    }
    /**
    * Reinitialize the MediaRecorder on the existing stream so the next
    * chunks contain a fresh container header (required after reconnecting
    * to a new server session).
    */
    restart() {
      if (!this.stream || !this.mediaRecorder) return;
      const oldRecorder = this.mediaRecorder;
      if (this.boundOnData) oldRecorder.removeEventListener("dataavailable", this.boundOnData);
      if (this.boundOnError) oldRecorder.removeEventListener("error", this.boundOnError);
      if (oldRecorder.state !== "inactive") oldRecorder.stop();
      const recorder = new MediaRecorder(this.stream, this.recorderOptions);
      this.mediaRecorder = recorder;
      if (this.boundOnData) recorder.addEventListener("dataavailable", this.boundOnData);
      if (this.boundOnError) recorder.addEventListener("error", this.boundOnError);
      recorder.start(this.timesliceMs);
    }
  };
  async function resolveApiKey(config) {
    if (typeof config === "function") {
      const key = await config();
      if (typeof key !== "string" || key.length === 0) throw new Error("api_key function must return a non-empty string");
      return key;
    }
    if (typeof config !== "string" || config.length === 0) throw new Error("api_key must be a non-empty string");
    return config;
  }
  var TERMINAL_STATES = [
    "stopped",
    "canceled",
    "error"
  ];
  var DEFAULT_RECONNECT_BASE_DELAY_MS = 1e3;
  var DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
  var DEFAULT_BUFFER_QUEUE_SIZE = 1e3;
  var Recording = class {
    emitter = new TypedEmitter();
    configResolver;
    sttConfigInput;
    sessionOptions;
    source;
    maxBufferSize;
    signal;
    autoReconnect;
    maxReconnectAttempts;
    reconnectBaseDelay;
    resetTranscriptOnReconnect;
    session = null;
    audioBuffer = [];
    _state = "idle";
    isBuffering = true;
    _isSourceMuted = false;
    _reconnectAttempt = 0;
    stopResolver = null;
    stopRejecter = null;
    /** @internal */
    constructor(configResolver, sttConfigInput, source, options) {
      this.configResolver = configResolver;
      this.sttConfigInput = sttConfigInput;
      this.source = source;
      this.maxBufferSize = options?.buffer_queue_size ?? DEFAULT_BUFFER_QUEUE_SIZE;
      this.sessionOptions = options?.session_options;
      this.signal = options?.signal;
      this.autoReconnect = options?.auto_reconnect ?? false;
      this.maxReconnectAttempts = options?.max_reconnect_attempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
      this.reconnectBaseDelay = options?.reconnect_base_delay_ms ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
      this.resetTranscriptOnReconnect = options?.reset_transcript_on_reconnect ?? false;
      queueMicrotask(() => {
        this.run();
      });
    }
    /**
    * Current recording state
    */
    get state() {
      return this._state;
    }
    /**
    * Register an event handler
    */
    on(event, handler) {
      this.emitter.on(event, handler);
      return this;
    }
    /**
    * Register a one-time event handler
    */
    once(event, handler) {
      this.emitter.once(event, handler);
      return this;
    }
    /**
    * Remove an event handler
    */
    off(event, handler) {
      this.emitter.off(event, handler);
      return this;
    }
    /**
    * Gracefully stop recording
    *
    * Stops the audio source and waits for the server to process all
    * buffered audio and return final results.
    *
    * @returns Promise that resolves when the server acknowledges completion
    */
    async stop() {
      if (this._state === "stopped" || this._state === "canceled" || this._state === "error") return;
      if (this._state === "stopping") return new Promise((resolve, reject) => {
        this.once("finished", resolve);
        this.once("error", reject);
      });
      this.setState("stopping", "user_action");
      this.source.stop();
      if (this.session && this.session.state === "connected") {
        const finishPromise = new Promise((resolve, reject) => {
          this.stopResolver = resolve;
          this.stopRejecter = reject;
        });
        try {
          await this.session.finish();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.settleStop(error);
          this.cleanup("error", "error");
          return;
        }
        return finishPromise;
      }
      if (!this.session || this.session.state === "idle" || this.session.state === "connecting") return new Promise((resolve, reject) => {
        this.stopResolver = resolve;
        this.stopRejecter = reject;
      });
      this.session?.close();
      this.settleStop();
      this.cleanup("stopped", "user_action");
    }
    /**
    * Immediately cancel recording without waiting for final results
    */
    cancel() {
      if (this._state === "stopped" || this._state === "canceled" || this._state === "error") return;
      this.source.stop();
      this.session?.close();
      this.cleanup("canceled", "user_action");
    }
    /**
    * Request the server to finalize current non-final tokens.
    */
    finalize(options) {
      this.session?.finalize(options);
    }
    /**
    * Pause recording.
    *
    * Pauses the audio source (stops microphone capture) and pauses the
    * session (activates automatic keepalive to prevent server disconnect).
    */
    pause() {
      if (this._state !== "recording") return;
      this.source.pause?.();
      this.session?.pause();
      this.setState("paused", "user_action");
    }
    /**
    * Resume recording after pause.
    *
    * Resumes the audio source and session. Audio capture and transmission
    * continue from where they left off. If audio was buffered during a
    * reconnect while paused, the buffer is drained now.
    */
    resume() {
      if (this._state !== "paused") return;
      this.source.resume?.();
      if (!this._isSourceMuted) this.session?.resume();
      this.setState("recording", "user_action");
      if (this.isBuffering && this.session) {
        this.isBuffering = false;
        for (const chunk of this.audioBuffer) {
          if (this.isTerminalState()) break;
          this.session.sendAudio(chunk);
        }
        this.audioBuffer = [];
      }
    }
    /**
    * @internal Debug-only: simulate an unexpected network disconnection.
    * Tears down the current session and feeds a retriable error into the
    * error handler so the reconnection logic kicks in exactly as it would
    * during a real connection drop.
    */
    __debugForceDisconnect() {
      if (this._state !== "recording" && this._state !== "paused") return;
      this.session?.close();
      this.session = null;
      this.handleError(new ConnectionError("Debug: simulated disconnect"));
    }
    /**
    * Force a reconnection — tears down the current session and audio
    * encoder, then establishes a new session via the standard reconnect
    * flow (backoff, config re-resolution, buffer drain).
    *
    * Use this to recover from stale connections after platform lifecycle
    * events such as laptop sleep/wake (web `visibilitychange`) or app
    * backgrounding (React Native `AppState`).
    *
    * Requires `auto_reconnect` to be enabled. No-op when the recording
    * is not in `recording` or `paused` state.
    */
    reconnect() {
      if (this._state !== "recording" && this._state !== "paused") return;
      if (!this.autoReconnect) return;
      this.session?.close();
      this.session = null;
      this.handleError(new ConnectionError("Reconnect requested"));
    }
    async run() {
      if (this.signal?.aborted) {
        this.handleAbort();
        return;
      }
      const onAbort = () => this.handleAbort();
      this.signal?.addEventListener("abort", onAbort, { once: true });
      this.setState("starting", "user_action");
      try {
        await this.source.start({
          onData: (chunk) => this.handleAudioData(chunk),
          onError: (err) => this.handleError(err),
          onMuted: () => this.handleSourceMuted(),
          onUnmuted: () => this.handleSourceUnmuted()
        });
      } catch (error) {
        this.signal?.removeEventListener("abort", onAbort);
        this.handleError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (this.isTerminalState()) {
        this.signal?.removeEventListener("abort", onAbort);
        return;
      }
      let resolvedConfig;
      try {
        resolvedConfig = await this.configResolver();
      } catch (error) {
        this.signal?.removeEventListener("abort", onAbort);
        this.source.stop();
        this.handleError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.signal?.removeEventListener("abort", onAbort);
      if (this.isTerminalState()) {
        this.source.stop();
        return;
      }
      const sttConfig = typeof this.sttConfigInput === "function" ? this.sttConfigInput(resolvedConfig) : this.sttConfigInput;
      this.setState("connecting", "user_action");
      const sessionOptions = { ...this.sessionOptions };
      if (this.signal !== void 0) sessionOptions.signal = this.signal;
      const session = new RealtimeSttSession(resolvedConfig.api_key, resolvedConfig.stt_ws_url, sttConfig, sessionOptions);
      this.session = session;
      this.wireSessionEvents(session);
      try {
        await session.connect();
      } catch (error) {
        this.source.stop();
        this.handleError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (this.isTerminalState()) {
        session.close();
        return;
      }
      const stoppingEarly = this._state === "stopping";
      if (!stoppingEarly) {
        this.setState("recording", "connected");
        this.emitter.emit("connected");
      }
      this.isBuffering = false;
      for (const chunk of this.audioBuffer) {
        if (this._state !== "recording" && this._state !== "stopping") break;
        session.sendAudio(chunk);
      }
      this.audioBuffer = [];
      if (stoppingEarly) try {
        await session.finish();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.settleStop(error);
        this.cleanup("error", "error");
      }
    }
    handleAudioData(chunk) {
      if (this.isBuffering) {
        if (this.audioBuffer.length >= this.maxBufferSize) this.audioBuffer.shift();
        this.audioBuffer.push(chunk);
        return;
      }
      if (this.session && (this._state === "recording" || this._state === "stopping")) try {
        this.session.sendAudio(chunk);
      } catch {
      }
    }
    handleSourceMuted() {
      if (!this.isMuteTrackingState()) return;
      this._isSourceMuted = true;
      if (this._state === "recording") this.session?.pause();
      this.emitter.emit("source_muted");
    }
    handleSourceUnmuted() {
      if (!this.isMuteTrackingState()) return;
      this._isSourceMuted = false;
      if (this._state === "recording") this.session?.resume();
      this.emitter.emit("source_unmuted");
    }
    isMuteTrackingState() {
      const s = this._state;
      return s === "recording" || s === "paused" || s === "reconnecting" || s === "connecting";
    }
    wireSessionEvents(session) {
      session.on("result", (result) => this.emitter.emit("result", result));
      session.on("token", (token) => this.emitter.emit("token", token));
      session.on("endpoint", () => this.emitter.emit("endpoint"));
      session.on("finalized", () => this.emitter.emit("finalized"));
      session.on("finished", () => {
        this.source.stop();
        this.emitter.emit("finished");
        this.settleStop();
        this.cleanup("stopped", "finished");
      });
      session.on("error", (error) => {
        this.handleError(error);
      });
    }
    handleAbort() {
      if (this.isTerminalState()) return;
      this.source.stop();
      this.session?.close();
      const error = /* @__PURE__ */ new Error("Recording aborted");
      this.emitter.emit("error", error);
      this.settleStop(error);
      this.cleanup("canceled", "user_action");
    }
    handleError(error) {
      if (this._state === "error" || this._state === "stopped" || this._state === "canceled") return;
      if (this.shouldReconnect(error)) {
        this.attemptReconnect(error);
        return;
      }
      this.source.stop();
      this.session?.close();
      this.emitter.emit("error", error);
      this.settleStop(error);
      this.cleanup("error", "error");
    }
    shouldReconnect(error) {
      if (!this.autoReconnect) return false;
      if (this._state === "stopping") return false;
      if (this._state === "reconnecting") return false;
      if (this._reconnectAttempt >= this.maxReconnectAttempts) return false;
      return isRetriableError(error);
    }
    async attemptReconnect(triggerError) {
      const wasPaused = this._state === "paused";
      this.session?.close();
      this.session = null;
      this.isBuffering = true;
      this.audioBuffer = [];
      if (!wasPaused) this.source.restart?.();
      this._reconnectAttempt++;
      this.setState("reconnecting", "connection_lost");
      const delay = this.reconnectBaseDelay * Math.pow(2, this._reconnectAttempt - 1);
      let prevented = false;
      this.emitter.emit("reconnecting", {
        attempt: this._reconnectAttempt,
        max_attempts: this.maxReconnectAttempts,
        delay_ms: delay,
        preventDefault: () => {
          prevented = true;
        }
      });
      if (prevented) {
        this.source.stop();
        this.emitter.emit("error", triggerError);
        this.settleStop(triggerError);
        this.cleanup("error", "error");
        return;
      }
      await new Promise((r) => setTimeout(r, delay));
      if (this.shouldAbortReconnect()) return;
      let resolvedConfig;
      try {
        resolvedConfig = await this.configResolver();
      } catch (err) {
        this.handleError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (this.shouldAbortReconnect()) return;
      const sttConfig = typeof this.sttConfigInput === "function" ? this.sttConfigInput(resolvedConfig) : this.sttConfigInput;
      this.setState("connecting", "reconnecting");
      const sessionOptions = { ...this.sessionOptions };
      if (this.signal !== void 0) sessionOptions.signal = this.signal;
      const session = new RealtimeSttSession(resolvedConfig.api_key, resolvedConfig.stt_ws_url, sttConfig, sessionOptions);
      this.session = session;
      this.wireSessionEvents(session);
      try {
        await session.connect();
      } catch (err) {
        this.handleError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (this.shouldAbortReconnect()) return;
      this.emitter.emit("session_restart", { reset_transcript: this.resetTranscriptOnReconnect });
      const currentlyMuted = this._isSourceMuted;
      if (wasPaused || currentlyMuted) session.pause();
      if (wasPaused) {
        this.source.restart?.();
        this.source.pause?.();
        this.setState("paused", "reconnected");
      } else {
        this.setState("recording", "reconnected");
        this.isBuffering = false;
        for (const chunk of this.audioBuffer) {
          if (this.isTerminalState()) break;
          session.sendAudio(chunk);
        }
        this.audioBuffer = [];
      }
      this.emitter.emit("connected");
      this.emitter.emit("reconnected", { attempt: this._reconnectAttempt });
      this._reconnectAttempt = 0;
    }
    /**
    * Check whether an in-flight reconnect should be aborted.
    * Handles both terminal states and a pending stop() request.
    */
    shouldAbortReconnect() {
      if (this.isTerminalState()) return true;
      if (this._state === "stopping") {
        this.settleStop();
        this.cleanup("stopped", "user_action");
        return true;
      }
      return false;
    }
    cleanup(finalState, reason) {
      this.setState(finalState, reason);
      this.audioBuffer = [];
      this.isBuffering = false;
      this._isSourceMuted = false;
      this._reconnectAttempt = 0;
    }
    setState(newState, reason) {
      if (this._state === newState) return;
      const oldState = this._state;
      this._state = newState;
      const update = {
        old_state: oldState,
        new_state: newState
      };
      if (reason !== void 0) update.reason = reason;
      this.emitter.emit("state_change", update);
    }
    isTerminalState() {
      return TERMINAL_STATES.includes(this._state);
    }
    settleStop(error) {
      const resolve = this.stopResolver;
      const reject = this.stopRejecter;
      this.stopResolver = null;
      this.stopRejecter = null;
      if (error) reject?.(error);
      else resolve?.();
    }
  };
  var SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
  var SonioxClient = class {
    /** @internal */
    _configResolver;
    /**
    * STT WebSocket URL resolved at construction time from the client's `config`,
    * when that config is a plain object (not an async function). Used by the
    * synchronous low-level `client.realtime.stt()` factory so it honors the
    * configured region. Remains `undefined` for async-config clients — those
    * must supply `ws_base_url` or use `client.realtime.record()`.
    *
    * @internal
    */
    preResolvedSttWsUrl;
    permissionResolver;
    defaultBufferQueueSize;
    defaultSessionOptions;
    wsBaseUrl;
    /**
    * Real-time API namespace
    */
    realtime;
    /**
    * REST TTS API namespace.
    *
    * @example
    * ```typescript
    * const audio = await client.tts.generate({
    *   text: 'Hello',
    *   voice: 'Adrian',
    *   language: 'en',
    * });
    * ```
    */
    tts;
    constructor(options) {
      if (options.config !== void 0 && options.api_key !== void 0) throw new Error("Cannot specify both `config` and `api_key`. Use `config` for new code.");
      if (options.config === void 0 && options.api_key === void 0) throw new Error("Either `config` or `api_key` must be provided.");
      const { resolver, preResolvedSttWsUrl } = buildConfigResolver(options);
      this._configResolver = resolver;
      this.preResolvedSttWsUrl = preResolvedSttWsUrl;
      this.wsBaseUrl = options.ws_base_url;
      this.permissionResolver = options.permissions;
      this.defaultBufferQueueSize = options.buffer_queue_size ?? 1e3;
      this.defaultSessionOptions = options.default_session_options;
      const ttsCall = (input) => this.createSingleTtsStream(input ?? {});
      ttsCall.multiStream = () => this.createTtsConnection();
      this.tts = {
        generate: (opts) => this.ttsRestGenerate(opts),
        generateStream: (opts) => this.ttsRestGenerateStream(opts)
      };
      this.realtime = {
        record: (recordOptions) => this.createRecording(recordOptions),
        stt: (config, sttOptions) => this.createSession(config, sttOptions),
        tts: ttsCall
      };
    }
    /**
    * Permission resolver, if configured.
    * Returns `undefined` if no resolver was provided (SSR-safe).
    *
    * @example
    * ```typescript
    * const mic = await client.permissions?.check('microphone');
    * if (mic?.status === 'denied') {
    *   showSettingsMessage();
    * }
    * ```
    */
    get permissions() {
      return this.permissionResolver;
    }
    createRecording(options) {
      const { source, signal, buffer_queue_size, session_options, session_config, auto_reconnect, max_reconnect_attempts, reconnect_base_delay_ms, reset_transcript_on_reconnect, ...sttConfig } = options;
      const audioSource = source ?? new MicrophoneSource();
      const sttConfigInput = session_config ?? sttConfig;
      return new Recording(this._configResolver, sttConfigInput, audioSource, {
        buffer_queue_size: buffer_queue_size ?? this.defaultBufferQueueSize,
        session_options: {
          ...this.defaultSessionOptions,
          ...session_options,
          ...signal !== void 0 ? { signal } : {}
        },
        ...signal !== void 0 ? { signal } : {},
        ...auto_reconnect !== void 0 ? { auto_reconnect } : {},
        ...max_reconnect_attempts !== void 0 ? { max_reconnect_attempts } : {},
        ...reconnect_base_delay_ms !== void 0 ? { reconnect_base_delay_ms } : {},
        ...reset_transcript_on_reconnect !== void 0 ? { reset_transcript_on_reconnect } : {}
      });
    }
    createSession(config, options) {
      const mergedSessionOptions = {
        ...this.defaultSessionOptions,
        ...options.session_options
      };
      const wsUrl = this.wsBaseUrl ?? this.preResolvedSttWsUrl;
      if (wsUrl === void 0) throw new SonioxError("Cannot resolve STT WebSocket URL synchronously because `config` was provided as an async function. Either pass `ws_base_url` to `SonioxClient`, use a sync `config` object, or call `client.realtime.record()` which supports async config.", "state_error");
      return new RealtimeSttSession(options.api_key, wsUrl, config, mergedSessionOptions);
    }
    async createSingleTtsStream(input) {
      const resolved = await this._configResolver({ usage: "tts_rt" });
      return new RealtimeTtsConnection(resolved.api_key, resolved.tts_ws_url, resolved.tts_defaults)._openStream(input, true);
    }
    async createTtsConnection() {
      const resolved = await this._configResolver({ usage: "tts_rt" });
      const connection = new RealtimeTtsConnection(resolved.api_key, resolved.tts_ws_url, resolved.tts_defaults);
      await connection.connect();
      return connection;
    }
    async ttsRestGenerate(options) {
      const resolved = await this._configResolver({ usage: "tts_rt" });
      return new TtsRestClient(resolved.api_key, resolved.tts_api_url).generate(options);
    }
    async *ttsRestGenerateStream(options) {
      const resolved = await this._configResolver({ usage: "tts_rt" });
      yield* new TtsRestClient(resolved.api_key, resolved.tts_api_url).generateStream(options);
    }
  };
  function buildConfigResolver(options) {
    if (options.config !== void 0) {
      const configInput = options.config;
      const resolver$1 = async (context) => {
        return resolveConnectionConfig(typeof configInput === "function" ? await configInput(context) : configInput);
      };
      return {
        resolver: resolver$1,
        preResolvedSttWsUrl: typeof configInput === "function" ? void 0 : resolveConnectionConfig(configInput).stt_ws_url
      };
    }
    const apiKeyConfig = options.api_key;
    const wsBaseUrl = options.ws_base_url ?? SONIOX_WS_URL;
    const resolver = async () => {
      return {
        api_key: await resolveApiKey(apiKeyConfig),
        api_domain: "https://api.soniox.com",
        stt_ws_url: wsBaseUrl,
        tts_api_url: "https://tts-rt.soniox.com",
        tts_ws_url: "wss://tts-rt.soniox.com/tts-websocket",
        stt_defaults: {},
        tts_defaults: {},
        session_defaults: {}
      };
    };
    return {
      resolver,
      preResolvedSttWsUrl: wsBaseUrl
    };
  }

  // cloudcli-frontend-overlay/src/soniox-composer-realtime.ts
  var REALTIME_KEY_ENDPOINT = "/api/plugins/cloudcli-plugin-soniox/rpc/realtime-key";
  var DEFAULT_MODEL2 = "stt-rt-v5";
  var CONTROL_TOKENS = /* @__PURE__ */ new Set(["<end>", "<fin>"]);
  var LiveTranscript = class {
    committed = "";
    provisional = "";
    get text() {
      return `${this.committed}${this.provisional}`;
    }
    get finalText() {
      return this.committed;
    }
    add(result) {
      let finalized = "";
      let provisional = "";
      for (const token of result.tokens) {
        if (!token.text || CONTROL_TOKENS.has(token.text)) continue;
        if (token.is_final) finalized += token.text;
        else provisional += token.text;
      }
      this.committed += finalized;
      this.provisional = provisional;
      return this.text;
    }
    clearInterim() {
      this.provisional = "";
      return this.text;
    }
    reset() {
      this.committed = "";
      this.provisional = "";
    }
  };
  async function authenticatedFetch(url, init) {
    const token = localStorage.getItem("auth-token");
    return fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...token ? { Authorization: `Bearer ${token}` } : {},
        ...init.headers
      }
    });
  }
  async function fetchRealtimeConfig() {
    const response = await authenticatedFetch(REALTIME_KEY_ENDPOINT, {
      method: "POST",
      body: JSON.stringify({})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Soniox real-time key request failed (${response.status})`);
    }
    if (!data.apiKey) {
      throw new Error("Soniox did not return a temporary real-time key.");
    }
    return {
      api_key: data.apiKey,
      stt_defaults: {
        model: data.model?.trim() || DEFAULT_MODEL2,
        language_hints: data.languageHints?.filter(Boolean).length ? data.languageHints.filter(Boolean) : ["fa"]
      }
    };
  }
  function startRecording(handlers) {
    const transcript = new LiveTranscript();
    const client = new SonioxClient({ config: fetchRealtimeConfig });
    let active = true;
    let sessionStarted = false;
    const recording = client.realtime.record({
      // Required by the SDK's structural type. session_config supplies the
      // effective model and language hints returned by the plugin backend.
      model: DEFAULT_MODEL2,
      session_config: (resolved) => ({
        ...resolved.stt_defaults,
        model: resolved.stt_defaults.model || DEFAULT_MODEL2,
        language_hints: resolved.stt_defaults.language_hints?.length ? resolved.stt_defaults.language_hints : ["fa"],
        enable_endpoint_detection: true
      }),
      auto_reconnect: true,
      max_reconnect_attempts: 3
    });
    recording.on("result", (result) => {
      if (active) handlers.onTranscript(transcript.add(result));
    });
    recording.on("session_restart", ({ reset_transcript }) => {
      if (!active) return;
      if (sessionStarted) {
        if (reset_transcript) transcript.reset();
        else transcript.clearInterim();
        handlers.onTranscript(transcript.text);
      }
      sessionStarted = true;
    });
    recording.on("source_muted", () => {
      if (active) handlers.onMuted?.();
    });
    recording.on("error", (error) => {
      if (!active) return;
      active = false;
      handlers.onError(error, transcript.clearInterim());
    });
    return {
      get state() {
        return recording.state;
      },
      get finalText() {
        return transcript.finalText;
      },
      async stop() {
        await recording.stop();
        active = false;
        return transcript.clearInterim();
      },
      cancel() {
        if (!active) return;
        active = false;
        recording.cancel();
      }
    };
  }
  globalThis.CloudcliSonioxRealtime = { startRecording };
})();
