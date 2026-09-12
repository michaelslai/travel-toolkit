/* =========================================================
   Travel Toolkit V2.2.0 Modular
   File: js/trip.js
   Modified: 2026-09-12

   Changes:
   - 從 V2.1.2 抽離 Trip CRUD
   - 不直接處理 D1
   - 透過 api-sync.js 的 saveAndSync / deleteAndSync
   - 保留刪除旅程後，相關資料移至未分類旅程
========================================================= */

import {

  STORE_TRIPS

} from "./config.js";


import {

  dbGet,
  saveLocalRecord,
  createUID

} from "./db.js";


import {

  saveAndSync,
  deleteAndSync,
  getAutoSyncEnabled

} from "./api-sync.js";


/* =========================================================
   MODULE STATE
========================================================= */

let trips =
  [];

let footprints =
  [];

let foodRecords =
  [];

let expenses =
  [];


/* =========================================================
   UI CALLBACKS
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

export function initTripModule(
  options = {}
) {

  hooks = {

    ...hooks,

    ...options

  };


  bindTripEvents();

}


/* =========================================================
   SET DATA
========================================================= */

export function setTripData(
  data = {}
) {

  trips =
    data.trips ||
    [];


  footprints =
    data.footprints ||
    [];


  foodRecords =
    data.foodRecords ||
    [];


  expenses =
    data.expenses ||
    [];

}


/* =========================================================
   RESET FORM
========================================================= */

export function resetTripForm() {

  document
    .getElementById(
      "tripEditingUid"
    )
    .value =
    "";


  document
    .getElementById(
      "tripName"
    )
    .value =
    "";


  const now =
    new Date();


  const pad =
    value =>
      String(
        value
      )
      .padStart(
        2,
        "0"
      );


  document
    .getElementById(
      "tripStart"
    )
    .value =

    now.getFullYear() +
    "-" +
    pad(
      now.getMonth() +
      1
    ) +
    "-" +
    pad(
      now.getDate()
    );


  document
    .getElementById(
      "tripEnd"
    )
    .value =
    "";


  document
    .getElementById(
      "tripNote"
    )
    .value =
    "";


  document
    .getElementById(
      "saveTripButton"
    )
    .textContent =
    "🧳 儲存旅程";


  document
    .getElementById(
      "cancelTripEditButton"
    )
    .style.display =
    "none";

}


/* =========================================================
   SAVE TRIP
========================================================= */

async function saveTrip() {

  const name =
    document
      .getElementById(
        "tripName"
      )
      .value
      .trim();


  if (
    !name
  ) {

    hooks.showMessage(
      "請輸入旅程名稱",
      "error"
    );

    return;

  }


  const editingUid =
    document
      .getElementById(
        "tripEditingUid"
      )
      .value;


  const old =
    editingUid
      ? await dbGet(
          STORE_TRIPS,
          editingUid
        )
      : null;


  const record = {

    ...old,

    client_uid:
      editingUid ||
      createUID(),

    name,

    start_date:
      document
        .getElementById(
          "tripStart"
        )
        .value ||
      null,

    end_date:
      document
        .getElementById(
          "tripEnd"
        )
        .value ||
      null,

    note:
      document
        .getElementById(
          "tripNote"
        )
        .value
        .trim() ||
      null,

    deleted_at:
      null

  };


  await saveAndSync(
    "trips",
    record
  );


  resetTripForm();


  hooks.requestRefresh();


  hooks.showToast(

    getAutoSyncEnabled()

      ? "🧳 已存 Local，正在同步 D1"

      : "🧳 已存 Local，等待手動同步"

  );

}


/* =========================================================
   EDIT TRIP
========================================================= */

export function editTrip(
  clientUid
) {

  const trip =
    trips.find(
      item =>
        item.client_uid ===
        clientUid
    );


  if (
    !trip
  ) {

    return;

  }


  document
    .getElementById(
      "tripEditingUid"
    )
    .value =
    trip.client_uid;


  document
    .getElementById(
      "tripName"
    )
    .value =
    trip.name ||
    "";


  document
    .getElementById(
      "tripStart"
    )
    .value =
    trip.start_date ||
    "";


  document
    .getElementById(
      "tripEnd"
    )
    .value =
    trip.end_date ||
    "";


  document
    .getElementById(
      "tripNote"
    )
    .value =
    trip.note ||
    "";


  document
    .getElementById(
      "saveTripButton"
    )
    .textContent =
    "💾 儲存修改";


  document
    .getElementById(
      "cancelTripEditButton"
    )
    .style.display =
    "block";


  window.scrollTo(
    {
      top:
        0,

      behavior:
        "smooth"
    }
  );

}


/* =========================================================
   DELETE TRIP
========================================================= */

export async function deleteTrip(
  clientUid
) {

  const trip =
    trips.find(
      item =>
        item.client_uid ===
        clientUid
    );


  if (
    !trip
  ) {

    return;

  }


  const confirmed =
    await hooks.confirmDialog(

      "刪除旅程",

      "確定要刪除旅程？\n\n🧳 " +
      trip.name +
      "\n\n足跡、美食與消費不會刪除，會移到未分類旅程。"

    );


  if (
    !confirmed
  ) {

    return;

  }


  const related = [

    [
      "footprints",
      footprints
    ],

    [
      "food_records",
      foodRecords
    ],

    [
      "expenses",
      expenses
    ]

  ];


  /*
    先將相關資料解除 Trip 關聯。
  */

  for (
    const [
      entity,
      list
    ] of
    related
  ) {

    const records =
      list.filter(
        item =>
          item.trip_client_uid ===
          clientUid
      );


    for (
      const record of
      records
    ) {

      await saveLocalRecord(
        entity,
        {

          ...record,

          trip_client_uid:
            null

        }
      );

    }

  }


  /*
    再 soft delete Trip。
  */

  await deleteAndSync(
    "trips",
    clientUid
  );


  hooks.requestRefresh();


  hooks.showToast(
    "🗑️ 旅程已刪除，紀錄移至未分類"
  );

}


