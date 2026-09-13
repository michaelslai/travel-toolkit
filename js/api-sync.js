/* =========================================================
   Travel Toolkit V2.4.0 Modular
   File: js/api-sync.js
   Modified: 2026-09-13

   【V2.4.0 R2 Photo Sync】
   - 新增 Cloudflare R2 Photo Upload / Read / Delete helper
   - Food photo_local 仍只保留於 IndexedDB
   - photo_key 同步至 D1，作為 R2 object identifier
   - 新增 photo_local_key，辨識本機快取對應的 photo_key
   - 新增 photo_pending_action：upload / delete
   - 新增 photo_old_key：照片替換／移除後延後清除舊 R2 object
   - R2 Upload 成功後才更新 photo_key
   - D1 metadata 同步成功後才刪除舊 R2 object
   - Pull 時只有 photo_local_key 與 Server photo_key 一致才保留快取
   - 避免其他裝置更新照片後被舊 photo_local 蓋回
   - prepareSyncData 不送任何 Local-only photo state 到 Worker / D1
   - 保留 V2.3.0 Cloud Authorization / Local-first / LWW
   - IndexedDB schema 不變

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

  CLOUD_R2_STATUS_PATH,
  CLOUD_PHOTO_UPLOAD_PATH,
  CLOUD_PHOTO_PATH_PREFIX,
  CLOUD_PHOTO_CONTENT_TYPE,
  CLOUD_PHOTO_MAX_BYTES,

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
   R2 PHOTO HELPERS
   V2.4.0
========================================================= */

function dataUrlToBlob(
  dataUrl
) {

  const value =
    String(
      dataUrl ||
      ""
    );


  const match =
    value.match(
      /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.+)$/i
    );


  if (
    !match
  ) {

    throw new Error(
      "Invalid photo data URL"
    );

  }


  const contentType =
    String(
      match[1] ||
      ""
    )
    .toLowerCase();


  const binary =
    atob(
      match[2]
    );


  const bytes =
    new Uint8Array(
      binary.length
    );


  for (
    let i = 0;
    i < binary.length;
    i++
  ) {

    bytes[i] =
      binary.charCodeAt(
        i
      );

  }


  return new Blob(
    [
      bytes
    ],
    {
      type:
        contentType
    }
  );

}


function validatePhotoBlob(
  blob
) {

  if (
    !blob
  ) {

    throw new Error(
      "Photo blob is missing"
    );

  }


  if (
    blob.type !==
    CLOUD_PHOTO_CONTENT_TYPE
  ) {

    throw new Error(
      "照片必須是 JPEG 格式"
    );

  }


  if (
    blob.size >
    CLOUD_PHOTO_MAX_BYTES
  ) {

    throw new Error(
      "照片超過 5 MB，無法上傳"
    );

  }


  if (
    blob.size <=
    0
  ) {

    throw new Error(
      "照片資料為空"
    );

  }

}


/* =========================================================
   TEST R2 CONNECTION
========================================================= */

export async function testR2Connection() {

  if (
    !navigator.onLine
  ) {

    return {

      ok:
        false,

      state:
        "offline",

      r2:
        false

    };

  }


  if (
    !isCloudAuthorized()
  ) {

    return {

      ok:
        false,

      state:
        "unauthorized",

      r2:
        false

    };

  }


  try {

    const result =
      await api(
        CLOUD_R2_STATUS_PATH
      );


    return {

      ok:
        result.ok ===
          true,

      state:
        result.r2 ===
          true
          ? "ready"
          : "error",

      r2:
        result.r2 ===
          true,

      data:
        result

    };

  }
  catch (
    error
  ) {

    return {

      ok:
        false,

      state:
        isCloudAuthError(
          error
        )
          ? "unauthorized"
          : "error",

      r2:
        false,

      error

    };

  }

}


/* =========================================================
   UPLOAD CLOUD PHOTO
========================================================= */

/*
  input:
  - foodClientUid
  - Blob
  或
  - Data URL

  output:
  {
    ok,
    photo_key,
    size_bytes,
    content_type
  }
*/

