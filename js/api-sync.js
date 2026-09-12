/* =========================================================
   Travel Toolkit V2.2.3 Modular
   File: js/api-sync.js
   Modified: 2026-09-12

   Changes:
   - 從 V2.1.2 抽離 D1 / Worker 同步核心
   - 保留 Local-first 架構
   - 保留 push → pull → retry push
   - 保留 canonical client_uid reconciliation
   - 保留 Last Write Wins
   - 保留 Auto Sync ON / OFF
   - 保留 Manual Force Sync
   - 不直接操作 DOM

   Debug Revision: D1
   - 加入 Sync Queue / Push Upsert / Push Delete debug log
   - 加入 Pull Merge / Keep Local / Accept Server debug log
   - 僅增加 Console 可觀測性，不修改同步行為

   V2.2.3:
   - photo_local 為 Local-only，不送 D1 / Worker
   - Push reconcile 同 UID時保留 photo_local
   - Canonical UID reconcile 時保留 photo_local
   - Pull merge 時保留 photo_local
========================================================= */

import {

  API_BASE,
  EXPECTED_API_VERSION,

  STORE_TRIPS,
  STORE_FOOTPRINTS,
  STORE_FOOD,
  STORE_EXPENSES,
  STORE_SYNC_QUEUE

} from "./config.js";


import {

  dbPut,
  dbGet,
  dbGetAll,
  dbDelete,

  setMeta,
  getMeta,

  entityStoreName,

  queueSync,
  removeQueueItem,

  saveLocalRecord,
  softDeleteLocalRecord,

  findLocalByCloudId,
  findClientUidByCloudId,

  getSyncCounts

} from "./db.js";


/* =========================================================
   RUNTIME STATE
========================================================= */

let syncRunning =
  false;


let autoSyncEnabled =
  true;


/* =========================================================
   SYNC DEBUG

   Debug Revision D1:
   - 只輸出 Console log
   - 不修改任何 sync / queue / merge 行為
========================================================= */

const SYNC_DEBUG =
  true;


function syncDebug(
  action,
  data = {}
) {

  if (
    !SYNC_DEBUG
  ) {

    return;

  }


  console.log(
    `%c[SYNC ${action}]`,
    "color:#2563eb;font-weight:bold",
    {
      time:
        new Date()
          .toISOString(),

      ...data
    }
  );

}


/* =========================================================
   UI / APP CALLBACK HOOKS

   api-sync.js 不直接操作 DOM。

   main.js 之後可以透過 setSyncHooks()
   接收狀態更新。
========================================================= */

let hooks = {

  onSyncState:
    () => {},

  onCloudState:
    () => {},

  onDataChanged:
    () => {},

  onToast:
    () => {},

  onMessage:
    () => {}

};


export function setSyncHooks(
  newHooks = {}
) {

  hooks = {

    ...hooks,

    ...newHooks

  };

}


/* =========================================================
   BASIC TIME
========================================================= */

function nowISO() {

  return new Date()
    .toISOString();

}


function parseSyncTime(
  value
) {

  if (
    !value
  ) {

    return NaN;

  }


  let text =
    String(
      value
    )
    .trim();


  /*
    SQLite timestamp：

    2026-09-12 16:30:00

    視為 UTC。
  */

  if (
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
      .test(
        text
      )
  ) {

    text =
      text.replace(
        " ",
        "T"
      ) +
      "Z";

  }


  return new Date(
    text
  )
  .getTime();

}


/* =========================================================
   API HELPER
========================================================= */

export async function api(
  path,
  options = {}
) {

  const response =
    await fetch(
      API_BASE + path,
      {

        ...options,

        headers: {

          "Content-Type":
            "application/json",

          ...(
            options.headers ||
            {}
          )

        }

      }
    );


  let data =
    {};


  try {

    data =
      await response.json();

  }
  catch {

    data =
      {};

  }


  if (
    !response.ok
  ) {

    const error =
      new Error(
        data.error ||
        `HTTP ${response.status}`
      );


    error.status =
      response.status;


    error.data =
      data;


    throw error;

  }


  return data;

}


/* =========================================================
   AUTO SYNC SETTING
========================================================= */

