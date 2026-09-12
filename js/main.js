/* =========================================================
   Travel Toolkit V2.2.0 Modular
   File: js/main.js
   Modified: 2026-09-12

   Changes:
   - V2.2.0 Modular 總控
   - 初始化 IndexedDB
   - 載入 Local cache
   - 分發資料到 Footprint / Food / Expense / Trip
   - 管理 Sync UI / Header
   - 管理 Auto Sync Toggle / Manual Sync
   - 管理 Tabs / Toast / Confirm Dialog
   - 不重複實作各功能模組邏輯
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

  /*
    V2.2.0 先維持簡單 alert。
    後續若要升級 UI，
    只改這裡即可。
  */

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
    但 IndexedDB 裡仍保留完整資料供 backup/sync。
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


  if (
    !navigator.onLine
  ) {

    status.className =
      "status-pill muted";


    status.textContent =
      "☁️ D1 離線";

    return;

  }


  if (
    cloudState.ok
  ) {

    if (
      cloudState.version ===
      EXPECTED_API_VERSION
    ) {

      status.className =
        "status-pill success";


      status.textContent =
        `🟢 D1 ${cloudState.version}`;

    }
    else {

      status.className =
        "status-pill warning";


      status.textContent =

        `🟠 D1 ${cloudState.version || "?"}`;

    }


    return;

  }


  status.className =
    "status-pill danger";


  status.textContent =
    "🔴 D1 連線失敗";

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
    description
  ) {

    description.textContent =

      getAutoSyncEnabled()

        ? "開啟：新增、修改、刪除會先存 Local，再自動同步到 D1。"

        : "關閉：資料只先存 Local。GPS、地址、Nearby 等網路功能仍可正常使用；需要時可按「立即同步 D1」。";

  }

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

    if (
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
            "sync-error"
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

        },


      onDataChanged:
        () => {

          /*
            不 await，避免 sync engine 被 UI render 卡住。
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


  showToast(

    enabled

      ? "☁️ D1 自動同步已開啟"

      : "📱 已切換 Local 模式"

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
        "error"
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


  window.addEventListener(
    "online",
    () => {

      updateNetworkStatus();

    }
  );


  window.addEventListener(
    "offline",
    () => {

      updateNetworkStatus();

      updateCloudStatus();

      updateSyncStatusUI();

    }
  );


  document.addEventListener(
    "visibilitychange",
    () => {

      if (
        document.visibilityState !==
        "visible"
      ) {

        return;

      }


      /*
        回到頁面：
        Auto Sync ON 才背景同步。
      */

      if (
        navigator.onLine &&
        getAutoSyncEnabled()
      ) {

        syncNow();

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


    bindTabs();


    bindConfirmEvents();


    bindGeneralEvents();


    setupSyncHooks();


    /*
      先初始化模組 DOM event。
    */

    initializeFeatureModules();


    /*
      開 DB。
    */

    await openLocalDB();


    /*
      載入 Auto Sync 設定。
    */

    await loadAutoSyncSetting();


    updateAutoSyncDescription();


    /*
      修復上一輪被中斷的 syncing。
    */

    await recoverInterruptedSync();


    /*
      Local-first：
      先顯示 Local。
    */

    await renderAll();


    /*
      初始化表單。
      放在 Local render 後，
      因為 Trip Select 此時才有 options。
    */

    initializeForms();


    /*
      即使 Auto Sync OFF，
      仍測 Worker 狀態。
    */

    const cloud =
      await testCloudConnection();


    /*
      Auto Sync ON 才進行首次同步。
    */

    if (
      navigator.onLine &&
      cloud.ok &&
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
