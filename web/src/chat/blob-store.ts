// Ticket 371 item 24: the composer's images at rest (stash entries and unsent chips), one record per key. IndexedDB holds
// File and Blob directly, so nothing is encoded. Kept thin on purpose; stash.ts and images/attach.ts hold every rule.
// Adapted from Orca `src/renderer/src/components/native-chat/native-chat-composer-draft-indexeddb.ts`, 1.4.214 (the open and
// the committed write). MIT License, Copyright (c) 2026 Lovecast Inc.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

const DATABASE_NAME = 'nunchiro-composer-blobs';
const DATABASE_VERSION = 1;
const BLOBS = 'blobs';

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolves once the transaction is on disk; rejects when it aborts (a full disk included). */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('blob write aborted'));
  });
}

let opened: Promise<IDBDatabase> | null = null;
const database = (): Promise<IDBDatabase> => {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(BLOBS)) request.result.createObjectStore(BLOBS);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A newer build upgrading the database, or the webview closing it, must not leave every later write failing.
      db.onversionchange = () => db.close();
      db.onclose = () => {
        opened = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blob database is blocked'));
  }).catch((error: unknown) => {
    opened = null;
    throw error;
  });
  return opened;
};

const change = async (apply: (blobs: IDBObjectStore) => void): Promise<void> => {
  const transaction = (await database()).transaction(BLOBS, 'readwrite');
  const done = committed(transaction);
  apply(transaction.objectStore(BLOBS));
  // Commit now rather than when the task ends, so a reload right after still lands it.
  transaction.commit?.();
  await done;
};

export const blobStore = {
  /** Every record whose key starts with `prefix`. */
  loadAll: async (prefix: string): Promise<[string, unknown][]> => {
    const blobs = (await database()).transaction(BLOBS, 'readonly').objectStore(BLOBS);
    const range = IDBKeyRange.bound(prefix, prefix + String.fromCodePoint(0xffff));
    const [keys, values] = await Promise.all([settled(blobs.getAllKeys(range)), settled(blobs.getAll(range))]);
    return keys.map((key, i) => [String(key), values[i]]);
  },
  write: (key: string, value: unknown): Promise<void> => change((blobs) => blobs.put(value, key)),
  remove: (keys: string[]): Promise<void> => change((blobs) => keys.forEach((key) => blobs.delete(key))),
};
