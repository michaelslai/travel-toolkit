/* =========================================================
   Travel Toolkit V2.2.0 Modular
   File: js/db.js
   Modified: 2026-09-12

   Changes:
   - 從 V2.1.2 index.html 抽離 IndexedDB 核心
   - 保留原 Local-first 邏輯
   - 不修改資料格式
   - IndexedDB schema 維持 Version 4
========================================================= */

import {

  DB_NAME,
  DB_VERSION,

  STORE_TRIPS,
  STORE_FOOTPRINTS,
  STORE_FOOD,
  STORE_EXPENSES,
  STORE_SYNC_QUEUE,
  STORE_META

} from "./config.js";


/* =========================================================
   DATABASE HANDLE
========================================================= */

let db =
  null;


/* =========================================================
   BASIC TIME
========================================================= */

function nowISO() {

  return new Date()
    .toISOString();

}


/* =========================================================
   OPEN DATABASE
========================================================= */

export function openLocalDB() {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      if (
        !window.indexedDB
      ) {

        reject(
          new Error(
            "此瀏覽器不支援 IndexedDB"
          )
        );

        return;

      }


      const request =
        indexedDB.open(
          DB_NAME,
          DB_VERSION
        );


      request.onupgradeneeded =
        event => {

          const database =
            event.target.result;


          const transaction =
            event.target.transaction;


          const entityStores = [

            STORE_TRIPS,
            STORE_FOOTPRINTS,
            STORE_FOOD,
            STORE_EXPENSES

          ];


          entityStores.forEach(
            storeName => {

              let store;


              if (
                !database
                  .objectStoreNames
                  .contains(
                    storeName
                  )
              ) {

                store =
                  database.createObjectStore(
                    storeName,
                    {
                      keyPath:
                        "client_uid"
                    }
                  );

              }
              else {

                store =
                  transaction.objectStore(
                    storeName
                  );

              }


              if (
                !store
                  .indexNames
                  .contains(
                    "cloud_id"
                  )
              ) {

                store.createIndex(
                  "cloud_id",
                  "cloud_id",
                  {
                    unique:
                      false
                  }
                );

              }


              if (
                !store
                  .indexNames
                  .contains(
                    "sync_status"
                  )
              ) {

                store.createIndex(
                  "sync_status",
                  "sync_status",
                  {
                    unique:
                      false
                  }
                );

              }


              if (
                !store
                  .indexNames
                  .contains(
                    "updated_at"
                  )
              ) {

                store.createIndex(
                  "updated_at",
                  "updated_at",
                  {
                    unique:
                      false
                  }
                );

              }

            }
          );


          if (
            !database
              .objectStoreNames
              .contains(
                STORE_SYNC_QUEUE
              )
          ) {

            database.createObjectStore(
              STORE_SYNC_QUEUE,
              {
                keyPath:
                  "id"
              }
            );

          }


          if (
            !database
              .objectStoreNames
              .contains(
                STORE_META
              )
          ) {

            database.createObjectStore(
              STORE_META,
              {
                keyPath:
                  "key"
              }
            );

          }

        };


      request.onsuccess =
        event => {

          db =
            event.target.result;


          db.onversionchange =
            () => {

              db.close();

            };


          resolve(
            db
          );

        };


      request.onerror =
        () => {

          reject(
            request.error ||
            new Error(
              "IndexedDB 開啟失敗"
            )
          );

        };


      request.onblocked =
        () => {

          reject(
            new Error(
              "IndexedDB 升級被其他 Travel Toolkit 分頁阻擋，請關閉其他分頁後重試"
            )
          );

        };

    }
  );

}


/* =========================================================
   DATABASE READY CHECK
========================================================= */

function requireDB() {

  if (
    !db
  ) {

    throw new Error(
      "IndexedDB 尚未初始化"
    );

  }

}


/* =========================================================
   DB PUT
========================================================= */

export function dbPut(
  storeName,
  value
) {

  requireDB();


  return new Promise(
    (
      resolve,
      reject
    ) => {

      const transaction =
        db.transaction(
          storeName,
          "readwrite"
        );


      transaction
        .objectStore(
          storeName
        )
        .put(
          value
        );


      transaction.oncomplete =
        () => {

          resolve(
            value
          );

        };


      transaction.onerror =
        () => {

          reject(
            transaction.error ||
            new Error(
              "IndexedDB 寫入失敗"
            )
          );

        };


      transaction.onabort =
        () => {

          reject(
            transaction.error ||
            new Error(
              "IndexedDB 寫入中止"
            )
          );

        };

    }
  );

}


/* =========================================================
   DB GET
========================================================= */

export function dbGet(
  storeName,
  key
) {

  requireDB();


  return new Promise(
    (
      resolve,
      reject
    ) => {

      const request =
        db.transaction(
          storeName,
          "readonly"
        )
        .objectStore(
          storeName
        )
        .get(
          key
        );


      request.onsuccess =
        () => {

          resolve(
            request.result ||
            null
          );

        };


      request.onerror =
        () => {

          reject(
            request.error ||
            new Error(
              "IndexedDB 讀取失敗"
            )
          );

        };

    }
  );

}