export function getAutoSyncEnabled() {

  return autoSyncEnabled;

}


export async function loadAutoSyncSetting() {

  autoSyncEnabled =
    await getMeta(
      "auto_sync_enabled",
      true
    );


  return autoSyncEnabled;

}


export async function setAutoSyncEnabled(
  enabled
) {

  autoSyncEnabled =
    Boolean(
      enabled
    );


  await setMeta(
    "auto_sync_enabled",
    autoSyncEnabled
  );


  /*
    從 OFF → ON 時，
    若有網路就補同步。
  */

  if (
    autoSyncEnabled &&
    navigator.onLine
  ) {

    setTimeout(
      () => {

        syncNow();

      },
      200
    );

  }


  return autoSyncEnabled;

}


/* =========================================================
   SERVER RECORD → LOCAL RECORD
========================================================= */

async function serverRecordToLocal(
  entity,
  serverRecord
) {

  const local = {

    ...serverRecord,

    cloud_id:
      serverRecord.id,

    client_uid:
      serverRecord.client_uid,

    sync_status:
      "synced"

  };


  delete local.id;


  /*
    trip_id
    →
    trip_client_uid
  */

  if (
    entity !==
    "trips"
  ) {

    local.trip_client_uid =
      await findClientUidByCloudId(
        STORE_TRIPS,
        serverRecord.trip_id
      );

  }


  /*
    previous_record_id
    →
    previous_client_uid
  */

  if (
    entity ===
    "footprints"
  ) {

    local.previous_client_uid =
      await findClientUidByCloudId(
        STORE_FOOTPRINTS,
        serverRecord.previous_record_id
      );

  }


  /*
    expense.source_id
    →
    food client_uid
  */

  if (
    entity ===
      "expenses" &&
    serverRecord.source_type ===
      "food"
  ) {

    local.source_client_uid =
      await findClientUidByCloudId(
        STORE_FOOD,
        serverRecord.source_id
      );

  }


  return local;

}


/* =========================================================
   CANONICAL UID RECONCILE

   用於舊 D1 row 已有 canonical client_uid，
   但 Local 暫時用了另一個 uid 的情況。
========================================================= */