export async function uploadCloudPhoto(
  foodClientUid,
  photo
) {

  if (
    !navigator.onLine
  ) {

    throw new Error(
      "目前離線，無法上傳照片"
    );

  }


  if (
    !isCloudAuthorized()
  ) {

    throw createCloudAuthError(
      "尚未授權雲端照片功能",
      "PHOTO_CLOUD_UNAUTHORIZED",
      401
    );

  }


  const uid =
    String(
      foodClientUid ||
      ""
    )
    .trim();


  if (
    !uid
  ) {

    throw new Error(
      "food client_uid is required"
    );

  }


  let blob =
    photo;


  if (
    typeof photo ===
      "string"
  ) {

    blob =
      dataUrlToBlob(
        photo
      );

  }


  validatePhotoBlob(
    blob
  );


  const path =

    CLOUD_PHOTO_UPLOAD_PATH +

    "?food_client_uid=" +

    encodeURIComponent(
      uid
    );


  syncDebug(
    "PHOTO UPLOAD START",
    {

      client_uid:
        uid,

      size_bytes:
        blob.size,

      content_type:
        blob.type

    }
  );


  const token =
    getCloudToken();


  const response =
    await fetch(
      API_BASE +
      path,
      {

        method:
          "POST",

        headers: {

          [
            CLOUD_AUTH_HEADER
          ]:
            token,

          "Content-Type":
            CLOUD_PHOTO_CONTENT_TYPE

        },

        body:
          blob

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
        `Photo upload failed: HTTP ${response.status}`
      );


    error.status =
      response.status;


    error.data =
      data;


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

    }


    throw error;

  }


  if (
    !data.photo_key
  ) {

    throw new Error(
      "Worker did not return photo_key"
    );

  }


  syncDebug(
    "PHOTO UPLOAD SUCCESS",
    {

      client_uid:
        uid,

      photo_key:
        data.photo_key,

      size_bytes:
        data.size_bytes ??
        blob.size

    }
  );


  return data;

}


/* =========================================================
   FETCH CLOUD PHOTO
========================================================= */

/*
  不能直接：

  <img src="/api/photos/...">

  因為 img 無法自訂 X-Travel-Token。

  必須：
  fetch + auth header
  → Blob
  → URL.createObjectURL()
*/

export async function fetchCloudPhoto(
  photoKey
) {

  if (
    !navigator.onLine
  ) {

    throw new Error(
      "目前離線，無法下載雲端照片"
    );

  }


  if (
    !isCloudAuthorized()
  ) {

    throw createCloudAuthError(
      "尚未授權雲端照片功能",
      "PHOTO_CLOUD_UNAUTHORIZED",
      401
    );

  }


  const key =
    String(
      photoKey ||
      ""
    )
    .trim();


  if (
    !key
  ) {

    throw new Error(
      "photo_key is required"
    );

  }


  const token =
    getCloudToken();


  const response =
    await fetch(

      API_BASE +

      CLOUD_PHOTO_PATH_PREFIX +

      encodeURIComponent(
        key
      ),

      {

        method:
          "GET",

        headers: {

          [
            CLOUD_AUTH_HEADER
          ]:
            token

        }

      }
    );


  if (
    !response.ok
  ) {

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


    const error =
      new Error(
        data.error ||
        `Photo fetch failed: HTTP ${response.status}`
      );


    error.status =
      response.status;


    error.data =
      data;


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

    }


    throw error;

  }


  const blob =
    await response.blob();


  if (
    blob.type !==
      CLOUD_PHOTO_CONTENT_TYPE
  ) {

    console.warn(
      "Unexpected cloud photo content type:",
      blob.type
    );

  }


  return blob;

}


/* =========================================================
   DELETE CLOUD PHOTO
========================================================= */

