/**
 * The guest-side prelude, evaluated in every sandbox before the contract.
 *
 * It provides:
 *
 *   - `ctx.storage.<collection>`, a set of typed handles declared at deploy
 *   - `StoredValue`, `StoredMap`, `StoredArray` handles
 *   - `defineContract({ storage, endpoints, init })`
 *   - a small `console` that forwards to the host log buffer
 *
 * Native `Map` and `Array` are untouched: contracts can use them for
 * in-memory work, and only `ctx.storage` talks to Postgres.
 *
 * The host functions are asynchronous. Each starts a query and returns a
 * QuickJS promise; the sandbox driver awaits in-flight queries and drains the
 * job queue, so contract code just writes ordinary `await` while the host
 * keeps one Postgres transaction open around the whole call.
 */
export const PRELUDE_SOURCE = String.raw`
"use strict";
(function () {
  var host = globalThis.__ds_host;
  delete globalThis.__ds_host;

  var parse = JSON.parse;
  var stringify = JSON.stringify;

  function toJson(value) {
    if (value === undefined) throw new TypeError("value cannot be undefined");
    var text = stringify(value);
    if (text === undefined) throw new TypeError("value is not JSON-serializable");
    return text;
  }

  function fromJson(text) {
    return text === undefined ? undefined : parse(text);
  }

  function wrap(descriptor) {
    if (descriptor === undefined || descriptor === null) return undefined;
    if (descriptor.k === "map") return new StoredMap(descriptor);
    if (descriptor.k === "array") return new StoredArray(descriptor);
    if (descriptor.k === "value") return new StoredValue(descriptor);
    throw new Error("unknown stored handle kind: " + descriptor.k);
  }

  function describe(raw) {
    return raw === undefined ? undefined : wrap(parse(raw));
  }

  function decodeItem(raw) {
    if (raw === undefined) return undefined;
    var item = parse(raw);
    if (item.t === "v") return parse(item.s);
    return wrap(item.d);
  }

  function decodeItems(raw) {
    return fromJson(raw).map(function (item) {
      return item.t === "v" ? parse(item.s) : wrap(item.d);
    });
  }

  function decodeEntries(raw) {
    return fromJson(raw).map(function (entry) {
      return [entry.key, entry.t === "v" ? parse(entry.s) : wrap(entry.d)];
    });
  }

  class StoredValue {
    constructor(descriptor) {
      this.__id = descriptor.h;
    }
    async get() { return fromJson(await host.valueGet(this.__id)); }
    async set(value) { await host.valueSet(this.__id, toJson(value)); }
    async delete() { await host.valueDelete(this.__id); }
  }

  class StoredMap {
    constructor(descriptor) {
      this.__id = descriptor.h;
      this.__child = descriptor.c; // "value" | "map" | "array"
    }

    async get(key) {
      if (this.__child === "value") {
        return fromJson(await host.mapGet(this.__id, key));
      }
      return describe(await host.mapChild(this.__id, key));
    }

    async set(key, value) {
      if (this.__child !== "value") {
        throw new TypeError(
          "this map holds nested collections; use get() and write through the child handle",
        );
      }
      await host.mapSet(this.__id, key, toJson(value));
    }

    async has(key) { return await host.mapHas(this.__id, key); }
    async delete(key) { await host.mapDelete(this.__id, key); }

    async keys(limit, offset) {
      return fromJson(await host.mapKeys(
        this.__id,
        limit === undefined ? 100 : limit,
        offset === undefined ? 0 : offset,
      ));
    }

    async entries(limit, offset) {
      return decodeEntries(await host.mapEntries(
        this.__id,
        limit === undefined ? 100 : limit,
        offset === undefined ? 0 : offset,
      ));
    }

    async size() { return await host.mapSize(this.__id); }
    async clear() { await host.mapClear(this.__id); }

    async *[Symbol.asyncIterator]() {
      var pageSize = 100;
      var skip = 0;
      for (;;) {
        var page = await this.entries(pageSize, skip);
        if (page.length === 0) return;
        for (var index = 0; index < page.length; index++) yield page[index];
        if (page.length < pageSize) return;
        skip += page.length;
      }
    }
  }

  class StoredArray {
    constructor(descriptor) {
      this.__id = descriptor.h;
      this.__child = descriptor.c; // "value" | "map" | "array"
    }

    async get(index) {
      return decodeItem(await host.arrayGet(this.__id, index));
    }

    async slice(start, count) {
      return decodeItems(await host.arraySlice(this.__id, start, count));
    }

    async length() { return await host.arrayLength(this.__id); }

    async set(index, value) {
      if (this.__child !== "value") {
        throw new TypeError("this array holds nested collections; use createAt()");
      }
      await host.arraySet(this.__id, index, toJson(value));
    }

    async insert(index, items) {
      if (this.__child !== "value") {
        throw new TypeError("this array holds nested collections; use createAt()");
      }
      await host.arrayInsert(this.__id, index, items.map(toJson));
    }

    async addToTop(items) { await this.insert(0, items); }

    async addToBottom(items) {
      var length = await this.length();
      await this.insert(length, items);
    }

    async push() {
      var length = await this.length();
      if (this.__child === "value") {
        if (arguments.length === 0) return length;
        var items = Array.prototype.slice.call(arguments);
        return await host.arrayInsert(this.__id, length, items.map(toJson));
      }
      if (arguments.length > 0) {
        throw new TypeError("this array holds nested collections; push() takes no arguments");
      }
      return wrap(parse(await host.arrayCreate(this.__id, length)));
    }

    async unshift() {
      if (this.__child === "value") {
        if (arguments.length === 0) return await this.length();
        var items = Array.prototype.slice.call(arguments);
        await host.arrayInsert(this.__id, 0, items.map(toJson));
        return await this.length();
      }
      if (arguments.length > 0) {
        throw new TypeError("this array holds nested collections; unshift() takes no arguments");
      }
      return wrap(parse(await host.arrayCreate(this.__id, 0)));
    }

    async createAt(index) {
      if (this.__child === "value") {
        throw new TypeError("this array holds values; use insert()");
      }
      return wrap(parse(await host.arrayCreate(this.__id, index)));
    }

    async removeAt(index, count) {
      var raw = await host.arrayRemoveAt(
        this.__id,
        index,
        count === undefined ? 1 : count,
      );
      return fromJson(raw).map(function (value) { return fromJson(value); });
    }

    async pop() {
      var length = await this.length();
      if (length === 0) return undefined;
      var removed = await this.removeAt(length - 1, 1);
      return removed[0];
    }

    async shift() {
      var removed = await this.removeAt(0, 1);
      return removed[0];
    }

    async move(from, to) { await host.arrayMove(this.__id, from, to); }
    async moveToTop(index) { await host.arrayMoveToTop(this.__id, index); }
    async moveToBottom(index) { await host.arrayMoveToBottom(this.__id, index); }
    async clear() { await host.arrayClear(this.__id); }

    async *[Symbol.asyncIterator]() {
      var pageSize = 100;
      var skip = 0;
      for (;;) {
        var page = await this.slice(skip, pageSize);
        if (page.length === 0) return;
        for (var index = 0; index < page.length; index++) yield page[index];
        if (page.length < pageSize) return;
        skip += page.length;
      }
    }
  }

  function format(value) {
    if (typeof value === "string") return value;
    try { return stringify(value); } catch (error) { return String(value); }
  }

  function write(level, args) {
    var parts = [];
    for (var index = 0; index < args.length; index++) parts.push(format(args[index]));
    host.log(level, parts.join(" "));
  }

  globalThis.console = Object.freeze({
    log: function () { write("log", arguments); },
    info: function () { write("info", arguments); },
    warn: function () { write("warn", arguments); },
    error: function () { write("error", arguments); },
    debug: function () { write("debug", arguments); },
  });

  var collectionNames = null;
  function names() {
    if (collectionNames === null) collectionNames = fromJson(host.collectionNames());
    return collectionNames;
  }

  var roots = Object.create(null);
  var storage = new Proxy(Object.create(null), {
    get: function (_target, name) {
      if (typeof name !== "string") return undefined;
      if (roots[name] !== undefined) return roots[name];
      var handle = wrap(parse(host.root(name)));
      roots[name] = handle;
      return handle;
    },
    has: function (_target, name) {
      return typeof name === "string" && names().indexOf(name) !== -1;
    },
    ownKeys: function () { return names().slice(); },
    getOwnPropertyDescriptor: function (_target, name) {
      if (typeof name === "string" && names().indexOf(name) !== -1) {
        return { enumerable: true, configurable: true };
      }
      return undefined;
    },
    set: function () { throw new Error("storage is read-only"); },
    deleteProperty: function () { throw new Error("storage is read-only"); },
  });

  globalThis.defineContract = function (definition) {
    if (globalThis.__ds_contract) throw new Error("defineContract may only be called once");
    if (!definition || typeof definition !== "object") {
      throw new TypeError("defineContract expects an object");
    }
    globalThis.__ds_contract = definition;
  };

  globalThis.__ds_readManifest = function () {
    var contract = globalThis.__ds_contract;
    if (!contract || typeof contract !== "object") {
      throw new Error("the contract must call defineContract({ ... }) while loading");
    }
    var endpoints = contract.endpoints;
    if (!endpoints || typeof endpoints !== "object") {
      throw new Error("defineContract requires an endpoints object");
    }
    var endpointNames = Object.keys(endpoints);
    if (endpointNames.length === 0) {
      throw new Error("the contract must define at least one endpoint");
    }
    if (endpointNames.length > 64) {
      throw new Error("the contract defines too many endpoints (max 64)");
    }

    var manifest = {
      name: contract.name === undefined ? "" : String(contract.name),
      version: contract.version === undefined ? "0" : String(contract.version),
      endpoints: {},
      storage: contract.storage === undefined ? {} : contract.storage,
      events: contract.events === undefined ? {} : contract.events,
      hasInit: typeof contract.init === "function",
    };
    if (!manifest.storage || typeof manifest.storage !== "object" || Array.isArray(manifest.storage)) {
      throw new Error("defineContract storage must be an object");
    }
    if (!manifest.events || typeof manifest.events !== "object" || Array.isArray(manifest.events)) {
      throw new Error("defineContract events must be an object");
    }

    for (var index = 0; index < endpointNames.length; index++) {
      var name = endpointNames[index];
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
        throw new Error("invalid endpoint name: " + name);
      }
      var endpoint = endpoints[name];
      if (!endpoint || typeof endpoint.run !== "function") {
        throw new Error("endpoint " + name + " needs a run function");
      }
      var gasLimit = endpoint.gasLimit === undefined ? 0 : endpoint.gasLimit;
      if (typeof gasLimit !== "number" || !Number.isInteger(gasLimit) || gasLimit < 0) {
        throw new Error("endpoint " + name + " has an invalid gasLimit");
      }
      var access = endpoint.access === undefined ? "public" : endpoint.access;
      if (
        access !== "public" &&
        access !== "human" &&
        access !== "contract" &&
        access !== "roster-lock"
      ) {
        throw new Error(
          "endpoint " + name + ' access must be "public", "human", "contract" or "roster-lock"',
        );
      }
      var mutates = endpoint.mutates === undefined ? true : endpoint.mutates;
      if (typeof mutates !== "boolean") {
        throw new Error("endpoint " + name + " mutates must be a boolean");
      }
      var endpointManifest = {
        gasLimit: gasLimit,
        access: access,
        mutates: mutates,
      };
      if (endpoint.input !== undefined) {
        if (
          !endpoint.input ||
          typeof endpoint.input !== "object" ||
          Array.isArray(endpoint.input)
        ) {
          throw new Error("endpoint " + name + " input must be a JSON Schema object");
        }
        endpointManifest.input = endpoint.input;
      }
      manifest.endpoints[name] = endpointManifest;
    }
    return stringify(manifest);
  };

  function errorText(error) {
    try {
      if (error && typeof error === "object") {
        var name = error.name === undefined ? "Error" : String(error.name);
        var message = error.message === undefined ? "" : String(error.message);
        var stack = typeof error.stack === "string" ? error.stack : "";
        var text = name + (message ? ": " + message : "");
        return stack ? text + "\n" + stack : text;
      }
      return String(error);
    } catch (ignored) {
      return "unknown error";
    }
  }

  function settle(promise) {
    promise.then(
      function (value) {
        try {
          host.finish(0, toJson(value === undefined ? null : value));
        } catch (error) {
          host.finish(1, errorText(error));
        }
      },
      function (error) {
        host.finish(1, errorText(error));
      },
    );
  }

  async function emit(name, payload) {
    await host.emit(name, toJson(payload));
  }

  function snapshotChild(node) {
    if (node.kind === "value") return node.value;
    if (node.kind === "map") return new SnapshotMap(node.value);
    if (node.kind === "array") return new SnapshotArray(node.value);
    throw new Error("unknown storage snapshot node: " + node.kind);
  }

  class SnapshotValue {
    constructor(node) { this.node = node; }
    async get() { return this.node.value; }
    async set() { throw new Error("sibling storage is read-only"); }
    async delete() { throw new Error("sibling storage is read-only"); }
  }

  class SnapshotMap {
    constructor(entries) { this.entries = entries; }
    async get(key) {
      return Object.prototype.hasOwnProperty.call(this.entries, key)
        ? snapshotChild(this.entries[key])
        : undefined;
    }
    async has(key) { return Object.prototype.hasOwnProperty.call(this.entries, key); }
    async keys() { return Object.keys(this.entries); }
    async entries() {
      var self = this;
      return Object.keys(this.entries).map(function (key) {
        return [key, snapshotChild(self.entries[key])];
      });
    }
    async size() { return Object.keys(this.entries).length; }
    async set() { throw new Error("sibling storage is read-only"); }
    async delete() { throw new Error("sibling storage is read-only"); }
  }

  class SnapshotArray {
    constructor(items) { this.items = items; }
    async get(index) {
      return index < 0 || index >= this.items.length
        ? undefined
        : snapshotChild(this.items[index]);
    }
    async slice(start, count) {
      var out = [];
      for (var i = start; i < start + count && i < this.items.length; i++) {
        out.push(snapshotChild(this.items[i]));
      }
      return out;
    }
    async length() { return this.items.length; }
    async set() { throw new Error("sibling storage is read-only"); }
    async insert() { throw new Error("sibling storage is read-only"); }
    async removeAt() { throw new Error("sibling storage is read-only"); }
  }

  function makeContractHandles(list) {
    var out = {};
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var storage = {};
      for (var name in item.storage) {
        var node = item.storage[name];
        storage[name] = node.kind === "value"
          ? new SnapshotValue(node)
          : snapshotChild(node);
      }
      out[item.handle] = Object.freeze({
        name: item.handle,
        id: item.contractId,
        storage: Object.freeze(storage),
        call: async function (endpoint, input) {
          return fromJson(await host.contractCall(
            item.contractId,
            String(endpoint),
            toJson(input === undefined ? null : input),
          ));
        },
      });
    }
    return Object.freeze(out);
  }

  function makeContext(meta, endpointName) {
    return Object.freeze({
      storage: storage,
      emit: emit,
      msgSender: Object.freeze({
        kind: meta.msgSender.kind,
        id: meta.msgSender.id,
      }),
      txOrigin: Object.freeze({
        kind: meta.txOrigin.kind,
        id: meta.txOrigin.id,
        ...(meta.txOrigin.delegate === undefined
          ? {}
          : { delegate: meta.txOrigin.delegate }),
      }),
      contract: meta.contract,
      contractId: meta.contractId,
      callId: meta.callId,
      endpoint: endpointName,
      contracts: makeContractHandles(meta.contracts || []),
    });
  }

  globalThis.__ds_invoke = function (endpointName, inputJson, metaJson) {
    try {
      var contract = globalThis.__ds_contract;
      var endpoints = contract && contract.endpoints;
      var endpoint = endpoints && endpoints[endpointName];
      if (!endpoint || typeof endpoint.run !== "function") {
        throw new Error("unknown endpoint: " + endpointName);
      }
      var meta = parse(metaJson);
      var ctx = makeContext(meta, endpointName);
      settle(Promise.resolve(endpoint.run.call(ctx, parse(inputJson), ctx)));
    } catch (error) {
      host.finish(1, errorText(error));
    }
  };

  globalThis.__ds_run_init = function (metaJson) {
    try {
      var contract = globalThis.__ds_contract;
      if (!contract || typeof contract.init !== "function") {
        throw new Error("the contract has no init hook");
      }
      var meta = parse(metaJson);
      var ctx = makeContext(meta, "init");
      settle(Promise.resolve(contract.init.call(ctx, ctx, meta.initArgs)));
    } catch (error) {
      host.finish(1, errorText(error));
    }
  };
})();
`;