async function reconcileCanonicalUid(
  entity,
  originalUid,
  serverRecord
) {

  const storeName =
    entityStoreName(
      entity
    );


  if (
    !storeName ||
    !serverRecord?.client_uid
  ) {

    return;

  }


  const canonicalUid =
    serverRecord.client_uid;


  /*
    Server UID 和 Local UID 相同。

    V2.2.3:
    不能直接用 Server record 覆蓋 Local，
    否則 Local-only 的 photo_local 會遺失。
  */

  if (
    canonicalUid ===
    originalUid
  ) {

    const existing =
      await dbGet(
        storeName,
        originalUid
      );


    const local =
      await serverRecordToLocal(
        entity,
        serverRecord
      );


    /*
      V2.2.3
      Food photo_local 僅存在 Local IndexedDB。
    */

    if (
      entity ===
        "food_records" &&
      existing?.photo_local
    ) {

      local.photo_local =
        existing.photo_local;

    }


    await dbPut(
      storeName,
      {

        ...existing,

        ...local,

        sync_status:
          "synced"

      }
    );


    await removeQueueItem(
      entity,
      originalUid
    );


    return;

  }


  /*
    Server 回傳不同 canonical UID。
  */

  const temporary =
    await dbGet(
      storeName,
      originalUid
    );


  const canonicalExisting =
    await dbGet(
      storeName,
      canonicalUid
    );


  const converted =
    await serverRecordToLocal(
      entity,
      serverRecord
    );


  /*
    V2.2.3
    Canonical UID 改變時，
    仍需保留 Local-only photo_local。
  */

  const preservedPhotoLocal =

    entity ===
      "food_records"

      ? (
          temporary?.photo_local ||
          canonicalExisting?.photo_local ||
          null
        )

      : undefined;


  const mergedRecord = {

    ...temporary,

    ...canonicalExisting,

    ...converted,

    client_uid:
      canonicalUid,

    cloud_id:
      serverRecord.id,

    sync_status:
      "synced"

  };


  if (
    entity ===
    "food_records"
  ) {

    mergedRecord.photo_local =
      preservedPhotoLocal;

  }


  await dbPut(
    storeName,
    mergedRecord
  );
     /*
    刪除 temporary local row。
  */

  await dbDelete(
    storeName,
    originalUid
  );


  await removeQueueItem(
    entity,
    originalUid
  );


  await removeQueueItem(
    entity,
    canonicalUid
  );


  /* =====================================================
     修正 Trip 關聯
  ===================================================== */

  if (
    entity ===
    "trips"
  ) {

    const relationStores = [

      STORE_FOOTPRINTS,
      STORE_FOOD,
      STORE_EXPENSES

    ];


    for (
      const relationStore of
      relationStores
    ) {

      const records =
        await dbGetAll(
          relationStore
        );


      for (
        const record of
        records
      ) {

        if (
          record.trip_client_uid !==
          originalUid
        ) {

          continue;

        }


        record.trip_client_uid =
          canonicalUid;


        await dbPut(
          relationStore,
          record
        );

      }

    }

  }


  /* =====================================================
     修正 Footprint previous relation
  ===================================================== */

  if (
    entity ===
    "footprints"
  ) {

    const records =
      await dbGetAll(
        STORE_FOOTPRINTS
      );


    for (
      const record of
      records
    ) {

      if (
        record.previous_client_uid !==
        originalUid
      ) {

        continue;

      }


      record.previous_client_uid =
        canonicalUid;


      await dbPut(
        STORE_FOOTPRINTS,
        record
      );

    }

  }


  /* =====================================================
     修正 Food → Expense relation
  ===================================================== */

  if (
    entity ===
    "food_records"
  ) {

    const records =
      await dbGetAll(
        STORE_EXPENSES
      );


    for (
      const record of
      records
    ) {

      if (
        record.source_type !==
          "food" ||
        record.source_client_uid !==
          originalUid
      ) {

        continue;

      }


      record.source_client_uid =
        canonicalUid;


      await dbPut(
        STORE_EXPENSES,
        record
      );

    }

  }

}


/* =========================================================
   MERGE SERVER RECORD
========================================================= */

async function mergeServerRecord(
  entity,
  serverRecord
) {

  if (
    !serverRecord?.client_uid
  ) {

    return;

  }


  const storeName =
    entityStoreName(
      entity
    );


  if (
    !storeName
  ) {

    return;

  }


  const existing =
    await dbGet(
      storeName,
      serverRecord.client_uid
    );


  syncDebug(
    "PULL MERGE",
    {
      entity,

      client_uid:
        serverRecord.client_uid,

      cloud_id:
        serverRecord.id ??
        serverRecord.cloud_id ??
        null,

      server_updated_at:
        serverRecord.updated_at ??
        null,

      server_deleted_at:
        serverRecord.deleted_at ??
        null,

      local_updated_at:
        existing?.updated_at ??
        null,

      local_deleted_at:
        existing?.deleted_at ??
        null,

      local_sync_status:
        existing?.sync_status ??
        null,

      place_name:
        serverRecord.place_name ??
        null,

      shop_name:
        serverRecord.shop_name ??
        null,

      title:
        serverRecord.title ??
        null,

      name:
        serverRecord.name ??
        null
    }
  );


  const serverTime =
    parseSyncTime(
      serverRecord.updated_at
    );


  const localTime =
    parseSyncTime(
      existing?.updated_at
    );


  /*
    Local 還有未同步修改，而且比 Server 新：
    不讓 Server 蓋掉 Local。
  */

  if (
    existing &&
    [
      "pending",
      "syncing",
      "error"
    ]
    .includes(
      existing.sync_status
    ) &&
    !Number.isNaN(
      localTime
    ) &&
    !Number.isNaN(
      serverTime
    ) &&
    localTime >
    serverTime
  ) {

    syncDebug(
      "PULL KEEP LOCAL",
      {
        entity,

        client_uid:
          existing.client_uid,

        cloud_id:
          existing.cloud_id ??
          serverRecord.id ??
          null,

        local_updated_at:
          existing.updated_at ??
          null,

        server_updated_at:
          serverRecord.updated_at ??
          null,

        local_deleted_at:
          existing.deleted_at ??
          null,

        server_deleted_at:
          serverRecord.deleted_at ??
          null,

        local_sync_status:
          existing.sync_status ??
          null
      }
    );


    return;

  }


  const local =
    await serverRecordToLocal(
      entity,
      serverRecord
    );


  /*
    V2.2.3
    D1 / Worker 不保存 photo_local，
    Pull Server → Local 時保留本機照片。
  */

  if (
    entity ===
      "food_records" &&
    existing?.photo_local
  ) {

    local.photo_local =
      existing.photo_local;

  }


  syncDebug(
    "PULL ACCEPT SERVER",
    {
      entity,

      client_uid:
        serverRecord.client_uid,

      cloud_id:
        serverRecord.id ??
        serverRecord.cloud_id ??
        null,

      updated_at:
        serverRecord.updated_at ??
        null,

      deleted_at:
        serverRecord.deleted_at ??
        null,

      place_name:
        serverRecord.place_name ??
        null,

      shop_name:
        serverRecord.shop_name ??
        null,

      title:
        serverRecord.title ??
        null,

      name:
        serverRecord.name ??
        null
    }
  );


  await dbPut(
    storeName,
    {

      ...existing,

      ...local,

      sync_status:
        "synced"

    }
  );


  await removeQueueItem(
    entity,
    serverRecord.client_uid
  );

}


