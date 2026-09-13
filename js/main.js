/* =========================================================
   Travel Toolkit V2.3.0 Modular
   File: js/main.js
   Modified: 2026-09-13

   【V2.3.0 Cloud Authorization】
   - 新增 Cloud Authorization UI 管理
   - 新增 Token 輸入 / 驗證 / 更換 / 清除
   - Header 區分 Local-only / Authorized
   - 未授權不視為 D1 連線錯誤
   - Manual Sync 未授權時維持 Local-only
   - Auto Sync 與 Cloud Authorization 分離
   - App 啟動時先顯示 Local，再檢查 Worker / Authorization
   - 不修改 Footprint / Food / Expense / Trip 功能邏輯

   【V2.2.x】
   - Modular 總控
   - 初始化 IndexedDB
   - 載入 Local cache
   - 分發資料到 Footprint / Food / Expense / Trip
   - 管理 Sync UI / Header
   - 管理 Auto Sync Toggle / Manual Sync
   - 管理 Tabs / Toast / Confirm Dialog
========================================================= */

import {

  APP_VERSION,
  EXPECTED_API_VERSION,

  STORE_TRIPS,
  STORE_FOOTPRINTS,
  STORE_FOOD,
  STORE_EXPENSES

} from "./config.js";


import {

  openLocalDB,
  dbGetAll,
  recoverInterruptedSync,
  getSyncCounts

} from "./db.js";


import {

  setSyncHooks,

  loadAutoSyncSetting,
  setAutoSyncEnabled,
  getAutoSyncEnabled,

  getCloudToken,
  hasCloudToken,
  setCloudToken,
  clearCloudToken,
  getCloudAuthState,
  isCloudAuthorized,
  verifyCloudAuthorization,

  testCloudConnection,
  syncNow,
  getSyncStatusSnapshot

} from "./api-sync.js";


import {

  initTripModule,
  setTripData,
  renderTrips,
  resetTripForm,
  getTripOptionsHtml

} from "./trip.js";


import {

  initExpenseModule,
  setExpenseData,
  renderExpenses,
  resetExpenseForm

} from "./expense.js";


import {

  initFoodModule,
  setFoodData,
  renderFoodRecords,
  resetFoodForm

} from "./food.js";


import {

  initFootprintModule,
  setFootprintData,
  renderFootprints,
  resetFootprintForm

} from "./footprint.js";


import {

  initBackupModule

} from "./backup.js";


/* =========================================================
   LOCAL CACHE
========================================================= */

let trips = [];
let footprints = [];
let foodRecords = [];
let expenses = [];


/* =========================================================
   CLOUD STATE
========================================================= */

let cloudState = {

  ok:
    false,

  authorized:
    false,

  version:
    null,

  state:
    "unknown"

};


/* =========================================================
   SYNC MESSAGE STATE
========================================================= */

let lastSyncMessage =
  "";


/* =========================================================
   DOM HELPER
========================================================= */

function el(
  id
) {

  return document
    .getElementById(
      id
    );

}


/* =========================================================
   ESCAPE
========================================================= */

function escapeHtml(
  value
) {

  return String(
    value ??
    ""
  )
  .replaceAll(
    "&",
    "&amp;"
  )
  .replaceAll(
    "<",
    "&lt;"
  )
  .replaceAll(
    ">",
    "&gt;"
  )
  .replaceAll(
    '"',
    "&quot;"
  )
  .replaceAll(
    "'",
    "&#039;"
  );

}


/* =========================================================
   TOAST
========================================================= */

let toastTimer =
  null;


export function showToast(
  message
) {

  const toast =
    el(
      "toast"
    );


  if (
    !toast
  ) {

    return;

  }


  toast.textContent =
    message;


  toast.classList
    .add(
      "show"
    );


  if (
    toastTimer
  ) {

    clearTimeout(
      toastTimer
    );

  }


  toastTimer =
    setTimeout(
      () => {

        toast.classList
          .remove(
            "show"
          );

      },
      2600
    );

}


/* =========================================================
   MESSAGE
========================================================= */

