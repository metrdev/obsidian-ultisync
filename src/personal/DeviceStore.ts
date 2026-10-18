/** Browser-profile storage: never placed in the vault or copied by iCloud. */
export class DeviceStore {
 private database: Promise<IDBDatabase> | null = null;
 constructor(private namespace: string, private factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB) {}
 private open(): Promise<IDBDatabase> {
  if (!this.factory) return Promise.reject(new Error('IndexedDB unavailable; synchronization is disabled.'));
  return this.database ??= new Promise((resolve, reject) => {
   const request = this.factory!.open('personal-vault-sync', 1);
   request.onupgradeneeded = () => request.result.createObjectStore('profiles');
   request.onerror = () => reject(new Error('IndexedDB could not be opened.'));
   request.onblocked = () => reject(new Error('IndexedDB is blocked.'));
   request.onsuccess = () => {
    const db = request.result;
    db.onversionchange = () => db.close();
    resolve(db);
   };
  });
 }
 async get<T>(key: string): Promise<T | undefined> {
  const db = await this.open();
  return new Promise((resolve, reject) => {
   const tx = db.transaction('profiles', 'readonly');
   const request = tx.objectStore('profiles').get(this.namespace + ':' + key);
   tx.oncomplete = () => resolve(request.result as T | undefined);
   tx.onabort = tx.onerror = () => reject(new Error('IndexedDB read failed.'));
  });
 }
 async put(key: string, value: unknown): Promise<void> {
  const db = await this.open();
  return new Promise((resolve, reject) => {
   const tx = db.transaction('profiles', 'readwrite');
   tx.objectStore('profiles').put(value, this.namespace + ':' + key);
   tx.oncomplete = () => resolve();
   tx.onabort = tx.onerror = () => reject(new Error('IndexedDB write failed.'));
  });
 }
 close(): void { void this.database?.then(db => db.close()); }
}
