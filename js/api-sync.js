/* =========================================================
   Travel Toolkit V2.3.0 Modular
   File: js/api-sync.js
   Modified: 2026-09-13

   【V2.3.0 Cloud Authorization】
   - 新增 Cloud Token LocalStorage 管理
   - 新增 Worker /api/auth/check 驗證
   - 所有受保護 Worker API 自動加入 X-Travel-Token
   - 未設定 Token 時維持 Local-only，不呼叫 D1
   - Token 未驗證時不執行背景 Auto Sync
   - Token 錯誤時切回 Local-only
   - 401 / AUTH_NOT_CONFIGURED 不污染 sync queue retry_count
   - Local CRUD / pending queue 完全保留
   - 保留原有 push → pull → retry push
   - 保留 Last Write Wins
   - 保留 canonical client_uid reconciliation
   - 保留 Auto Sync ON / OFF
   - 保留 Manual Force Sync

   【V2.2.3 Food Local Photo】
   - photo_local 僅保留於 IndexedDB
   - prepareSyncData 不送 photo_local 到 Worker / D1
   - Push reconcile 同 UID 保留 photo_local
   - Canonical UID reconcile 保留 photo_local
   - Pull merge 保留 photo_local
   - 保留 PHOTO debug log

   【V2.2.x】
   - 從 V2.1.2 抽離 D1 / Worker 同步核心
   - 不直接操作 DOM
========================================================= */