export function showMessage(
  message,
  type =
    "info"
) {

  if (
    type ===
    "error"
  ) {

    console.error(
      message
    );

  }


  window.alert(
    message
  );

}


/* =========================================================
   CONFIRM DIALOG
========================================================= */

let confirmResolver =
  null;


export function confirmDialog(
  title,
  message
) {

  const modal =
    el(
      "confirmModal"
    );


  /*
    若 HTML 尚未提供 modal，
    fallback 原生 confirm。
  */

  if (
    !modal
  ) {

    return Promise.resolve(

      window.confirm(
        `${title}\n\n${message}`
      )

    );

  }


  el(
    "confirmTitle"
  ).textContent =
    title;


  el(
    "confirmMessage"
  ).textContent =
    message;


  modal.classList
    .add(
      "show"
    );


  return new Promise(
    resolve => {

      confirmResolver =
        resolve;

    }
  );

}


function closeConfirm(
  result
) {

  const modal =
    el(
      "confirmModal"
    );


  if (
    modal
  ) {

    modal.classList
      .remove(
        "show"
      );

  }


  if (
    confirmResolver
  ) {

    confirmResolver(
      result
    );


    confirmResolver =
      null;

  }

}


/* =========================================================
   READ LOCAL CACHE
========================================================= */

export async function refreshLocalCache() {

  [

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


  /*
    一般 UI 不顯示 tombstone。
    IndexedDB 仍保留完整資料供 backup / sync。
  */

  trips =
    trips.filter(
      item =>
        !item.deleted_at
    );


  footprints =
    footprints.filter(
      item =>
        !item.deleted_at
    );


  foodRecords =
    foodRecords.filter(
      item =>
        !item.deleted_at
    );


  expenses =
    expenses.filter(
      item =>
        !item.deleted_at
    );

}


/* =========================================================
   DISTRIBUTE CACHE
========================================================= */

function distributeData() {

  setTripData(
    {
      trips,
      footprints,
      foodRecords,
      expenses
    }
  );


  setExpenseData(
    {
      trips,
      expenses
    }
  );


  setFoodData(
    {
      trips,
      foodRecords,
      expenses
    }
  );


  setFootprintData(
    {
      trips,
      footprints
    }
  );

}


/* =========================================================
   TRIP SELECTS
========================================================= */

function renderTripSelects() {

  const options =
    getTripOptionsHtml();


  const selectIds = [

    "footprintTrip",
    "foodTrip",
    "expenseTrip"

  ];


  selectIds.forEach(
    id => {

      const select =
        el(
          id
        );


      if (
        !select
      ) {

        return;

      }


      const oldValue =
        select.value;


      select.innerHTML =
        options;


      /*
        如果原選項仍存在就保留。
      */

      if (
        [
          ...select.options
        ]
        .some(
          option =>
            option.value ===
            oldValue
        )
      ) {

        select.value =
          oldValue;

      }

    }
  );

}


/* =========================================================
   RENDER ALL
========================================================= */

export async function renderAll() {

  await refreshLocalCache();


  distributeData();


  renderTripSelects();


  renderTrips();


  renderExpenses();


  renderFoodRecords();


  renderFootprints();


  await updateSyncStatusUI();


  updateLocalDataCounts();

}


/* =========================================================
   LOCAL COUNTS
========================================================= */

function updateLocalDataCounts() {

  const tripCount =
    el(
      "localTripCount"
    );


  const footprintCount =
    el(
      "localFootprintCount"
    );


  const foodCount =
    el(
      "localFoodCount"
    );


  const expenseCount =
    el(
      "localExpenseCount"
    );


  if (
    tripCount
  ) {

    tripCount.textContent =
      trips.length;

  }


  if (
    footprintCount
  ) {

    footprintCount.textContent =
      footprints.length;

  }


  if (
    foodCount
  ) {

    foodCount.textContent =
      foodRecords.length;

  }


  if (
    expenseCount
  ) {

    expenseCount.textContent =
      expenses.length;

  }

}


/* =========================================================
   HEADER NETWORK
========================================================= */

function updateNetworkStatus() {

  const status =
    el(
      "networkStatus"
    );


  if (
    !status
  ) {

    return;

  }


  if (
    navigator.onLine
  ) {

    status.className =
      "status-pill success";


    status.textContent =
      "🟢 網路連線";

  }
  else {

    status.className =
      "status-pill warning";


    status.textContent =
      "⚪ 離線";

  }

}


/* =========================================================
   HEADER CLOUD
========================================================= */

function updateCloudStatus() {

  const status =
    el(
      "cloudStatus"
    );


  if (
    !status
  ) {

    return;

  }


  /*
    離線優先顯示。

    Token 本身仍留在 LocalStorage，
    只是目前無法驗證 / 同步。
  */

  if (
    !navigator.onLine
  ) {

    status.className =
      "status-pill muted";


    status.textContent =
      hasCloudToken()

        ? "☁️ 離線・等待雲端"

        : "🔒 Local 模式・未授權";


    return;

  }


  /*
    已授權。
  */

  if (
    cloudState.authorized ===
      true ||
    isCloudAuthorized()
  ) {

    if (
      cloudState.version &&
      cloudState.version !==
        EXPECTED_API_VERSION
    ) {

      status.className =
        "status-pill warning";


      status.textContent =
        `🟠 雲端版本 ${cloudState.version}`;


      return;

    }


    status.className =
      "status-pill success";


    status.textContent =
      "🔐 雲端已授權";


    return;

  }


  /*
    Worker 版本不符。
  */

  if (
    cloudState.state ===
      "version-mismatch"
  ) {

    status.className =
      "status-pill warning";


    status.textContent =
      `🟠 Worker ${cloudState.version || "?"}`;


    return;

  }


  /*
    Token 有填，但驗證失敗。
  */

  if (
    cloudState.state ===
      "unauthorized"
  ) {

    status.className =
      "status-pill danger";


    status.textContent =
      "🔒 雲端授權失敗";


    return;

  }


  /*
    Worker 尚未設定 Secret。
  */

  if (
    cloudState.state ===
      "auth-not-configured"
  ) {

    status.className =
      "status-pill danger";


    status.textContent =
      "🔒 Worker 尚未設定授權";


    return;

  }


  /*
    Worker / Network Error。
  */

  if (
    cloudState.state ===
      "error"
  ) {

    status.className =
      "status-pill danger";


    status.textContent =
      "🔴 Worker 連線失敗";


    return;

  }


  /*
    正常 Local-only。

    這不是 Error。
  */

  status.className =
    "status-pill muted";


  status.textContent =
    "🔒 Local 模式・未授權";

}


/* =========================================================
   CLOUD AUTHORIZATION UI
========================================================= */

function updateCloudAuthorizationUI() {

  const input =
    el(
      "cloudTokenInput"
    );


  const status =
    el(
      "cloudAuthStatusText"
    );


  const verifyButton =
    el(
      "cloudAuthVerifyButton"
    );


  const clearButton =
    el(
      "cloudAuthClearButton"
    );


  /*
    Token 絕對不回填到畫面。

    password input 保持空白，
    避免 DOM / 畫面直接顯示已儲存 Token。
  */

  if (
    input
  ) {

    input.value =
      "";


    input.placeholder =
      hasCloudToken()

        ? "已儲存 Token；如需更換請輸入新 Token"

        : "輸入 Cloud Token";

  }


  if (
    clearButton
  ) {

    clearButton.disabled =
      !hasCloudToken();

  }


  if (
    verifyButton
  ) {

    verifyButton.textContent =

      hasCloudToken()

        ? "🔐 驗證 / 更換授權"

        : "🔐 驗證並儲存";

  }


  if (
    !status
  ) {

    return;

  }


  if (
    !navigator.onLine
  ) {

    status.textContent =
      hasCloudToken()

        ? "目前離線。Token 已保存在此裝置，恢復網路後可重新驗證。"

        : "目前為 Local-only；尚未設定 Cloud Token。";


    return;

  }


  if (
    isCloudAuthorized()
  ) {

    status.textContent =
      "🔐 雲端已授權，可使用 D1 同步。";


    return;

  }


  if (
    cloudState.state ===
      "version-mismatch"
  ) {

    status.textContent =
      `Worker 版本為 ${cloudState.version || "?"}，前端預期 ${EXPECTED_API_VERSION}。`;


    return;

  }


  if (
    cloudState.state ===
      "unauthorized"
  ) {

    status.textContent =
      "🔒 Token 驗證失敗。目前維持 Local-only。";


    return;

  }


  if (
    cloudState.state ===
      "auth-not-configured"
  ) {

    status.textContent =
      "🔒 Worker 尚未設定 TRAVEL_API_TOKEN Secret。";


    return;

  }


  if (
    hasCloudToken()
  ) {

    status.textContent =
      "已儲存 Cloud Token，但本次尚未完成驗證。";

  }
  else {

    status.textContent =
      "🔒 尚未授權雲端功能，目前所有資料只保存在此裝置。";

  }

}

/* =========================================================
   AUTO SYNC DESCRIPTION
========================================================= */

function updateAutoSyncDescription() {

  const toggle =
    el(
      "autoSyncToggle"
    );


  const description =
    el(
      "autoSyncDesc"
    );


  if (
    toggle
  ) {

    toggle.checked =
      getAutoSyncEnabled();

  }


  if (
    !description
  ) {

    return;

  }


  /*
    V2.3.0
    Auto Sync 與 Cloud Authorization 分開顯示。
  */

  if (
    !hasCloudToken()
  ) {

    description.textContent =

      getAutoSyncEnabled()

        ? "Auto Sync 已開啟，但目前尚未授權雲端。資料只會先存 Local，輸入正確 Token 後才會同步到 D1。"

        : "Auto Sync 已關閉。目前為 Local-only；GPS、地址、Nearby 等網路功能仍可正常使用。";


    return;

  }


  if (
    !isCloudAuthorized()
  ) {

    description.textContent =

      getAutoSyncEnabled()

        ? "Auto Sync 已開啟，但 Cloud Token 尚未驗證或驗證失敗。目前仍維持 Local-only。"

        : "Auto Sync 已關閉。Cloud Token 已儲存，但未授權前不會同步 D1。";


    return;

  }


  description.textContent =

    getAutoSyncEnabled()

      ? "開啟：新增、修改、刪除會先存 Local，再自動同步到 D1。"

      : "關閉：資料只先存 Local。需要時可按「立即同步 D1」。";

}


/* =========================================================
   SYNC STATUS UI
========================================================= */

export async function updateSyncStatusUI() {

  const counts =
    await getSyncCounts();


  const snapshot =
    await getSyncStatusSnapshot();


  const syncedCount =
    el(
      "syncedCount"
    );


  const pendingCount =
    el(
      "pendingCount"
    );


  const syncingCount =
    el(
      "syncingCount"
    );


  const errorCount =
    el(
      "errorCount"
    );


  if (
    syncedCount
  ) {

    syncedCount.textContent =
      counts.synced;

  }


  if (
    pendingCount
  ) {

    pendingCount.textContent =
      counts.pending;

  }


  if (
    syncingCount
  ) {

    syncingCount.textContent =
      counts.syncing;

  }


  if (
    errorCount
  ) {

    errorCount.textContent =
      counts.error;

  }


  /* =====================================================
     Header Sync Status
  ===================================================== */

  const header =
    el(
      "syncHeaderStatus"
    );


  if (
    header
  ) {

    /*
      未授權優先判斷。

      未授權不是錯誤，
      所以即使有 pending 也顯示 Local-only。
    */

    if (
      !snapshot.cloud_authorized
    ) {

      header.className =
        "status-pill muted";


      if (
        counts.pending >
        0
      ) {

        header.textContent =
          `🔒 Local 模式・${counts.pending} 筆待同步`;

      }
      else {

        header.textContent =
          "🔒 Local 模式・未授權";

      }

    }
    else if (
      snapshot.running ||
      counts.syncing >
      0
    ) {

      header.className =
        "status-pill info";


      header.textContent =
        "🔄 同步中...";

    }
    else if (
      counts.error >
      0
    ) {

      header.className =
        "status-pill danger";


      header.textContent =
        `⚠️ ${counts.error} 筆同步失敗`;

    }
    else if (
      counts.pending >
      0
    ) {

      header.className =
        "status-pill warning";


      if (
        getAutoSyncEnabled()
      ) {

        header.textContent =
          `⏳ ${counts.pending} 筆待同步`;

      }
      else {

        header.textContent =
          `📱 Local 模式 · ${counts.pending} 筆待同步`;

      }

    }
    else if (
      !getAutoSyncEnabled()
    ) {

      header.className =
        "status-pill muted";


      header.textContent =
        "📱 Local 模式";

    }
    else {

      header.className =
        "status-pill success";


      header.textContent =

        lastSyncMessage ||
        "✅ 同步完成";

    }

  }


  /* =====================================================
     Sync Page Detail
  ===================================================== */

  const lastSync =
    el(
      "lastSyncTime"
    );


  if (
    lastSync
  ) {

    if (
      snapshot.last_sync_success
    ) {

      const date =
        new Date(
          snapshot.last_sync_success
        );


      lastSync.textContent =

        Number.isNaN(
          date.getTime()
        )

          ? snapshot.last_sync_success

          : date.toLocaleString();

    }
    else {

      lastSync.textContent =
        "尚未同步";

    }

  }


  updateAutoSyncDescription();


  updateCloudAuthorizationUI();

}


/* =========================================================
   SYNC HOOKS
========================================================= */

function setupSyncHooks() {

  setSyncHooks(
    {

      onSyncState:
        async event => {

          if (
            event.type ===
              "network-online" ||
            event.type ===
              "network-offline"
          ) {

            updateNetworkStatus();

          }


          if (
            event.type ===
            "sync-start"
          ) {

            lastSyncMessage =
              "";


            await updateSyncStatusUI();

          }


          if (
            event.type ===
            "record-syncing"
          ) {

            await updateSyncStatusUI();

          }


          if (
            event.type ===
            "sync-success"
          ) {

            lastSyncMessage =

              event.manual

                ? "✅ 手動同步完成"

                : "✅ 同步完成";


            await renderAll();

          }


          if (
            event.type ===
              "sync-error" ||
            event.type ===
              "sync-auth-required"
          ) {

            lastSyncMessage =
              "";


            await renderAll();

          }

        },


      onCloudState:
        state => {

          cloudState =
            state;


          updateCloudStatus();


          updateCloudAuthorizationUI();

        },


      onDataChanged:
        () => {

          /*
            不 await，
            避免 sync engine 被 UI render 卡住。
          */

          renderAll();

        },


      onToast:
        message => {

          showToast(
            message
          );

        },


      onMessage:
        (
          message,
          type
        ) => {

          showMessage(
            message,
            type
          );

        }

    }
  );

}


/* =========================================================
   AUTO SYNC TOGGLE
========================================================= */

async function handleAutoSyncToggle(
  event
) {

  const enabled =
    event.target.checked;


  await setAutoSyncEnabled(
    enabled
  );


  lastSyncMessage =
    "";


  updateAutoSyncDescription();


  await updateSyncStatusUI();


  if (
    enabled &&
    !isCloudAuthorized()
  ) {

    showToast(
      "☁️ Auto Sync 已開啟；未授權前仍維持 Local-only"
    );


    return;

  }


  showToast(

    enabled

      ? "☁️ D1 自動同步已開啟"

      : "📱 已關閉 D1 自動同步"

  );

}


/* =========================================================
   CLOUD TOKEN VERIFY
========================================================= */

async function handleCloudAuthVerify() {

  const input =
    el(
      "cloudTokenInput"
    );


  const button =
    el(
      "cloudAuthVerifyButton"
    );


  const typedToken =
    String(
      input?.value ||
      ""
    )
    .trim();


  /*
    有輸入新 Token → 先儲存。
    沒輸入 → 使用已儲存 Token 做重新驗證。
  */

  if (
    typedToken
  ) {

    try {

      setCloudToken(
        typedToken
      );

    }
    catch (
      error
    ) {

      showMessage(
        "無法將 Cloud Token 儲存在此瀏覽器：" +
        (
          error?.message ||
          String(
            error
          )
        ),
        "error"
      );


      return;

    }

  }


  if (
    !hasCloudToken()
  ) {

    showMessage(
      "請先輸入 Cloud Token。",
      "info"
    );


    return;

  }


  if (
    !navigator.onLine
  ) {

    showMessage(
      "目前離線，無法驗證 Cloud Token。Token 已保存在此裝置。",
      "info"
    );


    updateCloudAuthorizationUI();


    return;

  }


  if (
    button
  ) {

    button.disabled =
      true;


    button.textContent =
      "🔄 驗證中...";

  }


  try {

    const auth =
      await verifyCloudAuthorization();


    cloudState =
      auth;


    updateCloudStatus();


    updateCloudAuthorizationUI();


    await updateSyncStatusUI();


    if (
      auth.authorized
    ) {

      if (
        input
      ) {

        input.value =
          "";

      }


      showToast(
        "🔐 雲端授權成功"
      );


      /*
        若已有 pending，而且 Auto Sync ON，
        授權成功後直接補同步。
      */

      const counts =
        await getSyncCounts();


      if (
        getAutoSyncEnabled() &&
        counts.pending >
        0
      ) {

        setTimeout(
          () => {

            syncNow();

          },
          200
        );

      }


      return;

    }


    if (
      auth.state ===
      "auth-not-configured"
    ) {

      showMessage(
        "Worker 尚未設定 TRAVEL_API_TOKEN Secret。",
        "error"
      );


      return;

    }


    if (
      auth.state ===
      "version-mismatch"
    ) {

      showMessage(
        `Worker 版本不相容。目前 Worker=${auth.version || "?"}，前端預期=${EXPECTED_API_VERSION}。`,
        "error"
      );


      return;

    }


    showMessage(
      "Cloud Token 驗證失敗。目前維持 Local-only，Local 資料不受影響。",
      "error"
    );

  }
  finally {

    if (
      button
    ) {

      button.disabled =
        false;


      button.textContent =

        hasCloudToken()

          ? "🔐 驗證 / 更換授權"

          : "🔐 驗證並儲存";

    }

  }

}


/* =========================================================
   CLEAR CLOUD AUTHORIZATION
========================================================= */

async function handleCloudAuthClear() {

  if (
    !hasCloudToken()
  ) {

    showToast(
      "目前沒有已儲存的 Cloud Token"
    );


    return;

  }


  const confirmed =
    await confirmDialog(

      "清除雲端授權",

      "確定要清除此裝置儲存的 Cloud Token？\n\nLocal 資料不會刪除，之後仍可重新輸入 Token 再同步。"

    );


  if (
    !confirmed
  ) {

    return;

  }


  clearCloudToken();


  cloudState = {

    ok:
      false,

    authorized:
      false,

    version:
      null,

    state:
      "local-only"

  };


  lastSyncMessage =
    "";


  updateCloudStatus();


  updateCloudAuthorizationUI();


  await updateSyncStatusUI();


  showToast(
    "🔒 已清除此裝置的雲端授權"
  );

}


/* =========================================================
   MANUAL SYNC
========================================================= */

async function handleManualSync() {

  const button =
    el(
      "manualSyncButton"
    );


  if (
    button
  ) {

    button.disabled =
      true;


    button.textContent =
      "🔄 同步中...";

  }


  lastSyncMessage =
    "";


  await updateSyncStatusUI();


  try {

    const result =
      await syncNow(
        {
          manual:
            true,

          force:
            true
        }
      );


    if (
      result.ok
    ) {

      lastSyncMessage =
        "✅ 手動同步完成";

    }
    else if (
      result.skipped ===
      "offline"
    ) {

      showMessage(
        "目前沒有網路，Local 資料仍安全保留。",
        "info"
      );

    }
    else if (
      result.skipped ===
      "already-running"
    ) {

      showToast(
        "目前已有同步作業進行中"
      );

    }
    else if (
      result.skipped ===
        "unauthorized" ||
      result.skipped ===
        "local-only"
    ) {

      /*
        syncNow() 本身也會透過 hook 顯示訊息，
        這裡不再重複 alert。
      */

      lastSyncMessage =
        "";

    }


    await renderAll();

  }
  finally {

    if (
      button
    ) {

      button.disabled =
        false;


      button.textContent =
        "🔄 立即同步 D1";

    }

  }

}
/* =========================================================
   TABS
========================================================= */

function activateTab(
  tabName
) {

  document
    .querySelectorAll(
      "[data-tab]"
    )
    .forEach(
      button => {

        button.classList
          .toggle(
            "active",

            button.dataset.tab ===
              tabName
          );

      }
    );


  document
    .querySelectorAll(
      ".tab-panel"
    )
    .forEach(
      panel => {

        panel.classList
          .toggle(
            "active",

            panel.id ===
              `panel-${tabName}`
          );

      }
    );


  /*
    Leaflet 在隱藏 panel 初始化後，
    顯示時需要重新計算尺寸。
  */

  if (
    tabName ===
    "footprint"
  ) {

    setTimeout(
      () => {

        window.dispatchEvent(
          new Event(
            "resize"
          )
        );

      },
      100
    );

  }

}


function bindTabs() {

  document
    .querySelectorAll(
      "[data-tab]"
    )
    .forEach(
      button => {

        button.addEventListener(
          "click",
          () => {

            activateTab(
              button.dataset.tab
            );

          }
        );

      }
    );

}


/* =========================================================
   CONFIRM EVENTS
========================================================= */

function bindConfirmEvents() {

  el(
    "confirmCancel"
  )
  ?.addEventListener(
    "click",
    () => {

      closeConfirm(
        false
      );

    }
  );


  el(
    "confirmOk"
  )
  ?.addEventListener(
    "click",
    () => {

      closeConfirm(
        true
      );

    }
  );


  el(
    "confirmModal"
  )
  ?.addEventListener(
    "click",
    event => {

      if (
        event.target ===
        el(
          "confirmModal"
        )
      ) {

        closeConfirm(
          false
        );

      }

    }
  );

}


/* =========================================================
   GENERAL EVENTS
========================================================= */

function bindGeneralEvents() {

  el(
    "autoSyncToggle"
  )
  ?.addEventListener(
    "change",
    handleAutoSyncToggle
  );


  el(
    "manualSyncButton"
  )
  ?.addEventListener(
    "click",
    handleManualSync
  );


  /*
    V2.3.0
    Cloud Authorization Events
  */

  el(
    "cloudAuthVerifyButton"
  )
  ?.addEventListener(
    "click",
    handleCloudAuthVerify
  );


  el(
    "cloudAuthClearButton"
  )
  ?.addEventListener(
    "click",
    handleCloudAuthClear
  );


  el(
    "cloudTokenInput"
  )
  ?.addEventListener(
    "keydown",
    event => {

      if (
        event.key !==
        "Enter"
      ) {

        return;

      }


      event.preventDefault();


      handleCloudAuthVerify();

    }
  );


  window.addEventListener(
    "online",
    async () => {

      updateNetworkStatus();


      /*
        api-sync.js 自己也會處理 online event。

        main.js 這裡只更新 UI。
      */

      updateCloudStatus();


      updateCloudAuthorizationUI();


      await updateSyncStatusUI();

    }
  );


  window.addEventListener(
    "offline",
    async () => {

      updateNetworkStatus();


      updateCloudStatus();


      updateCloudAuthorizationUI();


      await updateSyncStatusUI();

    }
  );


  document.addEventListener(
    "visibilitychange",
    async () => {

      if (
        document.visibilityState !==
        "visible"
      ) {

        return;

      }


      /*
        回到頁面時：

        - 必須 Online
        - Auto Sync ON
        - Cloud 已授權

        才允許背景同步。
      */

      if (
        navigator.onLine &&
        getAutoSyncEnabled() &&
        isCloudAuthorized()
      ) {

        await syncNow();

      }
      else {

        /*
          沒有同步也更新一次 Header。
        */

        updateNetworkStatus();


        updateCloudStatus();


        updateCloudAuthorizationUI();


        await updateSyncStatusUI();

      }

    }
  );

}


/* =========================================================
   MODULE INITIALIZATION
========================================================= */

function initializeFeatureModules() {

  const sharedHooks = {

    showToast,

    showMessage,

    confirmDialog,

    requestRefresh:
      renderAll

  };


  initTripModule(
    sharedHooks
  );


  initExpenseModule(
    sharedHooks
  );


  initFoodModule(
    sharedHooks
  );


  initFootprintModule(
    sharedHooks
  );


  initBackupModule(
    sharedHooks
  );

}


/* =========================================================
   INITIAL FORMS
========================================================= */

function initializeForms() {

  resetTripForm();


  resetExpenseForm();


  resetFoodForm();


  resetFootprintForm();

}


/* =========================================================
   APP VERSION
========================================================= */

function renderAppVersion() {

  const version =
    el(
      "appVersion"
    );


  if (
    version
  ) {

    version.textContent =
      `V${APP_VERSION}`;

  }

}


/* =========================================================
   STARTUP ERROR
========================================================= */

function showStartupError(
  error
) {

  console.error(
    "Travel Toolkit startup error:",
    error
  );


  const box =
    el(
      "startupError"
    );


  if (
    box
  ) {

    box.style.display =
      "block";


    box.textContent =

      "初始化失敗：" +

      (
        error?.message ||
        String(
          error
        )
      );

  }


  showMessage(

    "Travel Toolkit 初始化失敗：\n" +

    (
      error?.message ||
      String(
        error
      )
    ),

    "error"

  );

}


/* =========================================================
   INIT
========================================================= */

async function init() {

  try {

    renderAppVersion();


    updateNetworkStatus();


    /*
      先綁 UI Events。
    */

    bindTabs();


    bindConfirmEvents();


    bindGeneralEvents();


    /*
      先建立 Sync Hooks。

      之後 Authorization / Sync 狀態改變，
      才能立即更新 Header。
    */

    setupSyncHooks();


    /*
      初始化各功能模組 DOM event。
    */

    initializeFeatureModules();


    /*
      開 Local IndexedDB。
    */

    await openLocalDB();


    /*
      載入 Auto Sync 設定。
    */

    await loadAutoSyncSetting();


    updateAutoSyncDescription();


    /*
      修復上一輪被中斷的 syncing。

      例如：
      Browser 被關閉時某筆資料仍是 syncing。

      這裡恢復為可重試狀態。
    */

    await recoverInterruptedSync();


    /*
      Local-first：

      不管 Cloud 是否可用，
      先顯示 Local IndexedDB 資料。
    */

    await renderAll();


    /*
      初始化表單。

      放在 Local render 後，
      因為 Trip Select 此時才有 options。
    */

    initializeForms();


    /*
      先更新一次 Authorization UI。

      此時可能：
      - 完全沒有 Token
      - 已有舊 Token
      - 尚未驗證
    */

    updateCloudAuthorizationUI();


    updateCloudStatus();


    /*
      Worker Root 是公開的。

      testCloudConnection() 會：

      1. 檢查 Worker
      2. 檢查版本
      3. 沒 Token → Local-only
      4. 有 Token → /api/auth/check
    */

    const cloud =
      await testCloudConnection();


    cloudState =
      cloud;


    updateCloudStatus();


    updateCloudAuthorizationUI();


    await updateSyncStatusUI();


    /*
      V2.3.0

      首次 Auto Sync 必須同時滿足：

      - Online
      - Cloud Authorized
      - Auto Sync ON
    */

    if (
      navigator.onLine &&
      cloud.authorized ===
        true &&
      getAutoSyncEnabled()
    ) {

      await syncNow();

    }


    /*
      預設顯示 Footprint。
    */

    activateTab(
      "footprint"
    );


    await updateSyncStatusUI();

  }
  catch (
    error
  ) {

    showStartupError(
      error
    );

  }

}


/* =========================================================
   START
========================================================= */

init();
