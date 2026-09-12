/* =========================================================
   Travel Toolkit V2.2.0 Modular
   File: js/expense.js
   Modified: 2026-09-12

   Changes:
   - 從 V2.1.2 抽離 Expense CRUD
   - 不直接處理 D1
   - 透過 api-sync.js saveAndSync / deleteAndSync
   - 使用 event delegation
========================================================= */

import {

  STORE_EXPENSES

} from "./config.js";


import {

  dbGet,
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

let expenses =
  [];


let trips =
  [];


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

export function initExpenseModule(
  options = {}
) {

  hooks = {

    ...hooks,

    ...options

  };


  bindExpenseEvents();

}


/* =========================================================
   SET DATA
========================================================= */

export function setExpenseData(
  data = {}
) {

  expenses =
    data.expenses ||
    [];


  trips =
    data.trips ||
    [];

}


/* =========================================================
   HELPERS
========================================================= */

function pad(
  value
) {

  return String(
    value
  )
  .padStart(
    2,
    "0"
  );

}


function getLocalDate() {

  const now =
    new Date();


  return (
    now.getFullYear() +
    "-" +
    pad(
      now.getMonth() +
      1
    ) +
    "-" +
    pad(
      now.getDate()
    )
  );

}


function getLocalTime() {

  const now =
    new Date();


  return (
    pad(
      now.getHours()
    ) +
    ":" +
    pad(
      now.getMinutes()
    )
  );

}


function getTimezoneInfo() {

  const now =
    new Date();


  const timezone =

    Intl.DateTimeFormat()
      .resolvedOptions()
      .timeZone ||
    "";


  const offsetMinutes =
    -now.getTimezoneOffset();


  const sign =
    offsetMinutes >=
    0
      ? "+"
      : "-";


  const abs =
    Math.abs(
      offsetMinutes
    );


  const hours =
    pad(
      Math.floor(
        abs /
        60
      )
    );


  const minutes =
    pad(
      abs %
      60
    );


  return {

    timezone,

    timezone_offset:
      `${sign}${hours}:${minutes}`

  };

}


function combineLocalDateTime(
  dateValue,
  timeValue
) {

  if (
    !dateValue
  ) {

    return new Date()
      .toISOString();

  }


  const safeTime =
    timeValue ||
    "00:00";


  const localDate =
    new Date(
      `${dateValue}T${safeTime}:00`
    );


  return localDate
    .toISOString();

}


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
   TRIP NAME
========================================================= */

function getTripName(
  clientUid
) {

  if (
    !clientUid
  ) {

    return "未分類旅程";

  }


  const trip =
    trips.find(
      item =>
        item.client_uid ===
        clientUid
    );


  return (
    trip?.name ||
    "未分類旅程"
  );

}


/* =========================================================
   SYNC BADGE
========================================================= */

function syncBadgeHtml(
  status
) {

  const map = {

    synced: {
      icon:
        "☁️",

      text:
        "已同步"
    },

    pending: {
      icon:
        "⏳",

      text:
        "待同步"
    },

    syncing: {
      icon:
        "🔄",

      text:
        "同步中"
    },

    error: {
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
   RESET FORM
========================================================= */

export function resetExpenseForm() {

  document
    .getElementById(
      "expenseEditingUid"
    )
    .value =
    "";


  document
    .getElementById(
      "expenseDate"
    )
    .value =
    getLocalDate();


  document
    .getElementById(
      "expenseTime"
    )
    .value =
    getLocalTime();


  document
    .getElementById(
      "expenseCategory"
    )
    .value =
    "";


  document
    .getElementById(
      "expenseSubcategory"
    )
    .value =
    "";


  document
    .getElementById(
      "expenseTitle"
    )
    .value =
    "";


  document
    .getElementById(
      "expenseAmount"
    )
    .value =
    "";


  document
    .getElementById(
      "expenseCurrency"
    )
    .value =
    "TWD";


  document
    .getElementById(
      "expensePaymentMethod"
    )
    .value =
    "";


  document
    .getElementById(
      "expensePayer"
    )
    .value =
    "";


  document
    .getElementById(
      "expenseNote"
    )
    .value =
    "";


  document
    .getElementById(
      "saveExpenseButton"
    )
    .textContent =
    "💰 儲存消費";


  document
    .getElementById(
      "cancelExpenseEditButton"
    )
    .style.display =
    "none";

}


/* =========================================================
   SAVE
========================================================= */

async function saveExpense() {

  const title =
    document
      .getElementById(
        "expenseTitle"
      )
      .value
      .trim();


  const amountText =
    document
      .getElementById(
        "expenseAmount"
      )
      .value;


  const amount =
    Number(
      amountText
    );


  if (
    !title
  ) {

    hooks.showMessage(
      "請輸入消費項目",
      "error"
    );

    return;

  }


  if (
    !amountText ||
    Number.isNaN(
      amount
    )
  ) {

    hooks.showMessage(
      "請輸入正確金額",
      "error"
    );

    return;

  }


  const editingUid =
    document
      .getElementById(
        "expenseEditingUid"
      )
      .value;


  const old =
    editingUid
      ? await dbGet(
          STORE_EXPENSES,
          editingUid
        )
      : null;


  const date =
    document
      .getElementById(
        "expenseDate"
      )
      .value;


  const time =
    document
      .getElementById(
        "expenseTime"
      )
      .value;


  const timezoneInfo =
    getTimezoneInfo();


  const record = {

    ...old,

    client_uid:
      editingUid ||
      createUID(),

    trip_client_uid:
      document
        .getElementById(
          "expenseTrip"
        )
        .value ||
      null,

    recorded_at:
      combineLocalDateTime(
        date,
        time
      ),

    timezone:
      timezoneInfo.timezone,

    timezone_offset:
      timezoneInfo.timezone_offset,

    category:
      document
        .getElementById(
          "expenseCategory"
        )
        .value
        .trim() ||
      null,

    subcategory:
      document
        .getElementById(
          "expenseSubcategory"
        )
        .value
        .trim() ||
      null,

    title,

    amount,

    currency:
      document
        .getElementById(
          "expenseCurrency"
        )
        .value ||
      "TWD",

    payment_method:
      document
        .getElementById(
          "expensePaymentMethod"
        )
        .value
        .trim() ||
      null,

    payer:
      document
        .getElementById(
          "expensePayer"
        )
        .value
        .trim() ||
      null,

    note:
      document
        .getElementById(
          "expenseNote"
        )
        .value
        .trim() ||
      null,

    /*
      手動消費紀錄
    */

    source_type:
      old?.source_type ||
      null,

    source_client_uid:
      old?.source_client_uid ||
      null,

    deleted_at:
      null

  };


  await saveAndSync(
    "expenses",
    record
  );


  resetExpenseForm();


  hooks.requestRefresh();


  hooks.showToast(

    getAutoSyncEnabled()

      ? "💰 已存 Local，正在同步 D1"

      : "💰 已存 Local，等待手動同步"

  );

}


/* =========================================================
   EDIT
========================================================= */

export function editExpense(
  clientUid
) {

  const expense =
    expenses.find(
      item =>
        item.client_uid ===
        clientUid
    );


  if (
    !expense
  ) {

    return;

  }


  const date =
    new Date(
      expense.recorded_at
    );


  const localDate =
    date.getFullYear() +
    "-" +
    pad(
      date.getMonth() +
      1
    ) +
    "-" +
    pad(
      date.getDate()
    );


  const localTime =
    pad(
      date.getHours()
    ) +
    ":" +
    pad(
      date.getMinutes()
    );


  document
    .getElementById(
      "expenseEditingUid"
    )
    .value =
    expense.client_uid;


  document
    .getElementById(
      "expenseTrip"
    )
    .value =
    expense.trip_client_uid ||
    "";


  document
    .getElementById(
      "expenseDate"
    )
    .value =
    localDate;


  document
    .getElementById(
      "expenseTime"
    )
    .value =
    localTime;


  document
    .getElementById(
      "expenseCategory"
    )
    .value =
    expense.category ||
    "";


  document
    .getElementById(
      "expenseSubcategory"
    )
    .value =
    expense.subcategory ||
    "";


  document
    .getElementById(
      "expenseTitle"
    )
    .value =
    expense.title ||
    "";


  document
    .getElementById(
      "expenseAmount"
    )
    .value =
    expense.amount ??
    "";


  document
    .getElementById(
      "expenseCurrency"
    )
    .value =
    expense.currency ||
    "TWD";


  document
    .getElementById(
      "expensePaymentMethod"
    )
    .value =
    expense.payment_method ||
    "";


  document
    .getElementById(
      "expensePayer"
    )
    .value =
    expense.payer ||
    "";


  document
    .getElementById(
      "expenseNote"
    )
    .value =
    expense.note ||
    "";


  document
    .getElementById(
      "saveExpenseButton"
    )
    .textContent =
    "💾 儲存修改";


  document
    .getElementById(
      "cancelExpenseEditButton"
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
   DELETE
========================================================= */

export async function deleteExpense(
  clientUid
) {

  const expense =
    expenses.find(
      item =>
        item.client_uid ===
        clientUid
    );


  if (
    !expense
  ) {

    return;

  }


  const confirmed =
    await hooks.confirmDialog(

      "刪除消費",

      "確定要刪除這筆消費？\n\n💰 " +
      (
        expense.title ||
        ""
      )

    );


  if (
    !confirmed
  ) {

    return;

  }


  await deleteAndSync(
    "expenses",
    clientUid
  );


  hooks.requestRefresh();


  hooks.showToast(
    "🗑️ 消費紀錄已刪除"
  );

}


/* =========================================================
   FILTER / SORT
========================================================= */

function getDisplayExpenses() {

  return expenses
    .slice()
    .sort(
      (
        a,
        b
      ) =>

        new Date(
          b.recorded_at
        ) -

        new Date(
          a.recorded_at
        )

    );

}


/* =========================================================
   FORMAT DATE
========================================================= */

function formatRecordedAt(
  value
) {

  if (
    !value
  ) {

    return "";

  }


  const date =
    new Date(
      value
    );


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return value;

  }


  return (

    date.getFullYear() +
    "/" +
    pad(
      date.getMonth() +
      1
    ) +
    "/" +
    pad(
      date.getDate()
    ) +
    " " +
    pad(
      date.getHours()
    ) +
    ":" +
    pad(
      date.getMinutes()
    )

  );

}


/* =========================================================
   FORMAT AMOUNT
========================================================= */

function formatAmount(
  amount
) {

  const value =
    Number(
      amount
    );


  if (
    Number.isNaN(
      value
    )
  ) {

    return amount;

  }


  return new Intl.NumberFormat()
    .format(
      value
    );

}


/* =========================================================
   RENDER
========================================================= */

export function renderExpenses() {

  const container =
    document.getElementById(
      "expenseList"
    );


  if (
    !container
  ) {

    return;

  }


  const records =
    getDisplayExpenses();


  if (
    !records.length
  ) {

    container.innerHTML = `

      <div class="empty">
        尚無消費紀錄
      </div>

    `;

    return;

  }


  container.innerHTML =
    records
      .map(
        expense => `

          <div
            class="record"
            data-expense-uid="${escapeHtml(
              expense.client_uid
            )}"
          >

            <div class="record-title">

              💰

              ${escapeHtml(
                expense.title ||
                "未命名消費"
              )}

              ${syncBadgeHtml(
                expense.sync_status
              )}

            </div>


            <div class="record-meta">

              🧳
              ${escapeHtml(
                getTripName(
                  expense.trip_client_uid
                )
              )}

              <br>

              🕒
              ${escapeHtml(
                formatRecordedAt(
                  expense.recorded_at
                )
              )}

              <br>

              ${
                expense.category
                  ? "📂 " +
                    escapeHtml(
                      expense.category
                    )
                  : ""
              }

              ${
                expense.subcategory
                  ? " / " +
                    escapeHtml(
                      expense.subcategory
                    )
                  : ""
              }

            </div>


            <div
              class="record-amount"
              style="
                font-size:18px;
                font-weight:700;
                margin-top:8px;
              "
            >

              ${escapeHtml(
                expense.currency ||
                ""
              )}

              ${escapeHtml(
                formatAmount(
                  expense.amount
                )
              )}

            </div>


            ${
              expense.payment_method ||
              expense.payer

                ? `

                  <div class="record-meta">

                    ${
                      expense.payment_method
                        ? "💳 " +
                          escapeHtml(
                            expense.payment_method
                          )
                        : ""
                    }

                    ${
                      expense.payer
                        ? "　👤 " +
                          escapeHtml(
                            expense.payer
                          )
                        : ""
                    }

                  </div>

                `

                : ""
            }


            ${
              expense.source_type ===
              "food"

                ? `

                  <div class="record-meta">
                    🍜 由美食紀錄建立
                  </div>

                `

                : ""
            }


            ${
              expense.note

                ? `

                  <div class="record-note">

                    ${escapeHtml(
                      expense.note
                    )}

                  </div>

                `

                : ""
            }


            <div class="record-actions">

              <button
                type="button"
                class="btn-gray"
                data-action="edit-expense"
                data-client-uid="${escapeHtml(
                  expense.client_uid
                )}"
              >
                ✏️ 編輯
              </button>


              <button
                type="button"
                class="btn-soft-red"
                data-action="delete-expense"
                data-client-uid="${escapeHtml(
                  expense.client_uid
                )}"
              >
                🗑️ 刪除
              </button>

            </div>

          </div>

        `
      )
      .join(
        ""
      );

}


/* =========================================================
   BIND EVENTS
========================================================= */

let eventsBound =
  false;


function bindExpenseEvents() {

  if (
    eventsBound
  ) {

    return;

  }


  eventsBound =
    true;


  document
    .getElementById(
      "saveExpenseButton"
    )
    ?.addEventListener(
      "click",
      saveExpense
    );


  document
    .getElementById(
      "cancelExpenseEditButton"
    )
    ?.addEventListener(
      "click",
      resetExpenseForm
    );


  document
    .getElementById(
      "expenseList"
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
          "edit-expense"
        ) {

          editExpense(
            clientUid
          );

        }


        if (
          action ===
          "delete-expense"
        ) {

          deleteExpense(
            clientUid
          );

        }

      }
    );

}