import {

  API_BASE,
  EXPECTED_API_VERSION,

  CLOUD_TOKEN_STORAGE_KEY,
  CLOUD_AUTH_HEADER,
  CLOUD_AUTH_CHECK_PATH,

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


/*
  Cloud Authorization Runtime State

  unknown
  → 有 Token，但本次開啟頁面尚未向 Worker 驗證

  authorized
  → /api/auth/check 已成功

  unauthorized
  → 沒有 Token，或 Token 驗證失敗
*/

let cloudAuthState =
  "unknown";


/* =========================================================
   SYNC DEBUG
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
   CLOUD TOKEN
========================================================= */

/*
  Token 只存在目前 Browser 的 localStorage。

  注意：
  真正 Token 絕對不能寫死在 GitHub 原始碼。
*/

export function getCloudToken() {

  try {

    return (
      localStorage.getItem(
        CLOUD_TOKEN_STORAGE_KEY
      ) ||
      ""
    )
    .trim();

  }
  catch (
    error
  ) {

    console.warn(
      "Unable to read cloud token:",
      error
    );


    return "";

  }

}


export function hasCloudToken() {

  return Boolean(
    getCloudToken()
  );

}


export function setCloudToken(
  token
) {

  const normalized =
    String(
      token ||
      ""
    )
    .trim();


  if (
    !normalized
  ) {

    clearCloudToken();

    return "";

  }


  try {

    localStorage.setItem(
      CLOUD_TOKEN_STORAGE_KEY,
      normalized
    );

  }
  catch (
    error
  ) {

    console.error(
      "Unable to save cloud token:",
      error
    );


    throw error;

  }


  /*
    Token 剛被新增／替換，
    必須重新驗證。
  */

  cloudAuthState =
    "unknown";


  hooks.onCloudState(
    {
      ok:
        false,

      state:
        "auth-pending",

      authorized:
        false,

      version:
        null
    }
  );


  return normalized;

}


export function clearCloudToken() {

  try {

    localStorage.removeItem(
      CLOUD_TOKEN_STORAGE_KEY
    );

  }
  catch (
    error
  ) {

    console.warn(
      "Unable to clear cloud token:",
      error
    );

  }


  cloudAuthState =
    "unauthorized";


  hooks.onCloudState(
    {
      ok:
        false,

      state:
        "local-only",

      authorized:
        false,

      version:
        null
    }
  );

}


export function getCloudAuthState() {

  return cloudAuthState;

}


export function isCloudAuthorized() {

  return (
    cloudAuthState ===
      "authorized" &&
    hasCloudToken()
  );

}


/* =========================================================
   AUTH ERROR
========================================================= */

function createCloudAuthError(
  message,
  code = "CLOUD_UNAUTHORIZED",
  status = 401
) {

  const error =
    new Error(
      message
    );


  error.code =
    code;


  error.status =
    status;


  error.cloudAuthError =
    true;


  return error;

}


function isCloudAuthError(
  error
) {

  return Boolean(

    error?.cloudAuthError ||

    error?.status ===
      401 ||

    error?.data?.code ===
      "UNAUTHORIZED" ||

    error?.data?.code ===
      "AUTH_NOT_CONFIGURED"

  );

}


/* =========================================================
   API HELPER
========================================================= */

/*
  V2.3.0

  /api/*：
  - 必須有 Cloud Token
  - 自動加入 X-Travel-Token

  非 /api/*：
  - 視為 public endpoint
  - 不強制 Token

  目前正式同步都走 /api/*。
*/

export async function api(
  path,
  options = {}
) {

  const protectedApi =
    String(
      path ||
      ""
    )
    .startsWith(
      "/api/"
    );


  const headers = {

    "Content-Type":
      "application/json",

    ...(
      options.headers ||
      {}
    )

  };


  if (
    protectedApi
  ) {

    const token =
      getCloudToken();


    /*
      沒 Token：
      直接在 Browser 擋掉。

      不送任何 request 到 Worker。
    */

    if (
      !token
    ) {

      cloudAuthState =
        "unauthorized";


      throw createCloudAuthError(
        "尚未授權雲端功能，目前資料只保存在此裝置",
        "NO_CLOUD_TOKEN",
        401
      );

    }


    headers[
      CLOUD_AUTH_HEADER
    ] =
      token;

  }


  const response =
    await fetch(
      API_BASE + path,
      {

        ...options,

        headers

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


    /*
      Worker 明確表示授權失敗。

      不刪掉 Token，
      讓使用者可以在 UI 看出 Token 有問題，
      並選擇重新輸入。

      但 Runtime 立即降回 Local-only。
    */

    if (
      response.status ===
        401 ||
      data.code ===
        "UNAUTHORIZED"
    ) {

      cloudAuthState =
        "unauthorized";


      error.cloudAuthError =
        true;


      hooks.onCloudState(
        {
          ok:
            false,

          state:
            "unauthorized",

          authorized:
            false,

          version:
            null,

          error
        }
      );

    }


    /*
      Worker 有跑，但 Secret 尚未設定。
    */

    if (
      data.code ===
        "AUTH_NOT_CONFIGURED"
    ) {

      cloudAuthState =
        "unauthorized";


      error.cloudAuthError =
        true;


      hooks.onCloudState(
        {
          ok:
            false,

          state:
            "auth-not-configured",

          authorized:
            false,

          version:
            data.version ||
            null,

          error
        }
      );

    }


    throw error;

  }


  return data;

}


/* =========================================================
   CLOUD AUTHORIZATION CHECK
========================================================= */

export async function verifyCloudAuthorization() {

  /*
    沒有 Token：

    這是正常 Local-only 模式，
    不呼叫 Worker。
  */

  if (
    !hasCloudToken()
  ) {

    cloudAuthState =
      "unauthorized";


    const result = {

      ok:
        false,

      authorized:
        false,

      state:
        "local-only",

      version:
        null

    };


    hooks.onCloudState(
      result
    );


    return result;

  }


  if (
    !navigator.onLine
  ) {

    const result = {

      ok:
        false,

      authorized:
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
        CLOUD_AUTH_CHECK_PATH
      );


    const version =
      data.version ||
      null;


    const versionMatched =
      version ===
      EXPECTED_API_VERSION;


    cloudAuthState =
      data.authorized ===
        true

        ? "authorized"

        : "unauthorized";


    const result = {

      ok:
        data.authorized ===
          true,

      authorized:
        data.authorized ===
          true,

      state:

        data.authorized !==
          true

          ? "unauthorized"

          : (
              versionMatched
                ? "authorized"
                : "version-mismatch"
            ),

      version,

      version_matched:
        versionMatched,

      data

    };


    hooks.onCloudState(
      result
    );


    syncDebug(
      "AUTH CHECK",
      result
    );


    return result;

  }
  catch (
    error
  ) {

    if (
      isCloudAuthError(
        error
      )
    ) {

      cloudAuthState =
        "unauthorized";


      const result = {

        ok:
          false,

        authorized:
          false,

        state:

          error?.data?.code ===
            "AUTH_NOT_CONFIGURED"

            ? "auth-not-configured"

            : "unauthorized",

        version:
          null,

        error

      };


      hooks.onCloudState(
        result
      );


      return result;

    }


    const result = {

      ok:
        false,

      authorized:
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
    V2.3.0

    Auto Sync 開啟時，
    只有已授權 Cloud 才允許背景同步。

    未授權仍維持 Local-first，
    不把它視為錯誤。
  */

  if (
    autoSyncEnabled &&
    navigator.onLine &&
    isCloudAuthorized()
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


    syncDebug(
      "PHOTO RECONCILE BEFORE",
      {
        entity,

        originalUid,

        canonicalUid,

        has_photo_local:
          Boolean(
            existing?.photo_local
          ),

        photo_local_length:
          existing?.photo_local?.length ||
          0
      }
    );


    const local =
      await serverRecordToLocal(
        entity,
        serverRecord
      );


    /*
      V2.2.3 / V2.3.0

      photo_local 是 Local-only 欄位。

      Worker / D1 不保存照片 Base64，
      所以 Server record 不可覆蓋本機照片。
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


    const photoCheckAfterReconcile =
      await dbGet(
        storeName,
        canonicalUid
      );


    syncDebug(
      "PHOTO RECONCILE AFTER",
      {
        entity,

        has_photo_local:
          Boolean(
            photoCheckAfterReconcile?.photo_local
          ),

        photo_local_length:
          photoCheckAfterReconcile?.photo_local?.length ||
          0
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
    V2.2.3 / V2.3.0

    canonical UID 改變時，
    優先保留原本 temporary record 的 photo_local。

    若 temporary 沒有，
    再保留已存在 canonical record 的 photo_local。
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
    "PHOTO PULL BEFORE",
    {
      entity,

      client_uid:
        serverRecord.client_uid,

      has_photo_local:
        Boolean(
          existing?.photo_local
        ),

      photo_local_length:
        existing?.photo_local?.length ||
        0
    }
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
    V2.2.3 / V2.3.0

    D1 / Worker 不保存 photo_local。

    Pull Server → Local 時
    必須保留本機照片。
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


  const photoCheckAfterPull =
    await dbGet(
      storeName,
      serverRecord.client_uid
    );


  syncDebug(
    "PHOTO PULL AFTER",
    {
      entity,

      client_uid:
        serverRecord.client_uid,

      has_photo_local:
        Boolean(
          photoCheckAfterPull?.photo_local
        ),

      photo_local_length:
        photoCheckAfterPull?.photo_local?.length ||
        0
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
    V2.2.3 / V2.3.0

    photo_local 僅存在 Local IndexedDB。
    不送到 Worker / D1。
  */

  delete data.photo_local;


  syncDebug(
    "PHOTO PAYLOAD CHECK",
    {
      entity,

      client_uid:
        record.client_uid,

      local_has_photo:
        Boolean(
          record.photo_local
        ),

      local_photo_length:
        record.photo_local?.length ||
        0,

      payload_has_photo_local:
        Boolean(
          data.photo_local
        )
    }
  );


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


  syncDebug(
    "PHOTO PUSH BEFORE STATUS",
    {
      entity:
        queueItem.entity,

      client_uid:
        record.client_uid,

      has_photo_local:
        Boolean(
          record.photo_local
        ),

      photo_local_length:
        record.photo_local?.length ||
        0
    }
  );


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

      has_photo_local:
        Boolean(
          record.photo_local
        ),

      photo_local_length:
        record.photo_local?.length ||
        0
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
    Worker 正常會回傳 record。
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


  /*
    V2.3.0 Cloud Authorization

    未授權不是資料同步錯誤。

    可能情況：
    - 沒有 Token
    - Token 錯誤
    - Worker TRAVEL_API_TOKEN 尚未設定

    因此：
    - 不增加 retry_count
    - 不寫 last_error
    - 不把 Local record 標成 error
    - queue 保留
    - record 回到 pending

    等使用者重新授權後即可再次同步。
  */

  if (
    isCloudAuthError(
      error
    )
  ) {

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
          "pending";


        await dbPut(
          storeName,
          record
        );

      }

    }


    syncDebug(
      "QUEUE AUTH HOLD",
      {
        entity:
          queueItem.entity,

        client_uid:
          queueItem.client_uid,

        action:
          queueItem.action,

        status:
          error?.status ??
          null,

        code:
          error?.code ??
          error?.data?.code ??
          null
      }
    );


    return;

  }


  /*
    真正的同步錯誤才進 error / retry_count。
  */

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

  /*
    V2.3.0

    未授權時不碰 Worker，
    queue 保留等待未來授權。
  */

  if (
    !isCloudAuthorized()
  ) {

    syncDebug(
      "PUSH SKIPPED UNAUTHORIZED",
      {}
    );


    return {
      ok:
        false,

      skipped:
        "unauthorized"
    };

  }


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

    return {
      ok:
        true,

      count:
        0
    };

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

    /*
      若同步過程中 Token 被判定失效，
      後續 queue item 直接停止。

      不再一直打 401。
    */

    if (
      !isCloudAuthorized()
    ) {

      syncDebug(
        "PUSH STOP UNAUTHORIZED",
        {
          remaining_entity:
            item.entity,

          remaining_client_uid:
            item.client_uid
        }
      );


      break;

    }


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


      /*
        授權失效：

        queue 已保留 pending，
        本輪同步立即停止。
      */

      if (
        isCloudAuthError(
          error
        )
      ) {

        break;

      }

    }

  }


  return {
    ok:
      isCloudAuthorized()
  };

}


/* =========================================================
   PULL D1 → LOCAL
========================================================= */

export async function pullCloudChanges() {

  /*
    V2.3.0

    未授權絕對不 Pull。
  */

  if (
    !isCloudAuthorized()
  ) {

    syncDebug(
      "PULL SKIPPED UNAUTHORIZED",
      {}
    );


    return {
      ok:
        false,

      skipped:
        "unauthorized"
    };

  }


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

/*
  V2.3.0

  testCloudConnection() 同時檢查：

  1. Browser 是否 online
  2. Worker public root 是否可連線
  3. Worker version
  4. 是否存在 Cloud Token
  5. Token 是否通過 /api/auth/check
*/

export async function testCloudConnection() {

  if (
    !navigator.onLine
  ) {

    const result = {

      ok:
        false,

      authorized:
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

    /*
      Root 是 public endpoint，
      不需要 Token。
    */

    const rootData =
      await api(
        "/"
      );


    const workerVersion =
      rootData.version ||
      null;


    /*
      Worker 版本不符時，
      先直接回報版本不一致。

      避免前端 V2.3.0 對舊 Worker
      進行授權 API 操作。
    */

    if (
      workerVersion !==
      EXPECTED_API_VERSION
    ) {

      const result = {

        ok:
          false,

        authorized:
          false,

        state:
          "version-mismatch",

        version:
          workerVersion,

        expected_version:
          EXPECTED_API_VERSION,

        data:
          rootData

      };


      hooks.onCloudState(
        result
      );


      return result;

    }


    /*
      沒有 Token：

      Worker 正常，
      但目前裝置是 Local-only。
    */

    if (
      !hasCloudToken()
    ) {

      cloudAuthState =
        "unauthorized";


      const result = {

        ok:
          true,

        authorized:
          false,

        state:
          "local-only",

        version:
          workerVersion,

        data:
          rootData

      };


      hooks.onCloudState(
        result
      );


      return result;

    }


    /*
      有 Token → 驗證。
    */

    const auth =
      await verifyCloudAuthorization();


    const result = {

      ...auth,

      worker_ok:
        true,

      version:
        auth.version ||
        workerVersion,

      root_data:
        rootData

    };


    hooks.onCloudState(
      result
    );


    return result;

  }
  catch (
    error
  ) {

    /*
      Root public endpoint 本身失敗，
      視為 Worker / Network error。
    */

    const result = {

      ok:
        false,

      authorized:
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

    cloud_authorized:
      isCloudAuthorized(),

    cloud_auth_state:
      getCloudAuthState(),

    has_cloud_token:
      hasCloudToken(),

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


  if (
    !navigator.onLine
  ) {

    if (
      options.manual
    ) {

      hooks.onMessage(
        "目前離線，資料已保存在此裝置，恢復網路後再同步。",
        "info"
      );

    }


    return {
      ok:
        false,

      skipped:
        "offline"
    };

  }


  /*
    V2.3.0 Cloud Authorization

    尚未授權時：
    - 不 Push
    - 不 Pull
    - 不修改 queue
    - 不把資料標成 error
  */

  if (
    !isCloudAuthorized()
  ) {

    /*
      完全沒有 Token：
      正常 Local-only。
    */

    if (
      !hasCloudToken()
    ) {

      cloudAuthState =
        "unauthorized";


      if (
        options.manual
      ) {

        hooks.onMessage(
          "尚未授權雲端功能，目前資料只保存在此裝置。",
          "info"
        );

      }


      hooks.onCloudState(
        {
          ok:
            false,

          authorized:
            false,

          state:
            "local-only",

          version:
            null
        }
      );


      return {
        ok:
          false,

        skipped:
          "unauthorized"
      };

    }


    /*
      有 Token，但 Runtime 尚未驗證。

      Manual Sync 或其他明確 sync request
      可先進行一次 Authorization Check。
    */

    const auth =
      await verifyCloudAuthorization();


    if (
      !auth.authorized
    ) {

      if (
        options.manual
      ) {

        let message =
          "雲端授權失敗，目前資料仍只保存在此裝置。";


        if (
          auth.state ===
          "auth-not-configured"
        ) {

          message =
            "Worker 尚未設定雲端授權 Secret，目前資料只保存在此裝置。";

        }
        else if (
          auth.state ===
          "offline"
        ) {

          message =
            "目前離線，資料已保存在此裝置。";

        }


        hooks.onMessage(
          message,
          "info"
        );

      }


      return {
        ok:
          false,

        skipped:
          auth.state ||
          "unauthorized",

        auth
      };

    }

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

      force,

      cloud_authorized:
        isCloudAuthorized()
    }
  );


  try {

    /*
      1.
      Local pending → D1
    */

    await pushPendingChanges();


    /*
      如果 Push 過程收到 401，
      api() 會立刻把 Runtime 切回 unauthorized。

      此時不能繼續 Pull。
    */

    if (
      !isCloudAuthorized()
    ) {

      throw createCloudAuthError(
        "雲端授權已失效，目前資料仍保存在此裝置。",
        "CLOUD_AUTH_LOST",
        401
      );

    }


    /*
      2.
      D1 → Local
    */

    await pullCloudChanges();


    if (
      !isCloudAuthorized()
    ) {

      throw createCloudAuthError(
        "雲端授權已失效，目前資料仍保存在此裝置。",
        "CLOUD_AUTH_LOST",
        401
      );

    }


    /*
      3.
      dependency 補齊後再 push 一次
    */

    await pushPendingChanges();


    if (
      !isCloudAuthorized()
    ) {

      throw createCloudAuthError(
        "雲端授權已失效，目前資料仍保存在此裝置。",
        "CLOUD_AUTH_LOST",
        401
      );

    }


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


    /*
      授權錯誤不是 Local 資料錯誤。
    */

    if (
      isCloudAuthError(
        error
      )
    ) {

      syncDebug(
        "SYNC AUTH HOLD",
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
            "sync-auth-required",

          error,

          snapshot
        }
      );


      if (
        options.manual
      ) {

        hooks.onMessage(
          "雲端授權失敗，目前資料仍安全保存在此裝置。",
          "info"
        );

      }


      return {
        ok:
          false,

        skipped:
          "unauthorized",

        error,

        snapshot
      };

    }


    /*
      真正 Sync / Network / D1 錯誤。
    */

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

  /*
    Local-first：

    無論是否授權，
    永遠先寫 IndexedDB。
  */

  const saved =
    await saveLocalRecord(
      entity,
      record
    );


  hooks.onDataChanged();


  /*
    V2.3.0

    Auto Sync 必須同時符合：

    - Online
    - Auto Sync ON
    - Cloud 已授權
  */

  if (
    navigator.onLine &&
    autoSyncEnabled &&
    isCloudAuthorized()
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


  /*
    Local-first soft delete。

    即使未授權，
    tombstone 仍保存在 Local，
    等未來授權後再同步到 D1。
  */

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
    autoSyncEnabled &&
    isCloudAuthorized()
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
========================================================= */

export async function retryAllErrors() {

  /*
    V2.3.0

    若未授權，先交給 syncNow() 做授權判斷。

    不先修改 error queue，
    避免只是沒有 Token 就把既有錯誤狀態洗掉。
  */

  if (
    !isCloudAuthorized()
  ) {

    const authResult =
      await syncNow(
        {
          force:
            true,

          manual:
            true
        }
      );


    if (
      !authResult.ok
    ) {

      return authResult;

    }

  }


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

   api-sync.js 只處理 sync behavior，
   Header / Authorization UI 由 main.js 更新。
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
          autoSyncEnabled,

        has_cloud_token:
          hasCloudToken(),

        cloud_auth_state:
          getCloudAuthState()
      }
    );


    /*
      網路恢復時：

      1. 先檢查 Worker
      2. 若有 Token，再驗證 Authorization
      3. 只有 authorized 才 Auto Sync
    */

    const cloud =
      await testCloudConnection();


    if (
      cloud.authorized ===
        true &&
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

        authorized:
          false,

        state:
          "offline",

        version:
          null
      }
    );

  }
);
