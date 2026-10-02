import { vi } from 'vitest';

// Minimal in-memory stand-in for the `chrome` extension API.
// Any `chrome.<ns>.on<Event>` becomes a capturable event; any other method is
// a vi.fn() that resolves to undefined unless overridden via `impl`.

function createEvent() {
  const listeners = new Set();
  return {
    addListener: fn => listeners.add(fn),
    removeListener: fn => listeners.delete(fn),
    hasListener: fn => listeners.has(fn),
    // Test-only: invoke every registered listener and collect results.
    dispatch: (...args) => [...listeners].map(fn => fn(...args)),
    get size() {
      return listeners.size;
    },
  };
}

function createStorageArea(areaName, initial, onChangedEvent) {
  const data = structuredClone(initial);

  function pick(keys) {
    if (keys == null) return structuredClone(data);
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) {
      return Object.fromEntries(
        keys.filter(key => key in data).map(key => [key, structuredClone(data[key])]),
      );
    }
    return Object.fromEntries(
      Object.entries(keys).map(([key, fallback]) => [
        key,
        key in data ? structuredClone(data[key]) : fallback,
      ]),
    );
  }

  return {
    data,
    get: vi.fn(async keys => pick(keys)),
    set: vi.fn(async items => {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        const oldValue = data[key];
        if (JSON.stringify(oldValue) === JSON.stringify(value)) continue;
        data[key] = structuredClone(value);
        changes[key] = { oldValue, newValue: structuredClone(value) };
      }
      // Chrome delivers storage.onChanged asynchronously to every context.
      if (Object.keys(changes).length) {
        setTimeout(() => onChangedEvent.dispatch(changes, areaName), 0);
      }
    }),
    remove: vi.fn(async keys => {
      for (const key of [].concat(keys)) delete data[key];
    }),
  };
}

const DEFAULT_IMPL = {
  'runtime.getURL': path => `chrome-extension://test-id/${String(path).replace(/^\//, '')}`,
  'runtime.lastError': undefined,
  'runtime.id': 'test-id',
};

export function createFakeChrome({ local = {}, sync = {}, impl = {} } = {}) {
  const onChanged = createEvent();
  const storage = {
    onChanged,
    local: createStorageArea('local', local, onChanged),
    sync: createStorageArea('sync', sync, onChanged),
  };
  const overrides = { ...DEFAULT_IMPL, ...impl };

  function namespace(path) {
    const cache = {};
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== 'string') return undefined;
          if (prop in cache) return cache[prop];
          const fullPath = path ? `${path}.${prop}` : prop;
          if (fullPath === 'storage') return (cache[prop] = storage);
          if (fullPath === 'contextMenus') return (cache[prop] = undefined);
          if (fullPath in overrides) {
            const value = overrides[fullPath];
            return (cache[prop] = typeof value === 'function' ? vi.fn(value) : value);
          }
          if (/^on[A-Z]/.test(prop)) return (cache[prop] = createEvent());
          if (path) return (cache[prop] = vi.fn(async () => undefined));
          return (cache[prop] = namespace(fullPath));
        },
      },
    );
  }

  return namespace('');
}

// Lets pending setTimeout(0) storage events and promise chains settle.
export function flush(ms = 5) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