/* =========================================================
   DB GET ALL
========================================================= */

export function dbGetAll(
  storeName
) {

  requireDB();


  return new Promise(
    (
      resolve,
      reject
    ) => {

      const request =
        db.transaction(
          storeName,
          "readonly"
        )
        .objectStore(
          storeName
        )
        .getAll();


      request.onsuccess =
        () => {

          resolve(
            request.result ||
            []
          );

        };


      request.onerror =
        () => {

          reject(
            request.error ||
            new Error(
              "IndexedDB 讀取全部資料失敗"
            )
          );

        };

    }
  );

}


/* =========================================================
   DB DELETE
========================================================= */

export function dbDelete(
  storeName,
  key
) {

  requireDB();


  return new Promise(
    (
      resolve,
      reject
    ) => {

      const transaction =
        db.transaction(
          storeName,
          "readwrite"
        );


      transaction
        .objectStore(
          storeName
        )
        .delete(
          key
        );


      transaction.oncomplete =
        () => {

          resolve();

        };


      transaction.onerror =
        () => {

          reject(
            transaction.error ||
            new Error(
              "IndexedDB 刪除失敗"
            )
          );

        };


      transaction.onabort =
        () => {

          reject(
            transaction.error ||
            new Error(
              "IndexedDB 刪除中止"
            )
          );

        };

    }
  );

}


/* =========================================================
   META
========================================================= */

export async function setMeta(
  key,
  value
) {

  await dbPut(
    STORE_META,
    {
      key,
      value
    }
  );

}


export async function getMeta(
  key,
  fallback = null
) {

  const result =
    await dbGet(
      STORE_META,
      key
    );


  return result
    ? result.value
    : fallback;

}


/* =========================================================
   ENTITY → STORE
========================================================= */

export function entityStoreName(
  entity
) {

  const map = {

    trips:
      STORE_TRIPS,

    footprints:
      STORE_FOOTPRINTS,

    food_records:
      STORE_FOOD,

    expenses:
      STORE_EXPENSES

  };


  return map[
    entity
  ] ||
  null;

}


/* =========================================================
   NORMALIZE LOCAL RECORD
========================================================= */

export function normalizeLocalRecord(
  record,
  existing = null,
  options = {}
) {

  return {

    ...existing,

    ...record,

    client_uid:
      record.client_uid ||
      existing?.client_uid ||
      createUID(),

    cloud_id:
      record.cloud_id ??
      existing?.cloud_id ??
      null,

    updated_at:
      options.keepUpdatedAt
        ? (
            record.updated_at ||
            existing?.updated_at ||
            nowISO()
          )
        : nowISO(),

    deleted_at:
      record.deleted_at ??
      existing?.deleted_at ??
      null,

    sync_status:
      options.syncStatus ||
      record.sync_status ||
      existing?.sync_status ||
      "pending"

  };

}


/* =========================================================
   UID
========================================================= */

export function createUID() {

  if (
    window.crypto &&
    crypto.randomUUID
  ) {

    return crypto.randomUUID();

  }


  return (
    Date.now()
      .toString(
        36
      ) +
    "-" +
    Math.random()
      .toString(
        36
      )
      .slice(
        2
      )
  );

}


/* =========================================================
   QUEUE SYNC
========================================================= */

export async function queueSync(
  entity,
  clientUid,
  action = "upsert"
) {

  const id =
    `${entity}:${clientUid}`;


  const old =
    await dbGet(
      STORE_SYNC_QUEUE,
      id
    );


  const queueItem = {

    id,

    entity,

    client_uid:
      clientUid,

    action,

    created_at:
      old?.created_at ||
      nowISO(),

    updated_at:
      nowISO(),

    retry_count:
      old?.retry_count ||
      0,

    last_error:
      null

  };


  await dbPut(
    STORE_SYNC_QUEUE,
    queueItem
  );


  const storeName =
    entityStoreName(
      entity
    );


  if (
    !storeName
  ) {

    return queueItem;

  }


  const record =
    await dbGet(
      storeName,
      clientUid
    );


  if (
    record
  ) {

    record.sync_status =
      "pending";


    await dbPut(
      storeName,
      record
    );

  }


  return queueItem;

}


/* =========================================================
   REMOVE QUEUE ITEM
========================================================= */

export async function removeQueueItem(
  entity,
  clientUid
) {

  await dbDelete(
    STORE_SYNC_QUEUE,
    `${entity}:${clientUid}`
  );

}


/* =========================================================
   SAVE LOCAL RECORD
========================================================= */