/* =========================================================
   PREPARE SYNC PAYLOAD
========================================================= */

function prepareSyncData(
  entity,
  record
) {

  const data = {

    ...record

  };


  /*
    Local-only fields
  */

  delete data.sync_status;
  delete data.cloud_id;


  /*
    V2.2.3
    Local-only food photo.
    不送到 D1 / Worker。
  */

  delete data.photo_local;


  /*
    Relationship 一律送 client_uid。
  */

  if (
    entity !==
    "trips"
  ) {

    data.trip_client_uid =
      record.trip_client_uid ||
      null;


    delete data.trip_id;

  }


  if (
    entity ===
    "footprints"
  ) {

    data.previous_client_uid =
      record.previous_client_uid ||
      null;


    delete data.previous_record_id;

  }


  if (
    entity ===
    "expenses"
  ) {

    data.source_client_uid =
      record.source_client_uid ||
      null;


    if (
      record.source_client_uid
    ) {

      delete data.source_id;

    }

  }


  return data;

}


/* =========================================================
   UPSERT ONE QUEUE ITEM
========================================================= */

async function syncUpsertItem(
  queueItem
) {

  const storeName =
    entityStoreName(
      queueItem.entity
    );


  if (
    !storeName
  ) {

    return;

  }


  const record =
    await dbGet(
      storeName,
      queueItem.client_uid
    );


  /*
    Local record 已不存在，
    queue 可直接移除。
  */

  if (
    !record
  ) {

    await removeQueueItem(
      queueItem.entity,
      queueItem.client_uid
    );


    return;

  }


  const originalUid =
    record.client_uid;


  record.sync_status =
    "syncing";


  await dbPut(
    storeName,
    record
  );


  hooks.onSyncState(
    {
      type:
        "record-syncing",

      entity:
        queueItem.entity,

      client_uid:
        queueItem.client_uid
    }
  );


  syncDebug(
    "PUSH UPSERT",
    {
      entity:
        queueItem.entity,

      client_uid:
        record.client_uid,

      cloud_id:
        record.cloud_id ??
        null,

      updated_at:
        record.updated_at ??
        null,

      deleted_at:
        record.deleted_at ??
        null,

      place_name:
        record.place_name ??
        null,

      shop_name:
        record.shop_name ??
        null,

      title:
        record.title ??
        null,

      name:
        record.name ??
        null,

      /*
        V2.2.3 debug:
        僅確認 Local 是否有照片，
        不輸出 Base64。
      */
      has_photo_local:
        Boolean(
          record.photo_local
        )
    }
  );


  const result =
    await api(
      "/api/sync/upsert",
      {

        method:
          "POST",

        body:
          JSON.stringify(
            {

              entity:
                queueItem.entity,

              client_uid:
                record.client_uid,

              cloud_id:
                record.cloud_id,

              updated_at:
                record.updated_at,

              data:
                prepareSyncData(
                  queueItem.entity,
                  record
                )

            }
          )

      }
    );


  syncDebug(
    "PUSH UPSERT RESULT",
    {
      entity:
        queueItem.entity,

      client_uid:
        record.client_uid,

      cloud_id:
        result.cloud_id ??
        result.record?.id ??
        null,

      result
    }
  );


  /*
    Worker V2.1.1 正常會回傳 record。
  */

  if (
    result.record
  ) {

    await reconcileCanonicalUid(

      queueItem.entity,

      originalUid,

      result.record

    );


    return;

  }


  /*
    Compatibility fallback。
  */

  record.cloud_id =
    result.cloud_id ??
    record.cloud_id;


  record.sync_status =
    "synced";


  await dbPut(
    storeName,
    record
  );


  await removeQueueItem(
    queueItem.entity,
    originalUid
  );

}