export async function deleteCloudPhoto(
  photoKey
) {

  if (
    !photoKey
  ) {

    return {

      ok:
        true,

      skipped:
        "no-photo-key"

    };

  }


  if (
    !navigator.onLine
  ) {

    throw new Error(
      "目前離線，無法刪除雲端照片"
    );

  }


  if (
    !isCloudAuthorized()
  ) {

    throw createCloudAuthError(
      "尚未授權雲端照片功能",
      "PHOTO_CLOUD_UNAUTHORIZED",
      401
    );

  }


  const key =
    String(
      photoKey
    )
    .trim();


  const token =
    getCloudToken();


  const response =
    await fetch(

      API_BASE +

      CLOUD_PHOTO_PATH_PREFIX +

      encodeURIComponent(
        key
      ),

      {

        method:
          "DELETE",

        headers: {

          [
            CLOUD_AUTH_HEADER
          ]:
            token

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
        `Photo delete failed: HTTP ${response.status}`
      );


    error.status =
      response.status;


    error.data =
      data;


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

    }


    throw error;

  }


  syncDebug(
    "PHOTO DELETE SUCCESS",
    {

      photo_key:
        key,

      result:
        data

    }
  );


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
   FOOD PHOTO LOCAL STATE
   V2.4.0
========================================================= */

/*
  Local-only fields：

  photo_local
  → 本機 Base64 JPEG

  photo_local_key
  → photo_local 對應哪一個 R2 photo_key

  photo_pending_action
  → "upload"
  → "delete"
  → null

  photo_old_key
  → 更換／移除照片時，
    等 D1 metadata 成功後才刪除的舊 R2 key
*/


function normalizePhotoKey(
  value
) {

  const key =
    String(
      value ||
      ""
    )
    .trim();


  return key ||
    null;

}


function normalizePhotoPendingAction(
  value
) {

  if (
    value ===
      "upload" ||
    value ===
      "delete"
  ) {

    return value;

  }


  return null;

}


/* =========================================================
   PHOTO CACHE MATCH
========================================================= */

/*
  判斷既有 photo_local
  是否仍然可以當作目前 Server photo_key 的快取。

  情況 1：
  photo_local_key === server photo_key
  → 明確相同，保留

  情況 2：
  舊 V2.3.0 資料
  photo_local 有值
  photo_local_key 尚不存在
  Server 也尚未有 photo_key
  → 保留 legacy local photo

  其他：
  → 視為 stale cache
*/

function canPreservePhotoLocal(
  existing,
  serverPhotoKey
) {

  if (
    !existing?.photo_local
  ) {

    return false;

  }


  const localCacheKey =
    normalizePhotoKey(
      existing.photo_local_key
    );


  const serverKey =
    normalizePhotoKey(
      serverPhotoKey
    );


  if (
    localCacheKey &&
    serverKey &&
    localCacheKey ===
      serverKey
  ) {

    return true;

  }


  /*
    V2.3.0 → V2.4.0 相容：

    舊資料可能有 photo_local，
    但尚未有 photo_local_key / photo_key。
  */

  if (
    !localCacheKey &&
    !serverKey
  ) {

    return true;

  }


  return false;

}


/* =========================================================
   PHOTO STATE AFTER OWN PUSH
========================================================= */

/*
  這個 helper 用在：

  Local Push
  → Worker / D1
  → Server 回傳 canonical record

  此時 Server record 是剛剛由本機送出的結果，
  所以 Local-only workflow state 仍需暫時保留，
  等 syncUpsertItem() 做 R2 cleanup。
*/

function preservePhotoStateAfterPush(
  existing,
  converted,
  serverRecord
) {

  if (
    !existing
  ) {

    return converted;

  }


  const serverPhotoKey =
    normalizePhotoKey(
      serverRecord?.photo_key
    );


  if (
    canPreservePhotoLocal(
      existing,
      serverPhotoKey
    )
  ) {

    converted.photo_local =
      existing.photo_local;


    converted.photo_local_key =
      normalizePhotoKey(
        existing.photo_local_key
      );

  }
  else {

    /*
      若 Server 已改成其他 photo_key，
      舊 photo_local 不可繼續冒充新照片。
    */

    converted.photo_local =
      null;


    converted.photo_local_key =
      null;

  }


  /*
    R2 workflow state 必須保留到
    D1 metadata 成功後的 cleanup 階段。
  */

  converted.photo_pending_action =
    normalizePhotoPendingAction(
      existing.photo_pending_action
    );


  converted.photo_old_key =
    normalizePhotoKey(
      existing.photo_old_key
    );


  return converted;

}


/* =========================================================
   PHOTO STATE FROM SERVER PULL
========================================================= */

/*
  Pull 接受 Server version 時：

  Server 的 photo_key 是 authoritative。

  若本機 cache 對應同一個 key：
  → 保留 photo_local

  若 key 不同：
  → 清掉 stale photo_local
  → 後續 food.js 會依 photo_key 從 R2 抓新照片

  因為這裡代表 Server 已贏得 LWW，
  所以 local pending photo action 也要清掉。
*/

function applyServerPhotoState(
  existing,
  converted,
  serverRecord
) {

  const serverPhotoKey =
    normalizePhotoKey(
      serverRecord?.photo_key
    );


  if (
    canPreservePhotoLocal(
      existing,
      serverPhotoKey
    )
  ) {

    converted.photo_local =
      existing.photo_local;


    /*
      Legacy V2.3.0：

      尚無 server photo_key 時，
      photo_local_key 保持 null。
    */

    converted.photo_local_key =
      serverPhotoKey ||
      normalizePhotoKey(
        existing?.photo_local_key
      );

  }
  else {

    converted.photo_local =
      null;


    converted.photo_local_key =
      null;

  }


  converted.photo_pending_action =
    null;


  converted.photo_old_key =
    null;


  return converted;

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
    photo_local 等 Local-only 欄位
    不會存在 Worker response。

    這裡先建立乾淨狀態，
    後續由 reconcile / merge 決定是否保留。
  */

  if (
    entity ===
      "food_records"
  ) {

    local.photo_key =
      normalizePhotoKey(
        serverRecord.photo_key
      );


    local.photo_local =
      null;


    local.photo_local_key =
      null;


    local.photo_pending_action =
      null;


    local.photo_old_key =
      null;

  }


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


    const local =
      await serverRecordToLocal(
        entity,
        serverRecord
      );


    if (
      entity ===
        "food_records"
    ) {

      preservePhotoStateAfterPush(
        existing,
        local,
        serverRecord
      );

    }


    syncDebug(
      "PHOTO RECONCILE",
      {

        entity,

        originalUid,

        canonicalUid,

        server_photo_key:
          serverRecord.photo_key ??
          null,

        local_photo_key:
          existing?.photo_key ??
          null,

        photo_local_key:
          existing?.photo_local_key ??
          null,

        has_photo_local:
          Boolean(
            existing?.photo_local
          ),

        pending_action:
          existing?.photo_pending_action ??
          null,

        old_key:
          existing?.photo_old_key ??
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
    canonical UID 改變時：

    temporary 是這次真正 Push 的來源，
    優先保留 temporary 的 Local-only state。

    temporary 不存在時，
    才使用 canonicalExisting。
  */

  const localPhotoSource =

    temporary ||
    canonicalExisting ||
    null;


  if (
    entity ===
    "food_records"
  ) {

    preservePhotoStateAfterPush(
      localPhotoSource,
      converted,
      serverRecord
    );

  }


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

      server_photo_key:
        serverRecord.photo_key ??
        null,

      local_photo_key:
        existing?.photo_key ??
        null,

      photo_local_key:
        existing?.photo_local_key ??
        null,

      photo_pending_action:
        existing?.photo_pending_action ??
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

    這同時保護尚未上傳完成的 local photo。
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

        local_updated_at:
          existing.updated_at ??
          null,

        server_updated_at:
          serverRecord.updated_at ??
          null,

        photo_pending_action:
          existing.photo_pending_action ??
          null,

        photo_key:
          existing.photo_key ??
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
    V2.4.0

    Server version 被接受時，
    photo_key 也是 Server authoritative。

    僅保留真正對應同一 photo_key 的 Local cache。
  */

  if (
    entity ===
      "food_records"
  ) {

    applyServerPhotoState(
      existing,
      local,
      serverRecord
    );

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

      photo_key:
        serverRecord.photo_key ??
        null,

      preserve_photo_local:
        Boolean(
          local.photo_local
        )

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
    一般 Local-only fields
  */

  delete data.sync_status;
  delete data.cloud_id;


  /*
    V2.4.0 Food Local-only fields

    photo_key：
    → 要送 D1

    以下全部不能送 D1：

    photo_local
    photo_local_key
    photo_pending_action
    photo_old_key
  */

  delete data.photo_local;

  delete data.photo_local_key;

  delete data.photo_pending_action;

  delete data.photo_old_key;


  syncDebug(
    "PHOTO PAYLOAD CHECK",
    {

      entity,

      client_uid:
        record.client_uid,

      photo_key:
        record.photo_key ??
        null,

      has_photo_local:
        Boolean(
          record.photo_local
        ),

      photo_local_key:
        record.photo_local_key ??
        null,

      pending_action:
        record.photo_pending_action ??
        null,

      old_key:
        record.photo_old_key ??
        null,

      payload_photo_key:
        data.photo_key ??
        null,

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
   PREPARE FOOD PHOTO BEFORE UPSERT
   V2.4.0
========================================================= */

/*
  回傳：

  {
    uploaded_new_photo: boolean,
    uploaded_photo_key: string | null
  }

  注意：

  上傳 R2 成功後：
  - photo_key 更新為新 key
  - photo_local_key 更新為同一 key
  - photo_pending_action 仍先保留

  必須等 D1 metadata 成功後，
  才能真正清掉 pending state。
*/

async function prepareFoodPhotoBeforeUpsert(
  record
) {

  const result = {

    uploaded_new_photo:
      false,

    uploaded_photo_key:
      null

  };


  if (
    !record
  ) {

    return result;

  }


  record.photo_key =
    normalizePhotoKey(
      record.photo_key
    );


  record.photo_local_key =
    normalizePhotoKey(
      record.photo_local_key
    );


  record.photo_old_key =
    normalizePhotoKey(
      record.photo_old_key
    );


  record.photo_pending_action =
    normalizePhotoPendingAction(
      record.photo_pending_action
    );


  /*
    =========================================================
    Legacy V2.3.0 Local Photo Upgrade

    舊資料：

    photo_local 有值
    photo_key 無
    photo_local_key 無
    photo_pending_action 無

    → 視為需要 Upload。
    =========================================================
  */

  if (
    record.photo_local &&
    !record.photo_key &&
    !record.photo_local_key &&
    !record.photo_pending_action
  ) {

    record.photo_pending_action =
      "upload";


    syncDebug(
      "PHOTO LEGACY UPGRADE",
      {

        client_uid:
          record.client_uid

      }
    );

  }


  /* =====================================================
     PHOTO DELETE
  ===================================================== */

  if (
    record.photo_pending_action ===
      "delete"
  ) {

    /*
      D1 要收到：

      photo_key = null

      舊 key 保存在 photo_old_key，
      等 D1 成功後才 DELETE R2。
    */

    if (
      !record.photo_old_key &&
      record.photo_key
    ) {

      record.photo_old_key =
        record.photo_key;

    }


    record.photo_key =
      null;


    record.photo_local =
      null;


    record.photo_local_key =
      null;


    await dbPut(
      STORE_FOOD,
      record
    );


    syncDebug(
      "PHOTO DELETE PREPARED",
      {

        client_uid:
          record.client_uid,

        old_key:
          record.photo_old_key ??
          null

      }
    );


    return result;

  }


  /* =====================================================
     PHOTO UPLOAD
  ===================================================== */

  if (
    record.photo_pending_action !==
      "upload"
  ) {

    return result;

  }


  if (
    !record.photo_local
  ) {

    throw new Error(
      "照片標記為待上傳，但找不到 photo_local"
    );

  }


  /*
    已經完成 R2 Upload，
    只是上一次在 D1 / cleanup 階段失敗。

    此時：

    photo_key === photo_local_key

    → 不可再次 Upload，
      直接重試 D1。
  */

  if (
    record.photo_key &&
    record.photo_local_key &&
    record.photo_key ===
      record.photo_local_key
  ) {

    syncDebug(
      "PHOTO UPLOAD REUSE",
      {

        client_uid:
          record.client_uid,

        photo_key:
          record.photo_key

      }
    );


    return result;

  }


  const previousPhotoKey =
    normalizePhotoKey(
      record.photo_key
    );


  const upload =
    await uploadCloudPhoto(
      record.client_uid,
      record.photo_local
    );


  const newPhotoKey =
    normalizePhotoKey(
      upload.photo_key
    );


  if (
    !newPhotoKey
  ) {

    throw new Error(
      "R2 upload succeeded but photo_key is missing"
    );

  }


  /*
    更換照片：

    舊 R2 key 暫存，
    等 D1 指向新 key 後才刪。
  */

  if (
    previousPhotoKey &&
    previousPhotoKey !==
      newPhotoKey &&
    !record.photo_old_key
  ) {

    record.photo_old_key =
      previousPhotoKey;

  }


  record.photo_key =
    newPhotoKey;


  /*
    目前 photo_local 確實就是
    剛剛上傳的 R2 object。
  */

  record.photo_local_key =
    newPhotoKey;


  await dbPut(
    STORE_FOOD,
    record
  );


  result.uploaded_new_photo =
    true;


  result.uploaded_photo_key =
    newPhotoKey;


  syncDebug(
    "PHOTO UPLOAD PREPARED",
    {

      client_uid:
        record.client_uid,

      new_key:
        newPhotoKey,

      old_key:
        record.photo_old_key ??
        null

    }
  );


  return result;

}


/* =========================================================
   FINALIZE FOOD PHOTO AFTER D1 UPSERT
========================================================= */

/*
  呼叫條件：

  Worker /api/sync/upsert 已成功回應。

  順序：

  1. D1 已經接受 photo_key / null
  2. 再刪 photo_old_key
  3. 再清掉 Local pending state

  若刪 R2 失敗：
  → throw
  → queue 仍在
  → 下次同步再重試

  因此不會因清舊照片失敗而遺失 retry 能力。
*/

async function finalizeFoodPhotoAfterUpsert(
  record
) {

  if (
    !record
  ) {

    return;

  }


  const action =
    normalizePhotoPendingAction(
      record.photo_pending_action
    );


  const oldKey =
    normalizePhotoKey(
      record.photo_old_key
    );


  const currentKey =
    normalizePhotoKey(
      record.photo_key
    );


  /*
    沒有照片 workflow，
    不需要處理。
  */

  if (
    !action &&
    !oldKey
  ) {

    return;

  }


  /*
    D1 已經成功指向新照片／null，
    現在才安全刪除舊 R2 object。
  */

  if (
    oldKey &&
    oldKey !==
      currentKey
  ) {

    await deleteCloudPhoto(
      oldKey
    );

  }


  /*
    Upload 成功後，
    photo_local 變成本機有效 cache。
  */

  if (
    action ===
      "upload" &&
    currentKey &&
    record.photo_local
  ) {

    record.photo_local_key =
      currentKey;

  }


  /*
    Delete 完成：
    Local photo/cache 也必須保持清空。
  */

  if (
    action ===
      "delete"
  ) {

    record.photo_local =
      null;


    record.photo_local_key =
      null;

  }


  record.photo_pending_action =
    null;


  record.photo_old_key =
    null;


  await dbPut(
    STORE_FOOD,
    record
  );


  syncDebug(
    "PHOTO FINALIZED",
    {

      client_uid:
        record.client_uid,

      action,

      photo_key:
        record.photo_key ??
        null

    }
  );

}


/* =========================================================
   CLEAN UP UNADOPTED PHOTO
========================================================= */

/*
  特殊情況：

  本機先 Upload 新 R2 照片，
  但 D1 LWW 回傳 server_wins。

  代表剛上傳的新 R2 object
  沒有成為 authoritative photo_key。

  必須把這個新物件刪掉，
  避免 orphan。
*/

async function cleanupUnadoptedUploadedPhoto(
  photoState,
  serverRecord
) {

  if (
    !photoState?.uploaded_new_photo ||
    !photoState.uploaded_photo_key
  ) {

    return;

  }


  const uploadedKey =
    normalizePhotoKey(
      photoState.uploaded_photo_key
    );


  const serverKey =
    normalizePhotoKey(
      serverRecord?.photo_key
    );


  if (
    uploadedKey &&
    uploadedKey !==
      serverKey
  ) {

    syncDebug(
      "PHOTO CLEAN UNADOPTED",
      {

        uploaded_key:
          uploadedKey,

        server_key:
          serverKey

      }
    );


    await deleteCloudPhoto(
      uploadedKey
    );

  }

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


  let record =
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


  /*
    =========================================================
    V2.4.0

    Food 的照片必須在 D1 metadata Push 前處理。

    Upload：
    Local photo
    → R2
    → 得到 photo_key
    → D1

    Delete：
    Local photo_key = null
    → D1
    → 成功後才 DELETE R2
    =========================================================
  */

  let photoState = {

    uploaded_new_photo:
      false,

    uploaded_photo_key:
      null

  };


  if (
    queueItem.entity ===
      "food_records"
  ) {

    photoState =
      await prepareFoodPhotoBeforeUpsert(
        record
      );


    /*
      prepareFoodPhotoBeforeUpsert()
      可能已改 photo_key，
      所以重新讀一次。
    */

    record =
      await dbGet(
        STORE_FOOD,
        originalUid
      );


    if (
      !record
    ) {

      throw new Error(
        "Food record disappeared during photo preparation"
      );

    }

  }


  syncDebug(
    "PHOTO PUSH BEFORE STATUS",
    {

      entity:
        queueItem.entity,

      client_uid:
        record.client_uid,

      photo_key:
        record.photo_key ??
        null,

      has_photo_local:
        Boolean(
          record.photo_local
        ),

      photo_local_key:
        record.photo_local_key ??
        null,

      photo_pending_action:
        record.photo_pending_action ??
        null,

      photo_old_key:
        record.photo_old_key ??
        null

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

      photo_key:
        record.photo_key ??
        null,

      photo_pending_action:
        record.photo_pending_action ??
        null

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

      result_type:
        result.result ??
        null,

      cloud_id:
        result.cloud_id ??
        result.record?.id ??
        null,

      server_photo_key:
        result.record?.photo_key ??
        null

    }
  );


  /*
    =========================================================
    SERVER WINS

    如果這一輪剛 Upload 新照片，
    但 Server LWW 較新，
    新 R2 object 沒有被 D1 採用。

    先刪 orphan，再接受 Server record。
    =========================================================
  */

  if (
    result.result ===
      "server_wins" &&
    result.record
  ) {

    if (
      queueItem.entity ===
        "food_records"
    ) {

      await cleanupUnadoptedUploadedPhoto(
        photoState,
        result.record
      );

    }


    await mergeServerRecord(
      queueItem.entity,
      result.record
    );


    return;

  }


  /*
    =========================================================
    CLIENT WINS / D1 SUCCESS

    D1 metadata 已成功，
    現在才允許清舊 R2 object。
    =========================================================
  */

  if (
    queueItem.entity ===
      "food_records"
  ) {

    /*
      此時 record 仍是 original UID。

      先完成 R2 old-key cleanup。

      cleanup 若失敗會 throw，
      reconcile 尚未移除 queue，
      因此下次可以重試。
    */

    await finalizeFoodPhotoAfterUpsert(
      record
    );

  }


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

/* =========================================================
   DELETE ONE QUEUE ITEM
   V2.4.0 SAFE R2 CLEANUP
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

      photo_key:
        record.photo_key ??
        null,

      photo_old_key:
        record.photo_old_key ??
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

      result

    }
  );


  const serverWins =

    result.result ===
      "server_wins" &&

    Boolean(
      result.record
    );


  /*
    =========================================================
    IMPORTANT LWW SAFETY

    Server wins 且 Server record 尚未刪除：

    → Local delete 已被較新的 Server data 擋下
    → 絕對不可刪除 R2 photo
    → 接受 Server authoritative record
    =========================================================
  */

  if (
    serverWins &&
    !result.record.deleted_at
  ) {

    syncDebug(
      "FOOD DELETE SERVER WINS ACTIVE",
      {

        entity:
          queueItem.entity,

        client_uid:
          record.client_uid,

        server_photo_key:
          result.record.photo_key ??
          null

      }
    );


    await mergeServerRecord(
      queueItem.entity,
      result.record
    );


    return;

  }


  /*
    =========================================================
    FOOD R2 CLEANUP

    能進到這裡代表：

    1. Local tombstone 已被 D1 接受
       或

    2. Server wins，
       但 Server 本身也是 tombstone

    此時才可以安全刪 R2。
    =========================================================
  */

  if (
    queueItem.entity ===
      "food_records"
  ) {

    const keys =
      new Set(
        [

          normalizePhotoKey(
            record.photo_key
          ),

          normalizePhotoKey(
            record.photo_old_key
          ),

          /*
            如果 Server tombstone
            還保留 photo_key，
            一併清理。
          */

          serverWins
            ? normalizePhotoKey(
                result.record?.photo_key
              )
            : null

        ]
        .filter(
          Boolean
        )
      );


    for (
      const key of
      keys
    ) {

      await deleteCloudPhoto(
        key
      );

    }


    record.photo_local =
      null;


    record.photo_local_key =
      null;


    record.photo_pending_action =
      null;


    record.photo_old_key =
      null;

  }


  /*
    Server wins，
    但 Server 也是 tombstone。

    R2 已安全清除後，
    接受 Server tombstone。
  */

  if (
    serverWins
  ) {

    await mergeServerRecord(
      queueItem.entity,
      result.record
    );


    return;

  }


  /*
    Local delete accepted。
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
    Cloud Authorization 錯誤不是資料同步錯誤。

    - 不增加 retry_count
    - 不寫 last_error
    - record 回 pending
    - queue 保留
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
    R2 / D1 / Network 真正錯誤：
    保留 workflow state，讓下次 retry。
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
   PUSH LOCAL → D1 / R2
========================================================= */

export async function pushPendingChanges() {

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
      Token 若在同步途中失效，
      後面的 queue 不再繼續打 Worker。
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

    /*
      V2.4.0：

      mergeServerRecord() 會同時比較：

      server photo_key
      local photo_key
      photo_local_key

      決定本機 photo_local
      是否仍為有效快取。
    */

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
  V2.4.0

  testCloudConnection() 檢查：

  1. Browser 是否 online
  2. Worker public root
  3. Worker version = 2.4.0
  4. 是否有 Cloud Token
  5. Token 是否通過 /api/auth/check

  R2 本身可另外由 testR2Connection() 測試。
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
      Root 是 Public Endpoint，
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
      Worker / Frontend 必須同版本。

      避免 V2.4.0 Frontend
      對舊 Worker 執行 R2 workflow。
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
      目前裝置維持 Local-only。
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


  /* =====================================================
     CLOUD AUTHORIZATION
  ===================================================== */

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
      有 Token，
      但 Runtime 尚未驗證。

      Manual Sync / explicit sync
      可以先驗證一次。
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
      =====================================================
      1. Local pending → R2 / D1

      Food 有照片時：
      R2 Upload
      → D1 photo_key

      一般資料：
      → D1
      =====================================================
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


    /*
      =====================================================
      2. D1 → Local

      Food Pull 同時處理 photo_key
      與 Local photo cache validity。
      =====================================================
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
      =====================================================
      3. Dependency 補齊後再 Push 一次
      =====================================================
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
        "☁️ 雲端同步完成"
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
      真正的 Sync / Network / D1 / R2 錯誤。
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

    無論：
    - Offline
    - 未授權
    - Auto Sync OFF

    永遠先寫 IndexedDB。
  */

  const saved =
    await saveLocalRecord(
      entity,
      record
    );


  hooks.onDataChanged();


  syncDebug(
    "LOCAL SAVE",
    {

      entity,

      client_uid:
        saved?.client_uid ??
        record?.client_uid ??
        null,

      sync_status:
        saved?.sync_status ??
        null,

      photo_key:
        entity ===
          "food_records"

          ? (
              saved?.photo_key ??
              null
            )

          : undefined,

      has_photo_local:
        entity ===
          "food_records"

          ? Boolean(
              saved?.photo_local
            )

          : undefined,

      photo_local_key:
        entity ===
          "food_records"

          ? (
              saved?.photo_local_key ??
              null
            )

          : undefined,

      photo_pending_action:
        entity ===
          "food_records"

          ? (
              saved?.photo_pending_action ??
              null
            )

          : undefined,

      photo_old_key:
        entity ===
          "food_records"

          ? (
              saved?.photo_old_key ??
              null
            )

          : undefined

    }
  );


  /*
    V2.4.0

    Auto Sync 必須同時符合：

    - Online
    - Auto Sync ON
    - Cloud Authorized

    R2 Photo 也走同一個 syncNow()，
    不另外啟動獨立背景流程。
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
    V2.4.0

    Food 整筆刪除時，
    softDeleteLocalRecord() 必須保留：

    photo_key
    photo_old_key

    在 tombstone 中。

    syncDeleteItem() 會等 D1 tombstone
    成功後才刪 R2。
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
        null,

      photo_key:
        entity ===
          "food_records"

          ? (
              deleted?.photo_key ??
              null
            )

          : undefined,

      photo_old_key:
        entity ===
          "food_records"

          ? (
              deleted?.photo_old_key ??
              null
            )

          : undefined

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
    若目前尚未授權，
    先交給 syncNow() 做授權判斷。

    不預先修改 error queue，
    避免只是 Token 問題
    就洗掉原本 error state。
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


    /*
      清除 last_error，
      retry_count 保留作為歷史計數。
    */

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

      /*
        R2 workflow state 不動：

        photo_pending_action
        photo_old_key
        photo_local
        photo_local_key

        下一次 Push 會從上一次失敗點繼續。
      */

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

   api-sync.js 只處理 Sync Behavior。

   Header / Authorization UI
   由 main.js 更新。
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

      1. 檢查 Worker
      2. 驗證 Authorization
      3. authorized + Auto Sync ON
         才執行同步

      Food pending photo
      也會在 syncNow() 中繼續：
      R2 → D1 → cleanup
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


    /*
      注意：

      Offline 只更新 UI state。

      不清除：
      - Token
      - pending queue
      - photo_pending_action
      - photo_old_key
    */

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