export async function saveLocalRecord(
  entity,
  record,
  options = {}
) {

  const storeName =
    entityStoreName(
      entity
    );


  if (
    !storeName
  ) {

    throw new Error(
      "未知資料類型：" +
      entity
    );

  }


  const existing =
    record.client_uid
      ? await dbGet(
          storeName,
          record.client_uid
        )
      : null;


  const normalized =
    normalizeLocalRecord(
      record,
      existing,
      {

        keepUpdatedAt:
          options.keepUpdatedAt ===
          true,

        syncStatus:
          options.syncStatus ||
          "pending"

      }
    );


  await dbPut(
    storeName,
    normalized
  );


  if (
    options.queue !==
    false
  ) {

    await queueSync(

      entity,

      normalized.client_uid,

      normalized.deleted_at
        ? "delete"
        : "upsert"

    );

  }


  return normalized;

}


/* =========================================================
   SOFT DELETE LOCAL RECORD
========================================================= */

export async function softDeleteLocalRecord(
  entity,
  clientUid
) {

  const storeName =
    entityStoreName(
      entity
    );


  if (
    !storeName
  ) {

    throw new Error(
      "未知資料類型：" +
      entity
    );

  }


  const record =
    await dbGet(
      storeName,
      clientUid
    );


  if (
    !record
  ) {

    return null;

  }


  const timestamp =
    nowISO();


  record.deleted_at =
    timestamp;


  record.updated_at =
    timestamp;


  record.sync_status =
    "pending";


  await dbPut(
    storeName,
    record
  );


  await queueSync(
    entity,
    clientUid,
    "delete"
  );


  return record;

}


/* =========================================================
   FIND LOCAL BY CLOUD ID
========================================================= */

export async function findLocalByCloudId(
  storeName,
  cloudId
) {

  if (
    cloudId === null ||
    cloudId === undefined
  ) {

    return null;

  }


  const records =
    await dbGetAll(
      storeName
    );


  return (
    records.find(
      record =>
        Number(
          record.cloud_id
        ) ===
        Number(
          cloudId
        )
    ) ||
    null
  );

}


/* =========================================================
   FIND CLIENT UID BY CLOUD ID
========================================================= */

export async function findClientUidByCloudId(
  storeName,
  cloudId
) {

  const record =
    await findLocalByCloudId(
      storeName,
      cloudId
    );


  return (
    record?.client_uid ||
    null
  );

}


/* =========================================================
   GET ALL ACTIVE ENTITY RECORDS
========================================================= */

export async function getActiveRecords(
  entity
) {

  const storeName =
    entityStoreName(
      entity
    );


  if (
    !storeName
  ) {

    return [];

  }


  const rows =
    await dbGetAll(
      storeName
    );


  return rows.filter(
    record =>
      !record.deleted_at
  );

}


/* =========================================================
   GET SYNC QUEUE
========================================================= */

export async function getSyncQueue() {

  return await dbGetAll(
    STORE_SYNC_QUEUE
  );

}


/* =========================================================
   GET SYNC COUNTS
========================================================= */

export async function getSyncCounts() {

  const records = [

    ...await dbGetAll(
      STORE_TRIPS
    ),

    ...await dbGetAll(
      STORE_FOOTPRINTS
    ),

    ...await dbGetAll(
      STORE_FOOD
    ),

    ...await dbGetAll(
      STORE_EXPENSES
    )

  ];


  const counts = {

    synced:
      0,

    pending:
      0,

    syncing:
      0,

    error:
      0

  };


  records.forEach(
    record => {

      const status =
        record.sync_status ||
        "synced";


      if (
        Object.prototype
          .hasOwnProperty
          .call(
            counts,
            status
          )
      ) {

        counts[
          status
        ]++;

      }

    }
  );


  return counts;

}


/* =========================================================
   MARK RECORD SYNC STATUS
========================================================= */

export async function setRecordSyncStatus(
  entity,
  clientUid,
  status
) {

  const storeName =
    entityStoreName(
      entity
    );


  if (
    !storeName
  ) {

    return null;

  }


  const record =
    await dbGet(
      storeName,
      clientUid
    );


  if (
    !record
  ) {

    return null;

  }


  record.sync_status =
    status;


  await dbPut(
    storeName,
    record
  );


  return record;

}


/* =========================================================
   RECOVER INTERRUPTED SYNC
========================================================= */

export async function recoverInterruptedSync() {

  const entities = [

    [
      "trips",
      STORE_TRIPS
    ],

    [
      "footprints",
      STORE_FOOTPRINTS
    ],

    [
      "food_records",
      STORE_FOOD
    ],

    [
      "expenses",
      STORE_EXPENSES
    ]

  ];


  for (
    const [
      entity,
      storeName
    ] of
    entities
  ) {

    const records =
      await dbGetAll(
        storeName
      );


    for (
      const record of
      records
    ) {

      if (
        record.sync_status !==
        "syncing"
      ) {

        continue;

      }


      record.sync_status =
        "pending";


      await dbPut(
        storeName,
        record
      );


      await queueSync(

        entity,

        record.client_uid,

        record.deleted_at
          ? "delete"
          : "upsert"

      );

    }

  }

}


/* =========================================================
   RAW DB HANDLE
   只供必要 debug 使用
========================================================= */

export function getDatabaseHandle() {

  return db;

}