/* =========================================================
   DELETE ONE QUEUE ITEM
========================================================= */

async function syncDeleteItem(
  queueItem
) {

  const storeName =
    entityStoreName(
      queueItem.entity
    );


  if (
    !storeName
  ) {

    return;

  }


  const record =
    await dbGet(
      storeName,
      queueItem.client_uid
    );


  if (
    !record
  ) {

    await removeQueueItem(
      queueItem.entity,
      queueItem.client_uid
    );


    return;

  }


  record.sync_status =
    "syncing";


  await dbPut(
    storeName,
    record
  );


  hooks.onSyncState(
    {
      type:
        "record-syncing",

      entity:
        queueItem.entity,

      client_uid:
        queueItem.client_uid
    }
  );


  syncDebug(
    "PUSH DELETE",
    {
      entity:
        queueItem.entity,

      client_uid:
        record.client_uid,

      cloud_id:
        record.cloud_id ??
        null,

      updated_at:
        record.updated_at ??
        null,

      deleted_at:
        record.deleted_at ??
        null,

      place_name:
        record.place_name ??
        null,

      shop_name:
        record.shop_name ??
        null,

      title:
        record.title ??
        null,

      name:
        record.name ??
        null
    }
  );
     const result =
    await api(
      "/api/sync/delete",
      {

        method:
          "POST",

        body:
          JSON.stringify(
            {

              entity:
                queueItem.entity,

              client_uid:
                record.client_uid,

              updated_at:
                record.updated_at,

              deleted_at:
                record.deleted_at

            }
          )

      }
    );


  syncDebug(
    "PUSH DELETE RESULT",
    {
      entity:
        queueItem.entity,

      client_uid:
        record.client_uid,

      cloud_id:
        result.cloud_id ??
        result.record?.id ??
        null,

      result
    }
  );


  /*
    Server 版本較新。
  */

  if (
    result.result ===
      "server_wins" &&
    result.record
  ) {

    await mergeServerRecord(
      queueItem.entity,
      result.record
    );


    return;

  }


  record.cloud_id =
    result.cloud_id ??
    record.cloud_id;


  record.sync_status =
    "synced";


  await dbPut(
    storeName,
    record
  );


  await removeQueueItem(
    queueItem.entity,
    queueItem.client_uid
  );

}


/* =========================================================
   MARK QUEUE ERROR
========================================================= */

async function markQueueError(
  queueItem,
  error
) {

  const storeName =
    entityStoreName(
      queueItem.entity
    );


  if (
    storeName
  ) {

    const record =
      await dbGet(
        storeName,
        queueItem.client_uid
      );


    if (
      record
    ) {

      record.sync_status =
        "error";


      await dbPut(
        storeName,
        record
      );

    }

  }


  queueItem.retry_count =
    Number(
      queueItem.retry_count ||
      0
    ) +
    1;


  queueItem.last_error =
    error?.message ||
    String(
      error
    );


  queueItem.updated_at =
    nowISO();


  await dbPut(
    STORE_SYNC_QUEUE,
    queueItem
  );

}


/* =========================================================
   PUSH LOCAL → D1
========================================================= */

