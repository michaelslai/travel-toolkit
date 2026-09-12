/* =========================================================
   Travel Toolkit V2.2.0 Modular
   File: js/backup.js
   Modified: 2026-09-12

   Changes:
   - 從 V2.1.2 抽離 JSON Backup / Import
   - 保留 backup_version = 4
   - 保留完整 Local 備份（含 tombstone）
   - 保留 merge import
   - 保留 client_uid 去重
   - 保留 updated_at Last Write Wins
   - 匯入後是否同步 D1，依 auto_sync_enabled
========================================================= */

import {

  APP_VERSION,

  STORE_TRIPS,
  STORE_FOOTPRINTS,
  STORE_FOOD,
  STORE_EXPENSES

} from "./config.js";


import {

  dbPut,
  dbGet,
  dbGetAll,
  createUID,
  queueSync

} from "./db.js";


import {

  getAutoSyncEnabled,
  syncNow

} from "./api-sync.js";


/* =========================================================
   CALLBACKS
========================================================= */

let hooks = {

  showToast:
    () => {},

  showMessage:
    () => {},

  confirmDialog:
    async () => true,

  requestRefresh:
    () => {}

};


/* =========================================================
   INIT
========================================================= */

export function initBackupModule(
  options = {}
) {

  hooks = {

    ...hooks,

    ...options

  };


  bindBackupEvents();

}


/* =========================================================
   TIME
========================================================= */

function nowISO() {

  return new Date()
    .toISOString();

}


/* =========================================================
   PARSE SYNC TIME
========================================================= */

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
    SQLite format:
    2026-09-12 16:30:00
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
   DOWNLOAD JSON
========================================================= */

function downloadJson(
  filename,
  data
) {

  const blob =
    new Blob(
      [
        JSON.stringify(
          data,
          null,
          2
        )
      ],
      {
        type:
          "application/json"
      }
    );


  const url =
    URL.createObjectURL(
      blob
    );


  const anchor =
    document.createElement(
      "a"
    );


  anchor.href =
    url;


  anchor.download =
    filename;


  document.body
    .appendChild(
      anchor
    );


  anchor.click();


  anchor.remove();


  URL.revokeObjectURL(
    url
  );

}


/* =========================================================
   EXPORT BACKUP
========================================================= */

export async function exportLocalBackup() {

  try {

    const [

      trips,
      footprints,
      foodRecords,
      expenses

    ] =

      await Promise.all(
        [

          dbGetAll(
            STORE_TRIPS
          ),

          dbGetAll(
            STORE_FOOTPRINTS
          ),

          dbGetAll(
            STORE_FOOD
          ),

          dbGetAll(
            STORE_EXPENSES
          )

        ]
      );


    const backup = {

      app:
        "Travel Toolkit",

      app_version:
        APP_VERSION,

      backup_version:
        4,

      exported_at:
        nowISO(),

      settings: {

        auto_sync_enabled:
          getAutoSyncEnabled()

      },

      sync_metadata: {

        note:
          "Local-first full backup including tombstones and sync fields"

      },

      data: {

        trips,

        footprints,

        food_records:
          foodRecords,

        expenses

      }

    };


    const now =
      new Date();


    const filename =

      "travel-toolkit-backup-" +

      now
        .toISOString()
        .slice(
          0,
          10
        ) +

      ".json";


    downloadJson(
      filename,
      backup
    );


    hooks.showToast(
      "⬇️ Local 完整備份已匯出"
    );


    return backup;

  }
  catch (
    error
  ) {

    console.error(
      "Backup export failed:",
      error
    );


    hooks.showMessage(

      "匯出備份失敗：\n" +
      error.message,

      "error"

    );


    throw error;

  }

}


/* =========================================================
   IMPORT NEWER CHECK
========================================================= */

function importedRecordIsNewer(
  imported,
  existing
) {

  if (
    !existing
  ) {

    return true;

  }


  const importedTime =
    parseSyncTime(
      imported.updated_at
    );


  const existingTime =
    parseSyncTime(
      existing.updated_at
    );


  /*
    都沒有有效 timestamp 時，
    保守保留 existing。
  */

  if (
    Number.isNaN(
      importedTime
    ) &&
    Number.isNaN(
      existingTime
    )
  ) {

    return false;

  }


  if (
    Number.isNaN(
      existingTime
    )
  ) {

    return true;

  }


  if (
    Number.isNaN(
      importedTime
    )
  ) {

    return false;

  }


  return (
    importedTime >
    existingTime
  );

}


/* =========================================================
   NORMALIZE IMPORTED RECORD
========================================================= */

function normalizeImportedRecord(
  source,
  options = {}
) {

  const record = {

    ...source

  };


  /*
    新版 IndexedDB 主鍵統一 client_uid。
  */

  record.client_uid =

    source.client_uid ||
    createUID();


  /*
    如果是舊備份，
    cloud_id 可能不存在。
  */

  record.cloud_id =

    source.cloud_id ??
    options.cloudId ??
    null;


  record.updated_at =

    source.updated_at ||
    source.created_at ||
    nowISO();


  record.deleted_at =

    source.deleted_at ??
    null;


  record.sync_status =

    source.sync_status ||
    "pending";


  /*
    不保留舊 IndexedDB numeric id。
  */

  delete record.id;


  return record;

}