/* =========================================================
   TRIP COUNTS
========================================================= */

function getTripCounts(
  clientUid
) {

  return {

    footprints:
      footprints.filter(
        item =>
          item.trip_client_uid ===
          clientUid
      )
      .length,

    food:
      foodRecords.filter(
        item =>
          item.trip_client_uid ===
          clientUid
      )
      .length,

    expenses:
      expenses.filter(
        item =>
          item.trip_client_uid ===
          clientUid
      )
      .length

  };

}


/* =========================================================
   ESCAPE HTML
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
   SYNC BADGE
========================================================= */

function syncBadgeHtml(
  status
) {

  const map = {

    synced:
      {
        icon:
          "☁️",

        text:
          "已同步"
      },

    pending:
      {
        icon:
          "⏳",

        text:
          "待同步"
      },

    syncing:
      {
        icon:
          "🔄",

        text:
          "同步中"
      },

    error:
      {
        icon:
          "⚠️",

        text:
          "同步失敗"
      }

  };


  const info =
    map[
      status
    ] ||
    map.synced;


  return `

    <span
      class="sync-badge ${status || "synced"}"
    >
      ${info.icon}
      ${info.text}
    </span>

  `;

}


/* =========================================================
   RENDER TRIPS
========================================================= */

export function renderTrips() {

  const container =
    document.getElementById(
      "tripList"
    );


  if (
    !container
  ) {

    return;

  }


  if (
    !trips.length
  ) {

    container.innerHTML = `

      <div class="empty">
        尚未建立旅程
      </div>

    `;

    return;

  }


  const sortedTrips =
    trips
      .slice()
      .sort(
        (
          a,
          b
        ) =>
          String(
            b.start_date ||
            ""
          )
          .localeCompare(
            String(
              a.start_date ||
              ""
            )
          )
      );


  container.innerHTML =
    sortedTrips
      .map(
        trip => {

          const counts =
            getTripCounts(
              trip.client_uid
            );


          return `

            <div
              class="record"
              data-trip-uid="${escapeHtml(
                trip.client_uid
              )}"
            >

              <div class="record-title">

                🧳
                ${escapeHtml(
                  trip.name
                )}

                ${syncBadgeHtml(
                  trip.sync_status
                )}

              </div>


              <div class="record-meta">

                📅
                ${escapeHtml(
                  trip.start_date ||
                  "未設定"
                )}

                ${
                  trip.end_date
                    ? " ～ " +
                      escapeHtml(
                        trip.end_date
                      )
                    : ""
                }

                <br>

                📍
                ${counts.footprints}

                　

                🍜
                ${counts.food}

                　

                💰
                ${counts.expenses}

              </div>


              ${
                trip.note
                  ? `

                    <div class="record-note">

                      ${escapeHtml(
                        trip.note
                      )}

                    </div>

                  `
                  : ""
              }


              <div class="record-actions">

                <button
                  class="btn-gray"
                  type="button"
                  data-action="edit-trip"
                  data-client-uid="${escapeHtml(
                    trip.client_uid
                  )}"
                >
                  ✏️ 編輯
                </button>


                <button
                  class="btn-soft-red"
                  type="button"
                  data-action="delete-trip"
                  data-client-uid="${escapeHtml(
                    trip.client_uid
                  )}"
                >
                  🗑️ 刪除
                </button>

              </div>

            </div>

          `;

        }
      )
      .join(
        ""
      );

}


/* =========================================================
   TRIP SELECT OPTIONS
========================================================= */

export function getTripOptionsHtml() {

  const sortedTrips =
    trips
      .slice()
      .sort(
        (
          a,
          b
        ) =>
          String(
            b.start_date ||
            ""
          )
          .localeCompare(
            String(
              a.start_date ||
              ""
            )
          )
      );


  return (

    `
      <option value="">
        未分類旅程
      </option>
    ` +

    sortedTrips
      .map(
        trip => `

          <option
            value="${escapeHtml(
              trip.client_uid
            )}"
          >
            ${escapeHtml(
              trip.name
            )}
          </option>

        `
      )
      .join(
        "")

  );

}


/* =========================================================
   BIND EVENTS
========================================================= */

let eventsBound =
  false;


function bindTripEvents() {

  if (
    eventsBound
  ) {

    return;

  }


  eventsBound =
    true;


  document
    .getElementById(
      "saveTripButton"
    )
    ?.addEventListener(
      "click",
      saveTrip
    );


  document
    .getElementById(
      "cancelTripEditButton"
    )
    ?.addEventListener(
      "click",
      resetTripForm
    );


  /*
    Event delegation：

    不再使用 onclick="..."
    方便 ES Module。
  */

  document
    .getElementById(
      "tripList"
    )
    ?.addEventListener(
      "click",
      event => {

        const button =
          event.target.closest(
            "button[data-action]"
          );


        if (
          !button
        ) {

          return;

        }


        const action =
          button.dataset.action;


        const clientUid =
          button.dataset.clientUid;


        if (
          action ===
          "edit-trip"
        ) {

          editTrip(
            clientUid
          );

        }


        if (
          action ===
          "delete-trip"
        ) {

          deleteTrip(
            clientUid
          );

        }

      }
    );

}