export async function pushPendingChanges() {

  const queue =
    await dbGetAll(
      STORE_SYNC_QUEUE
    );


  syncDebug(
    "QUEUE",
    {
      count:
        queue.length,

      items:
        queue.map(
          item => ({
            entity:
              item.entity,

            client_uid:
              item.client_uid,

            action:
              item.action,

            retry_count:
              item.retry_count ??
              0,

            last_error:
              item.last_error ??
              null,

            created_at:
              item.created_at ??
              null,

            updated_at:
              item.updated_at ??
              null
          })
        )
    }
  );


  if (
    !queue.length
  ) {

    return;

  }


  /*
    Parent dependency 先同步。
  */

  const priority = {

    trips:
      1,

    footprints:
      2,

    food_records:
      2,

    expenses:
      3

  };


  queue.sort(
    (
      a,
      b
    ) => {

      const aPriority =
        priority[
          a.entity
        ] ||
        9;


      const bPriority =
        priority[
          b.entity
        ] ||
        9;


      if (
        aPriority !==
        bPriority
      ) {

        return (
          aPriority -
          bPriority
        );

      }


      return String(
        a.created_at
      )
      .localeCompare(
        String(
          b.created_at
        )
      );

    }
  );


  for (
    const item of
    queue
  ) {

    try {

      if (
        item.action ===
        "delete"
      ) {

        await syncDeleteItem(
          item
        );

      }
      else {

        await syncUpsertItem(
          item
        );

      }

    }
    catch (
      error
    ) {

      console.error(
        "Push sync error:",
        item,
        error
      );


      syncDebug(
        "PUSH ERROR",
        {
          entity:
            item.entity,

          client_uid:
            item.client_uid,

          action:
            item.action,

          error:
            error?.message ??
            String(
              error
            )
        }
      );


      await markQueueError(
        item,
        error
      );

    }

  }

}


/* =========================================================
   PULL D1 → LOCAL
========================================================= */

export async function pullCloudChanges() {

  const since =
    await getMeta(
      "last_sync_server_time",
      "1970-01-01T00:00:00.000Z"
    );


  const result =
    await api(

      "/api/sync/changes?since=" +

      encodeURIComponent(
        since
      )

    );


  syncDebug(
    "PULL CHANGES",
    {
      since,

      server_time:
        result.server_time ??
        null,

      trips:
        (
          result.trips ||
          []
        ).length,

      footprints:
        (
          result.footprints ||
          []
        ).length,

      food_records:
        (
          result.food_records ||
          []
        ).length,

      expenses:
        (
          result.expenses ||
          []
        ).length
    }
  );


  /* =====================================================
     First Pass
  ===================================================== */

  for (
    const record of
    result.trips ||
    []
  ) {

    await mergeServerRecord(
      "trips",
      record
    );

  }


  for (
    const record of
    result.footprints ||
    []
  ) {

    await mergeServerRecord(
      "footprints",
      record
    );

  }


  for (
    const record of
    result.food_records ||
    []
  ) {

    await mergeServerRecord(
      "food_records",
      record
    );

  }


  for (
    const record of
    result.expenses ||
    []
  ) {

    await mergeServerRecord(
      "expenses",
      record
    );

  }


  /* =====================================================
     Second Pass:
     Footprint previous relation
  ===================================================== */

  for (
    const record of
    result.footprints ||
    []
  ) {

    const local =
      await dbGet(
        STORE_FOOTPRINTS,
        record.client_uid
      );


    if (
      !local
    ) {

      continue;

    }


    local.previous_client_uid =
      await findClientUidByCloudId(
        STORE_FOOTPRINTS,
        record.previous_record_id
      );


    await dbPut(
      STORE_FOOTPRINTS,
      local
    );

  }


  /* =====================================================
     Second Pass:
     Expense → Food
  ===================================================== */

  for (
    const record of
    result.expenses ||
    []
  ) {

    if (
      record.source_type !==
      "food"
    ) {

      continue;

    }


    const local =
      await dbGet(
        STORE_EXPENSES,
        record.client_uid
      );


    if (
      !local
    ) {

      continue;

    }


    local.source_client_uid =
      await findClientUidByCloudId(
        STORE_FOOD,
        record.source_id
      );


    await dbPut(
      STORE_EXPENSES,
      local
    );

  }


  /*
    Cursor 使用 Worker 回傳 server_time。
  */

  if (
    result.server_time
  ) {

    await setMeta(
      "last_sync_server_time",
      result.server_time
    );

  }


  await setMeta(
    "last_sync_success",
    nowISO()
  );


  return result;

}