/* =========================================================
   IMPORT ENTITY
========================================================= */

async function importEntityRecord(
  entity,
  storeName,
  source,
  options = {}
) {

  if (
    !source
  ) {

    return null;

  }


  const normalized =
    normalizeImportedRecord(
      source,
      options
    );


  const existing =
    await dbGet(
      storeName,
      normalized.client_uid
    );


  /*
    已存在同 client_uid：
    只接受較新的 imported record。
  */

  if (
    existing
  ) {

    if (
      !importedRecordIsNewer(
        normalized,
        existing
      )
    ) {

      return existing;

    }

  }


  /*
    匯入後若是 synced record，
    保留 synced。

    若是 pending / error / deleted，
    仍需要 queue。
  */

  await dbPut(
    storeName,
    normalized
  );


  const needsQueue =

    normalized.sync_status !==
      "synced" ||

    Boolean(
      normalized.deleted_at
    );


  if (
    needsQueue
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
   OLD ID HELPER
========================================================= */

function getLegacyId(
  record
) {

  return (

    record?.id ??

    record?.cloud_id ??

    null

  );

}


/* =========================================================
   IMPORT BACKUP
========================================================= */

export async function importLocalBackup(
  file
) {

  if (
    !file
  ) {

    return;

  }


  let data;


  try {

    data =
      JSON.parse(
        await file.text()
      );

  }
  catch (
    error
  ) {

    hooks.showMessage(
      "JSON 格式錯誤，無法讀取備份。",
      "error"
    );


    throw error;

  }


  const sourceData =

    data?.data ||
    data;


  const tripRows =

    Array.isArray(
      sourceData?.trips
    )

      ? sourceData.trips

      : [];


  const footprintRows =

    Array.isArray(
      sourceData?.footprints
    )

      ? sourceData.footprints

      : [];


  const foodRows =

    Array.isArray(
      sourceData?.food_records
    )

      ? sourceData.food_records

      : Array.isArray(
          sourceData?.foodRecords
        )

        ? sourceData.foodRecords

        : [];


  const expenseRows =

    Array.isArray(
      sourceData?.expenses
    )

      ? sourceData.expenses

      : [];


  const total =

    tripRows.length +

    footprintRows.length +

    foodRows.length +

    expenseRows.length;


  if (
    total ===
    0
  ) {

    hooks.showMessage(
      "這份 JSON 找不到可匯入的 Travel Toolkit 資料。",
      "error"
    );


    return;

  }


  const confirmed =
    await hooks.confirmDialog(

      "匯入 Local 備份",

      `找到以下資料：

🧳 旅程：${tripRows.length}
📍 足跡：${footprintRows.length}
🍜 美食：${foodRows.length}
💰 消費：${expenseRows.length}

目前 D1 自動同步：${
  getAutoSyncEnabled()
    ? "ON"
    : "OFF"
}

匯入將使用 client_uid 與 updated_at 合併，不會直接清空目前資料。

是否繼續？`

    );


  if (
    !confirmed
  ) {

    return;

  }


  /*
    V2.1.2 以前的 Toolkit 備份，
    id 可能代表 D1 cloud id。

    backup_version 4 則已經有 cloud_id。
  */

  const backupVersion =
    Number(
      data?.backup_version ||
      0
    );


  const cloudAware =

    data?.app ===
      "Travel Toolkit" &&

    backupVersion <=
      3;


  /*
    Legacy relation maps
  */

  const importedTripIdMap =
    new Map();


  const importedFootprintIdMap =
    new Map();


  const importedFoodIdMap =
    new Map();


  try {

    /* =====================================================
       TRIPS
    ===================================================== */

    for (
      const source of
      tripRows
    ) {

      const legacyId =
        getLegacyId(
          source
        );


      const imported =
        await importEntityRecord(

          "trips",

          STORE_TRIPS,

          source,

          {
            cloudId:

              cloudAware

                ? legacyId

                : source.cloud_id ??
                  null
          }

        );


      if (
        imported &&
        legacyId !==
          null
      ) {

        importedTripIdMap.set(
          String(
            legacyId
          ),
          imported.client_uid
        );

      }

    }


    /* =====================================================
       FOOTPRINTS FIRST PASS
    ===================================================== */

    for (
      const source of
      footprintRows
    ) {

      const legacyId =
        getLegacyId(
          source
        );


      const record = {

        ...source

      };


      /*
        舊版 trip_id → trip_client_uid
      */

      if (
        !record.trip_client_uid &&
        record.trip_id !==
          undefined &&
        record.trip_id !==
          null
      ) {

        record.trip_client_uid =

          importedTripIdMap.get(
            String(
              record.trip_id
            )
          ) ||

          null;

      }


      const imported =
        await importEntityRecord(

          "footprints",

          STORE_FOOTPRINTS,

          record,

          {
            cloudId:

              cloudAware

                ? legacyId

                : source.cloud_id ??
                  null
          }

        );


      if (
        imported &&
        legacyId !==
          null
      ) {

        importedFootprintIdMap.set(
          String(
            legacyId
          ),
          imported.client_uid
        );

      }

    }


    /* =====================================================
       FOOTPRINTS SECOND PASS
       previous_record_id relation
    ===================================================== */

    for (
      const source of
      footprintRows
    ) {

      const legacyId =
        getLegacyId(
          source
        );


      const currentUid =

        source.client_uid ||

        (
          legacyId !==
            null

            ? importedFootprintIdMap.get(
                String(
                  legacyId
                )
              )

            : null
        );


      if (
        !currentUid
      ) {

        continue;

      }


      const current =
        await dbGet(
          STORE_FOOTPRINTS,
          currentUid
        );


      if (
        !current
      ) {

        continue;

      }


      if (
        source.previous_client_uid
      ) {

        current.previous_client_uid =
          source.previous_client_uid;

      }
      else if (
        source.previous_record_id !==
          undefined &&
        source.previous_record_id !==
          null
      ) {

        current.previous_client_uid =

          importedFootprintIdMap.get(

            String(
              source.previous_record_id
            )

          ) ||

          null;

      }


      await dbPut(
        STORE_FOOTPRINTS,
        current
      );

    }


    /* =====================================================
       FOOD
    ===================================================== */

    for (
      const source of
      foodRows
    ) {

      const legacyId =
        getLegacyId(
          source
        );


      const record = {

        ...source

      };


      if (
        !record.trip_client_uid &&
        record.trip_id !==
          undefined &&
        record.trip_id !==
          null
      ) {

        record.trip_client_uid =

          importedTripIdMap.get(
            String(
              record.trip_id
            )
          ) ||

          null;

      }


      const imported =
        await importEntityRecord(

          "food_records",

          STORE_FOOD,

          record,

          {
            cloudId:

              cloudAware

                ? legacyId

                : source.cloud_id ??
                  null
          }

        );


      if (
        imported &&
        legacyId !==
          null
      ) {

        importedFoodIdMap.set(
          String(
            legacyId
          ),
          imported.client_uid
        );

      }

    }


    /* =====================================================
       EXPENSES
    ===================================================== */

    for (
      const source of
      expenseRows
    ) {

      const legacyId =
        getLegacyId(
          source
        );


      const record = {

        ...source

      };


      if (
        !record.trip_client_uid &&
        record.trip_id !==
          undefined &&
        record.trip_id !==
          null
      ) {

        record.trip_client_uid =

          importedTripIdMap.get(
            String(
              record.trip_id
            )
          ) ||

          null;

      }


      /*
        Food source relation
      */

      if (
        record.source_type ===
          "food" &&
        !record.source_client_uid &&
        record.source_id !==
          undefined &&
        record.source_id !==
          null
      ) {

        record.source_client_uid =

          importedFoodIdMap.get(
            String(
              record.source_id
            )
          ) ||

          null;

      }


      await importEntityRecord(

        "expenses",

        STORE_EXPENSES,

        record,

        {
          cloudId:

            cloudAware

              ? legacyId

              : source.cloud_id ??
                null
        }

      );

    }


    hooks.requestRefresh();


    hooks.showToast(
      "⬆️ Local 備份匯入完成"
    );


    /*
      Auto Sync ON：
      匯入後同步。

      Auto Sync OFF：
      只留 Local。
    */

    if (
      navigator.onLine &&
      getAutoSyncEnabled()
    ) {

      setTimeout(
        () => {

          syncNow();

        },
        300
      );

    }


    return {

      ok:
        true,

      counts: {

        trips:
          tripRows.length,

        footprints:
          footprintRows.length,

        food_records:
          foodRows.length,

        expenses:
          expenseRows.length

      }

    };

  }
  catch (
    error
  ) {

    console.error(
      "Backup import failed:",
      error
    );


    hooks.showMessage(

      "匯入備份失敗：\n" +
      error.message,

      "error"

    );


    throw error;

  }

}


/* =========================================================
   FILE INPUT HANDLER
========================================================= */

async function handleBackupFileInput(
  event
) {

  const input =
    event.target;


  const file =
    input.files?.[0];


  if (
    !file
  ) {

    return;

  }


  try {

    await importLocalBackup(
      file
    );

  }
  finally {

    /*
      清掉 value，
      這樣同一個檔案可以再次選取。
    */

    input.value =
      "";

  }

}


/* =========================================================
   EVENT BINDING
========================================================= */

let eventsBound =
  false;


function bindBackupEvents() {

  if (
    eventsBound
  ) {

    return;

  }


  eventsBound =
    true;


  document
    .getElementById(
      "exportBackupButton"
    )
    ?.addEventListener(
      "click",
      exportLocalBackup
    );


  document
    .getElementById(
      "importBackupInput"
    )
    ?.addEventListener(
      "change",
      handleBackupFileInput
    );

}