/* =========================================================
   CLOUD CONNECTION TEST
========================================================= */

export async function testCloudConnection() {

  if (
    !navigator.onLine
  ) {

    const result = {

      ok:
        false,

      state:
        "offline",

      version:
        null

    };


    hooks.onCloudState(
      result
    );


    return result;

  }


  try {

    const data =
      await api(
        "/"
      );


    const result = {

      ok:
        true,

      state:

        data.version ===
        EXPECTED_API_VERSION

          ? "ok"

          : "version-mismatch",

      version:
        data.version ||
        null,

      data

    };


    hooks.onCloudState(
      result
    );


    return result;

  }
  catch (
    error
  ) {

    const result = {

      ok:
        false,

      state:
        "error",

      version:
        null,

      error

    };


    hooks.onCloudState(
      result
    );


    return result;

  }

}


/* =========================================================
   SYNC STATUS SNAPSHOT
========================================================= */

export async function getSyncStatusSnapshot() {

  const counts =
    await getSyncCounts();


  const lastSync =
    await getMeta(
      "last_sync_success",
      null
    );


  return {

    running:
      syncRunning,

    auto_sync_enabled:
      autoSyncEnabled,

    counts,

    last_sync_success:
      lastSync

  };

}
/* =========================================================
   FULL SYNC
========================================================= */

export async function syncNow(
  options = {}
) {

  const force =
    options.force ===
    true;


  /*
    已經有同步工作。
  */

  if (
    syncRunning
  ) {

    return {
      ok:
        false,

      skipped:
        "already-running"
    };

  }


  /*
    Auto Sync OFF。
    除非 force = true。
  */

  if (
    !force &&
    !autoSyncEnabled
  ) {

    return {
      ok:
        false,

      skipped:
        "auto-sync-disabled"
    };

  }


  /*
    沒網路。
  */

  if (
    !navigator.onLine
  ) {

    return {
      ok:
        false,

      skipped:
        "offline"
    };

  }


  syncRunning =
    true;


  hooks.onSyncState(
    {
      type:
        "sync-start",

      manual:
        options.manual ===
        true
    }
  );


  syncDebug(
    "SYNC START",
    {
      manual:
        options.manual ===
        true,

      force
    }
  );


  try {

    /*
      1.
      Local pending → D1
    */

    await pushPendingChanges();


    /*
      2.
      D1 → Local
    */

    await pullCloudChanges();


    /*
      3.
      dependency 補齊後再 push 一次
    */

    await pushPendingChanges();


    hooks.onDataChanged();


    const snapshot =
      await getSyncStatusSnapshot();


    syncDebug(
      "SYNC SUCCESS",
      {
        manual:
          options.manual ===
          true,

        snapshot
      }
    );


    hooks.onSyncState(
      {
        type:
          "sync-success",

        manual:
          options.manual ===
          true,

        snapshot
      }
    );


    if (
      options.manual
    ) {

      hooks.onToast(
        "☁️ D1 同步完成"
      );

    }


    return {
      ok:
        true,

      snapshot
    };

  }
  catch (
    error
  ) {

    console.error(
      "Full sync error:",
      error
    );


    const snapshot =
      await getSyncStatusSnapshot();


    syncDebug(
      "SYNC ERROR",
      {
        error:
          error?.message ??
          String(
            error
          ),

        snapshot
      }
    );


    hooks.onSyncState(
      {
        type:
          "sync-error",

        error,

        snapshot
      }
    );


    if (
      options.manual
    ) {

      hooks.onMessage(
        "同步失敗，但 Local 資料仍已保留：" +
        error.message,

        "error"
      );

    }


    return {
      ok:
        false,

      error,

      snapshot
    };

  }
  finally {

    syncRunning =
      false;


    syncDebug(
      "SYNC END",
      {
        running:
          syncRunning
      }
    );

  }

}


/* =========================================================
   SAVE LOCAL + OPTIONAL AUTO SYNC
========================================================= */

export async function saveAndSync(
  entity,
  record
) {

  const saved =
    await saveLocalRecord(
      entity,
      record
    );


  /*
    通知畫面刷新 Local。
  */

  hooks.onDataChanged();


  /*
    Auto Sync ON 才背景送 D1。
  */

  if (
    navigator.onLine &&
    autoSyncEnabled
  ) {

    setTimeout(
      () => {

        syncNow();

      },
      0
    );

  }


  return saved;

}


/* =========================================================
   DELETE LOCAL + OPTIONAL AUTO SYNC
========================================================= */

export async function deleteAndSync(
  entity,
  clientUid
) {

  syncDebug(
    "DELETE REQUEST",
    {
      entity,

      client_uid:
        clientUid
    }
  );


  const deleted =
    await softDeleteLocalRecord(
      entity,
      clientUid
    );


  syncDebug(
    "DELETE LOCAL TOMBSTONE",
    {
      entity,

      client_uid:
        clientUid,

      deleted_at:
        deleted?.deleted_at ??
        null,

      updated_at:
        deleted?.updated_at ??
        null,

      sync_status:
        deleted?.sync_status ??
        null,

      cloud_id:
        deleted?.cloud_id ??
        null
    }
  );


  hooks.onDataChanged();


  if (
    navigator.onLine &&
    autoSyncEnabled
  ) {

    setTimeout(
      () => {

        syncNow();

      },
      0
    );

  }


  return deleted;

}


/* =========================================================
   RETRY ALL ERROR QUEUE ITEMS

   後面同步頁若要加「重試失敗」
   可直接使用。
========================================================= */

export async function retryAllErrors() {

  const queue =
    await dbGetAll(
      STORE_SYNC_QUEUE
    );


  syncDebug(
    "RETRY ERRORS",
    {
      total_queue:
        queue.length,

      error_items:
        queue
          .filter(
            item =>
              Boolean(
                item.last_error
              )
          )
          .map(
            item => ({
              entity:
                item.entity,

              client_uid:
                item.client_uid,

              action:
                item.action,

              retry_count:
                item.retry_count ??
                0,

              last_error:
                item.last_error ??
                null
            })
          )
    }
  );


  for (
    const item of
    queue
  ) {

    if (
      !item.last_error
    ) {

      continue;

    }


    item.last_error =
      null;


    item.updated_at =
      nowISO();


    await dbPut(
      STORE_SYNC_QUEUE,
      item
    );


    const storeName =
      entityStoreName(
        item.entity
      );


    if (
      !storeName
    ) {

      continue;

    }


    const record =
      await dbGet(
        storeName,
        item.client_uid
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

  }


  return await syncNow(
    {
      force:
        true,

      manual:
        true
    }
  );

}


/* =========================================================
   NETWORK HELPERS
========================================================= */

export function isOnline() {

  return navigator.onLine;

}


export function isSyncRunning() {

  return syncRunning;

}


/* =========================================================
   NETWORK EVENTS

   注意：
   api-sync.js 只處理 sync behavior，
   Header UI 由 main.js 更新。
========================================================= */

window.addEventListener(
  "online",
  async () => {

    hooks.onSyncState(
      {
        type:
          "network-online"
      }
    );


    syncDebug(
      "NETWORK ONLINE",
      {
        auto_sync_enabled:
          autoSyncEnabled
      }
    );


    const cloud =
      await testCloudConnection();


    if (
      cloud.ok &&
      autoSyncEnabled
    ) {

      setTimeout(
        () => {

          syncNow();

        },
        400
      );

    }

  }
);


window.addEventListener(
  "offline",
  () => {

    hooks.onSyncState(
      {
        type:
          "network-offline"
      }
    );


    syncDebug(
      "NETWORK OFFLINE",
      {}
    );


    hooks.onCloudState(
      {
        ok:
          false,

        state:
          "offline",

        version:
          null
      }
    );

  }
);
