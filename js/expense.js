/* ===== START PART 1/4 ===== */


/* =========================================================
   Travel Toolkit V2.5.1 Modular
   File: js/expense.js
   Modified: 2026-09-14

   【V2.5.1 Expense Summary Trip Selector】
   - 消費統計「目前旅程」改成獨立下拉選單
   - 新增 expenseSummaryTripSelect
   - 查看統計不再影響新增消費表單 expenseTrip
   - setExpenseData() 更新 trips 後同步刷新統計旅程選單
   - 保留 Expense V2.5.0 所有功能
   - 保留 Food ↔ Expense amount / currency 關聯
   - 保留 Local-first + D1 Sync
   - IndexedDB schema 不變
   - D1 schema 不變

   V2.5.0:
   - 付款方式固定選單
   - 幣別只使用 TWD / JPY
   - 新增付款人管理
   - 新增全部 / 旅程 / 今日統計
   - 新增日期分組與折疊

   V2.2.4:
   - 強化 Expense → Food 雙向關聯
   - 反向只同步 amount / currency
========================================================= */


import {

  STORE_EXPENSES,
  STORE_FOOD

} from "./config.js";


import {

  dbGet,
  dbGetAll,
  createUID

} from "./db.js";


import {

  saveAndSync,
  deleteAndSync,
  getAutoSyncEnabled

} from "./api-sync.js";


/* =========================================================
   CONSTANTS
========================================================= */

const EXPENSE_PAYER_STORAGE_KEY =
  "travelToolkitExpensePayers";


const DEFAULT_EXPENSE_PAYERS = [

  "阿宏",
  "阿瑄"

];


const ALLOWED_PAYMENT_METHODS = [

  "現金",
  "信用卡",
  "Suica",
  "福岡交通卡",
  "PayPay"

];


const ALLOWED_CURRENCIES = [

  "TWD",
  "JPY"

];


/* =========================================================
   MODULE STATE
========================================================= */

let expenses =
  [];


let trips =
  [];


let expensePayers =
  [];


const collapsedExpenseDates =
  new Set();


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


  loadExpensePayers();

  renderExpensePayerOptions();

  renderExpensePayerManageList();

  renderExpenseSummaryTripOptions();

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


  mergePayersFromExpenses();


  renderExpensePayerOptions();

  renderExpensePayerManageList();


  /*
     V2.5.1：
     trips 更新後，
     同步刷新「統計用旅程選單」。
  */
  renderExpenseSummaryTripOptions();

}


/* =========================================================
   BASIC HELPERS
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


/* =========================================================
   TIMEZONE
========================================================= */

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


/* =========================================================
   DATE + TIME
========================================================= */

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


/* =========================================================
   HTML ESCAPE
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
   V2.5.1 SUMMARY TRIP SELECTOR
========================================================= */

function renderExpenseSummaryTripOptions() {

  const select =
    document.getElementById(
      "expenseSummaryTripSelect"
    );


  if (
    !select
  ) {

    return;

  }


  const previousValue =
    select.value ||
    "";


  select.innerHTML = `

    <option value="">
      未分類旅程
    </option>

    ${trips
      .filter(
        trip =>
          !trip.deleted_at
      )
      .map(
        trip => `

          <option
            value="${escapeHtml(
              trip.client_uid
            )}"
          >
            ${escapeHtml(
              trip.name ||
              "未命名旅程"
            )}
          </option>

        `
      )
      .join(
        ""
      )}

  `;


  const exists =
    previousValue ===
      "" ||
    trips.some(
      trip =>
        trip.client_uid ===
        previousValue &&
        !trip.deleted_at
    );


  if (
    exists
  ) {

    select.value =
      previousValue;

  }
  else {

    select.value =
      "";

  }


  renderExpenseSummary();

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

    return String(
      amount ??
      ""
    );

  }


  return new Intl.NumberFormat()
    .format(
      value
    );

}


function formatCurrencyAmount(
  currency,
  amount
) {

  const value =
    formatAmount(
      amount
    );


  if (
    currency ===
    "JPY"
  ) {

    return `¥${value}`;

  }


  return `NT$${value}`;

}


/* =========================================================
   DATE HELPERS
========================================================= */

function getRecordLocalDate(
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

    return "";

  }


  return (

    date.getFullYear() +
    "-" +
    pad(
      date.getMonth() +
      1
    ) +
    "-" +
    pad(
      date.getDate()
    )

  );

}


function formatDateTitle(
  dateKey
) {

  if (
    !dateKey
  ) {

    return "日期不明";

  }


  const parts =
    dateKey.split(
      "-"
    );


  if (
    parts.length !==
    3
  ) {

    return dateKey;

  }


  return (
    `${parts[0]} / ` +
    `${parts[1]} / ` +
    `${parts[2]}`
  );

}


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
   PAYER MANAGEMENT
========================================================= */

function normalizePayerName(
  value
) {

  return String(
    value ??
    ""
  )
  .trim();

}


function uniquePayers(
  values
) {

  const result =
    [];


  const seen =
    new Set();


  for (
    const raw of
    values
  ) {

    const name =
      normalizePayerName(
        raw
      );


    if (
      !name
    ) {

      continue;

    }


    if (
      seen.has(
        name
      )
    ) {

      continue;

    }


    seen.add(
      name
    );


    result.push(
      name
    );

  }


  return result;

}


function loadExpensePayers() {

  let saved =
    [];


  try {

    const text =
      localStorage.getItem(
        EXPENSE_PAYER_STORAGE_KEY
      );


    if (
      text
    ) {

      const parsed =
        JSON.parse(
          text
        );


      if (
        Array.isArray(
          parsed
        )
      ) {

        saved =
          parsed;

      }

    }

  }
  catch (
    error
  ) {

    console.warn(
      "[EXPENSE] load payer settings failed",
      error
    );

  }


  expensePayers =
    uniquePayers(
      [
        ...DEFAULT_EXPENSE_PAYERS,
        ...saved
      ]
    );

}


function saveExpensePayers() {

  try {

    localStorage.setItem(

      EXPENSE_PAYER_STORAGE_KEY,

      JSON.stringify(
        expensePayers
      )

    );

  }
  catch (
    error
  ) {

    console.warn(
      "[EXPENSE] save payer settings failed",
      error
    );

  }

}


function mergePayersFromExpenses() {

  const recordPayers =
    expenses
      .map(
        item =>
          item?.payer
      )
      .filter(
        Boolean
      );


  const merged =
    uniquePayers(
      [
        ...expensePayers,
        ...recordPayers
      ]
    );


  if (
    merged.length !==
    expensePayers.length
  ) {

    expensePayers =
      merged;


    saveExpensePayers();

  }

}


function renderExpensePayerOptions(
  selectedValue = null
) {

  const select =
    document.getElementById(
      "expensePayer"
    );


  if (
    !select
  ) {

    return;

  }


  const previousValue =
    selectedValue !==
      null

      ? selectedValue

      : select.value;


  select.innerHTML =
    `

      <option value="">
        請選擇
      </option>

    ` +
    expensePayers
      .map(
        payer => `

          <option
            value="${escapeHtml(
              payer
            )}"
          >
            ${escapeHtml(
              payer
            )}
          </option>

        `
      )
      .join(
        ""
      );


  if (
    previousValue &&
    expensePayers.includes(
      previousValue
    )
  ) {

    select.value =
      previousValue;

  }
  else {

    select.value =
      "";

  }

}


function renderExpensePayerManageList() {

  const container =
    document.getElementById(
      "expensePayerManageList"
    );


  if (
    !container
  ) {

    return;

  }


  if (
    !expensePayers.length
  ) {

    container.innerHTML = `

      <div
        style="
          font-size:12px;
          color:#777;
        "
      >
        尚未建立付款人
      </div>

    `;


    return;

  }


  container.innerHTML =
    expensePayers
      .map(
        payer => `

          <div
            style="
              display:flex;
              align-items:center;
              justify-content:space-between;
              gap:10px;
              padding:8px 0;
              border-bottom:1px solid #e5e7eb;
            "
          >

            <span>
              👤 ${escapeHtml(
                payer
              )}
            </span>


            <button
              type="button"
              class="btn-soft-red"
              data-action="delete-expense-payer"
              data-payer="${escapeHtml(
                payer
              )}"
              style="
                padding:5px 9px;
                font-size:12px;
              "
            >
              刪除
            </button>

          </div>

        `
      )
      .join(
        ""
      );

}


function addExpensePayer() {

  const input =
    document.getElementById(
      "expenseNewPayer"
    );


  if (
    !input
  ) {

    return;

  }


  const payer =
    normalizePayerName(
      input.value
    );


  if (
    !payer
  ) {

    hooks.showMessage(
      "請輸入付款人名稱",
      "error"
    );


    return;

  }


  if (
    expensePayers.includes(
      payer
    )
  ) {

    renderExpensePayerOptions(
      payer
    );


    input.value =
      "";


    hooks.showToast(
      "👤 此付款人已存在"
    );


    return;

  }


  expensePayers =
    uniquePayers(
      [
        ...expensePayers,
        payer
      ]
    );


  saveExpensePayers();


  renderExpensePayerOptions(
    payer
  );


  renderExpensePayerManageList();


  input.value =
    "";


  hooks.showToast(
    "👤 已新增付款人：" +
    payer
  );

}


async function deleteExpensePayer(
  payer
) {

  const safePayer =
    normalizePayerName(
      payer
    );


  if (
    !safePayer
  ) {

    return;

  }


  const usedCount =
    expenses.filter(
      item =>
        item.payer ===
        safePayer
    )
    .length;


  let message =
    `確定要從付款人選單移除「${safePayer}」？`;


  if (
    usedCount >
    0
  ) {

    message +=

      `\n\n目前有 ${usedCount} 筆既有消費使用此付款人。` +
      `\n移除選單不會修改既有消費紀錄。`;

  }


  const confirmed =
    await hooks.confirmDialog(

      "刪除付款人",

      message

    );


  if (
    !confirmed
  ) {

    return;

  }


  expensePayers =
    expensePayers.filter(
      item =>
        item !==
        safePayer
    );


  saveExpensePayers();


  renderExpensePayerOptions();

  renderExpensePayerManageList();


  hooks.showToast(
    "👤 已從付款人選單移除：" +
    safePayer
  );

}


/* =========================================================
   VALIDATE SELECT VALUES
========================================================= */

function normalizeCurrency(
  value
) {

  if (
    ALLOWED_CURRENCIES.includes(
      value
    )
  ) {

    return value;

  }


  return "TWD";

}


function normalizePaymentMethod(
  value
) {

  if (
    ALLOWED_PAYMENT_METHODS.includes(
      value
    )
  ) {

    return value;

  }


  return "";

}


/* ===== END PART 1/4 ===== */

/* ===== START PART 2/4 ===== */


/* =========================================================
   FIND LINKED FOOD
========================================================= */

async function findLinkedFood(
  expenseRecord
) {

  if (
    !expenseRecord ||
    expenseRecord.source_type !==
      "food"
  ) {

    return null;

  }


  if (
    expenseRecord.source_client_uid
  ) {

    const food =
      await dbGet(
        STORE_FOOD,
        expenseRecord.source_client_uid
      );


    if (
      food
    ) {

      console.log(
        "[EXPENSE→FOOD] linked by client_uid",
        {

          expense_uid:
            expenseRecord.client_uid,

          food_uid:
            food.client_uid,

          food_cloud_id:
            food.cloud_id

        }
      );


      return food;

    }

  }


  if (
    expenseRecord.source_id !==
      null &&
    expenseRecord.source_id !==
      undefined
  ) {

    const allFoods =
      await dbGetAll(
        STORE_FOOD
      );


    const sourceId =
      Number(
        expenseRecord.source_id
      );


    const food =
      allFoods.find(
        item =>
          Number(
            item.cloud_id
          ) ===
          sourceId
      );


    if (
      food
    ) {

      console.log(
        "[EXPENSE→FOOD] linked by cloud_id",
        {

          expense_uid:
            expenseRecord.client_uid,

          source_id:
            expenseRecord.source_id,

          food_uid:
            food.client_uid,

          food_cloud_id:
            food.cloud_id

        }
      );


      return food;

    }

  }


  console.warn(
    "[EXPENSE→FOOD] linked food not found",
    {

      expense_uid:
        expenseRecord.client_uid,

      source_type:
        expenseRecord.source_type,

      source_client_uid:
        expenseRecord.source_client_uid,

      source_id:
        expenseRecord.source_id

    }
  );


  return null;

}


/* =========================================================
   UPDATE LINKED FOOD

   只允許 Expense 回寫：
   - amount
   - currency
========================================================= */

async function updateLinkedFoodFromExpense(
  expenseRecord
) {

  if (
    !expenseRecord ||
    expenseRecord.source_type !==
      "food"
  ) {

    return false;

  }


  console.log(
    "[EXPENSE→FOOD] START",
    {

      expense_uid:
        expenseRecord.client_uid,

      amount:
        expenseRecord.amount,

      currency:
        expenseRecord.currency,

      source_client_uid:
        expenseRecord.source_client_uid,

      source_id:
        expenseRecord.source_id

    }
  );


  const linkedFood =
    await findLinkedFood(
      expenseRecord
    );


  if (
    !linkedFood
  ) {

    return false;

  }


  if (
    linkedFood.deleted_at
  ) {

    console.warn(
      "[EXPENSE→FOOD] food already deleted",
      {

        food_uid:
          linkedFood.client_uid

      }
    );


    return false;

  }


  const foodRecord = {

    ...linkedFood,

    amount:
      expenseRecord.amount,

    currency:
      expenseRecord.currency,

    deleted_at:
      null

  };


  console.log(
    "[EXPENSE→FOOD] BEFORE SAVE",
    {

      food_uid:
        foodRecord.client_uid,

      old_amount:
        linkedFood.amount,

      new_amount:
        foodRecord.amount,

      old_currency:
        linkedFood.currency,

      new_currency:
        foodRecord.currency,

      photo_local_length:
        linkedFood.photo_local
          ?.length ||
        0

    }
  );


  await saveAndSync(
    "food_records",
    foodRecord
  );


  const savedFood =
    await dbGet(
      STORE_FOOD,
      foodRecord.client_uid
    );


  console.log(
    "[EXPENSE→FOOD] AFTER SAVE",
    {

      food_uid:
        savedFood?.client_uid,

      amount:
        savedFood?.amount,

      currency:
        savedFood?.currency,

      sync_status:
        savedFood?.sync_status,

      photo_local_length:
        savedFood?.photo_local
          ?.length ||
        0

    }
  );


  return true;

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


  renderExpensePayerOptions(
    ""
  );


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
    ) ||
    amount <
      0
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


  const currency =
    normalizeCurrency(
      document
        .getElementById(
          "expenseCurrency"
        )
        .value
    );


  const paymentMethod =
    normalizePaymentMethod(
      document
        .getElementById(
          "expensePaymentMethod"
        )
        .value
    );


  const payer =
    normalizePayerName(
      document
        .getElementById(
          "expensePayer"
        )
        .value
    );


  if (
    payer &&
    !expensePayers.includes(
      payer
    )
  ) {

    expensePayers =
      uniquePayers(
        [
          ...expensePayers,
          payer
        ]
      );


    saveExpensePayers();

  }


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

    currency,

    payment_method:
      paymentMethod ||
      null,

    payer:
      payer ||
      null,

    note:
      document
        .getElementById(
          "expenseNote"
        )
        .value
        .trim() ||
      null,

    source_type:
      old?.source_type ||
      null,

    source_client_uid:
      old?.source_client_uid ||
      null,

    source_id:
      old?.source_id ??
      null,

    deleted_at:
      null

  };


  console.log(
    "[EXPENSE SAVE] BEFORE",
    {

      editingUid,

      is_edit:
        Boolean(
          editingUid
        ),

      old_source_type:
        old?.source_type,

      old_source_client_uid:
        old?.source_client_uid,

      old_source_id:
        old?.source_id,

      amount:
        record.amount,

      currency:
        record.currency,

      payment_method:
        record.payment_method,

      payer:
        record.payer

    }
  );


  await saveAndSync(
    "expenses",
    record
  );


  console.log(
    "[EXPENSE SAVE] EXPENSE SAVED",
    {

      expense_uid:
        record.client_uid,

      amount:
        record.amount,

      currency:
        record.currency,

      payment_method:
        record.payment_method,

      payer:
        record.payer,

      source_type:
        record.source_type,

      source_client_uid:
        record.source_client_uid,

      source_id:
        record.source_id

    }
  );


  let foodUpdated =
    false;


  if (
    record.source_type ===
    "food"
  ) {

    try {

      foodUpdated =
        await updateLinkedFoodFromExpense(
          record
        );

    }
    catch (
      error
    ) {

      console.error(
        "[EXPENSE→FOOD] UPDATE FAILED",
        error
      );


      hooks.showMessage(
        "消費已儲存，但美食金額回寫失敗：" +
        (
          error?.message ||
          error
        ),
        "error"
      );

    }

  }


  resetExpenseForm();


  renderExpensePayerOptions();

  renderExpensePayerManageList();


  hooks.requestRefresh();


  if (
    record.source_type ===
      "food" &&
    foodUpdated
  ) {

    hooks.showToast(

      getAutoSyncEnabled()

        ? "💰 已更新消費與美食，正在同步 D1"

        : "💰 已更新消費與美食，等待手動同步"

    );

  }
  else if (
    record.source_type ===
      "food" &&
    !foodUpdated
  ) {

    hooks.showToast(
      "⚠️ 消費已更新，但未找到對應美食紀錄"
    );

  }
  else {

    hooks.showToast(

      getAutoSyncEnabled()

        ? "💰 已存 Local，正在同步 D1"

        : "💰 已存 Local，等待手動同步"

    );

  }

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
    normalizeCurrency(
      expense.currency
    );


  document
    .getElementById(
      "expensePaymentMethod"
    )
    .value =
    normalizePaymentMethod(
      expense.payment_method
    );


  const oldPayer =
    normalizePayerName(
      expense.payer
    );


  if (
    oldPayer &&
    !expensePayers.includes(
      oldPayer
    )
  ) {

    expensePayers =
      uniquePayers(
        [
          ...expensePayers,
          oldPayer
        ]
      );


    saveExpensePayers();

  }


  renderExpensePayerOptions(
    oldPayer
  );


  renderExpensePayerManageList();


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
    .filter(
      item =>
        !item.deleted_at
    )
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
   GROUP BY DATE
========================================================= */

function groupExpensesByDate(
  records
) {

  const groups =
    new Map();


  for (
    const expense of
    records
  ) {

    const dateKey =
      getRecordLocalDate(
        expense.recorded_at
      ) ||
      "unknown";


    if (
      !groups.has(
        dateKey
      )
    ) {

      groups.set(
        dateKey,
        []
      );

    }


    groups
      .get(
        dateKey
      )
      .push(
        expense
      );

  }


  return Array.from(
    groups.entries()
  );

}


/* =========================================================
   CURRENCY TOTAL
========================================================= */

function calculateCurrencyTotals(
  records
) {

  let twd =
    0;


  let jpy =
    0;


  for (
    const expense of
    records
  ) {

    const amount =
      Number(
        expense.amount
      );


    if (
      Number.isNaN(
        amount
      )
    ) {

      continue;

    }


    if (
      expense.currency ===
      "JPY"
    ) {

      jpy +=
        amount;

    }
    else if (
      expense.currency ===
      "TWD"
    ) {

      twd +=
        amount;

    }

  }


  return {

    TWD:
      twd,

    JPY:
      jpy

  };

}


/* ===== END PART 2/4 ===== */

/* ===== START PART 3/4 ===== */


/* =========================================================
   SUMMARY TRIP
   V2.5.1：
   統計使用獨立 expenseSummaryTripSelect
========================================================= */

function getCurrentExpenseSummaryTripUid() {

  const select =
    document.getElementById(
      "expenseSummaryTripSelect"
    );


  if (
    !select
  ) {

    return "";

  }


  return select.value ||
    "";

}


/* =========================================================
   SUMMARY VALUE
========================================================= */

function setExpenseSummaryValue(
  elementId,
  currency,
  value
) {

  const element =
    document.getElementById(
      elementId
    );


  if (
    !element
  ) {

    return;

  }


  element.textContent =
    formatCurrencyAmount(
      currency,
      value
    );

}


/* =========================================================
   RENDER SUMMARY
========================================================= */

function renderExpenseSummary() {

  const records =
    getDisplayExpenses();


  /* ---------------------------------------------------------
     ALL
  --------------------------------------------------------- */

  const allTotals =
    calculateCurrencyTotals(
      records
    );


  setExpenseSummaryValue(
    "expenseSummaryAllTWD",
    "TWD",
    allTotals.TWD
  );


  setExpenseSummaryValue(
    "expenseSummaryAllJPY",
    "JPY",
    allTotals.JPY
  );


  /* ---------------------------------------------------------
     TODAY
  --------------------------------------------------------- */

  const today =
    getLocalDate();


  const todayRecords =
    records.filter(
      expense =>
        getRecordLocalDate(
          expense.recorded_at
        ) ===
        today
    );


  const todayTotals =
    calculateCurrencyTotals(
      todayRecords
    );


  setExpenseSummaryValue(
    "expenseSummaryTodayTWD",
    "TWD",
    todayTotals.TWD
  );


  setExpenseSummaryValue(
    "expenseSummaryTodayJPY",
    "JPY",
    todayTotals.JPY
  );


  /* ---------------------------------------------------------
     SELECTED TRIP
  --------------------------------------------------------- */

  const selectedTripUid =
    getCurrentExpenseSummaryTripUid();


  const tripRecords =
    records.filter(
      expense => {

        const expenseTripUid =
          expense.trip_client_uid ||
          "";


        return expenseTripUid ===
          selectedTripUid;

      }
    );


  const tripTotals =
    calculateCurrencyTotals(
      tripRecords
    );


  setExpenseSummaryValue(
    "expenseSummaryTripTWD",
    "TWD",
    tripTotals.TWD
  );


  setExpenseSummaryValue(
    "expenseSummaryTripJPY",
    "JPY",
    tripTotals.JPY
  );

}


/* =========================================================
   DAILY SUMMARY HTML
========================================================= */

function expenseDateSummaryHtml(
  records
) {

  const totals =
    calculateCurrencyTotals(
      records
    );


  const parts =
    [];


  parts.push(
    `${records.length} 筆`
  );


  if (
    totals.TWD !==
    0
  ) {

    parts.push(
      formatCurrencyAmount(
        "TWD",
        totals.TWD
      )
    );

  }


  if (
    totals.JPY !==
    0
  ) {

    parts.push(
      formatCurrencyAmount(
        "JPY",
        totals.JPY
      )
    );

  }


  if (
    totals.TWD ===
      0 &&
    totals.JPY ===
      0
  ) {

    parts.push(
      "NT$0"
    );

    parts.push(
      "¥0"
    );

  }


  return parts.join(
    " · "
  );

}


/* =========================================================
   EXPENSE RECORD HTML
========================================================= */

function expenseRecordHtml(
  expense
) {

  return `

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
          formatCurrencyAmount(
            expense.currency,
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

  `;

}


/* =========================================================
   EXPENSE DATE GROUP HTML
========================================================= */

function expenseDateGroupHtml(
  dateKey,
  records
) {

  const collapsed =
    collapsedExpenseDates.has(
      dateKey
    );


  const arrow =
    collapsed
      ? "▶"
      : "▼";


  return `

    <div
      class="card"
      data-expense-date-group="${escapeHtml(
        dateKey
      )}"
      style="
        padding:0;
        overflow:hidden;
      "
    >

      <button
        type="button"
        data-action="toggle-expense-date"
        data-date-key="${escapeHtml(
          dateKey
        )}"
        style="
          width:100%;
          border:0;
          background:#f6f7f9;
          padding:14px;
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px;
          text-align:left;
          cursor:pointer;
        "
      >

        <div>

          <div
            style="
              font-weight:700;
              font-size:15px;
            "
          >
            📅
            ${escapeHtml(
              formatDateTitle(
                dateKey
              )
            )}
          </div>


          <div
            style="
              margin-top:4px;
              color:#666;
              font-size:12px;
            "
          >
            ${escapeHtml(
              expenseDateSummaryHtml(
                records
              )
            )}
          </div>

        </div>


        <div
          style="
            font-size:18px;
            flex:0 0 auto;
          "
        >
          ${arrow}
        </div>

      </button>


      <div
        data-expense-date-body="${escapeHtml(
          dateKey
        )}"
        style="
          display:${collapsed ? "none" : "block"};
          padding:12px;
        "
      >

        ${records
          .map(
            expense =>
              expenseRecordHtml(
                expense
              )
          )
          .join(
            ""
          )}

      </div>

    </div>

  `;

}


/* =========================================================
   RENDER EXPENSES
========================================================= */

export function renderExpenses() {

  const container =
    document.getElementById(
      "expenseList"
    );


  /*
     即使沒有紀錄，
     統計也要更新為 0。
  */
  renderExpenseSummary();


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


  const groups =
    groupExpensesByDate(
      records
    );


  container.innerHTML =
    groups
      .map(
        (
          [
            dateKey,
            dateRecords
          ]
        ) =>
          expenseDateGroupHtml(
            dateKey,
            dateRecords
          )
      )
      .join(
        ""
      );

}


/* =========================================================
   TOGGLE DATE GROUP
========================================================= */

function toggleExpenseDate(
  dateKey
) {

  if (
    !dateKey
  ) {

    return;

  }


  if (
    collapsedExpenseDates.has(
      dateKey
    )
  ) {

    collapsedExpenseDates.delete(
      dateKey
    );

  }
  else {

    collapsedExpenseDates.add(
      dateKey
    );

  }


  renderExpenses();

}


/* =========================================================
   SUMMARY TRIP CHANGE
========================================================= */

function handleExpenseSummaryTripChange() {

  renderExpenseSummary();

}


/* =========================================================
   LEGACY DATA NOTE

   舊資料如果曾使用：
   - CNY
   - USD
   - KRW
   - 自訂付款方式

   顯示舊紀錄時仍保留原資料。

   但重新編輯並儲存時：
   - 幣別限制為 TWD / JPY
   - 付款方式限制為固定選單
========================================================= */


/* ===== END PART 3/4 ===== */

/* ===== START PART 4/4 ===== */


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


  /* ---------------------------------------------------------
     SAVE
  --------------------------------------------------------- */

  document
    .getElementById(
      "saveExpenseButton"
    )
    ?.addEventListener(
      "click",
      saveExpense
    );


  /* ---------------------------------------------------------
     CANCEL EDIT
  --------------------------------------------------------- */

  document
    .getElementById(
      "cancelExpenseEditButton"
    )
    ?.addEventListener(
      "click",
      resetExpenseForm
    );


  /* ---------------------------------------------------------
     V2.5.1 SUMMARY TRIP SELECTOR
  --------------------------------------------------------- */

  document
    .getElementById(
      "expenseSummaryTripSelect"
    )
    ?.addEventListener(
      "change",
      handleExpenseSummaryTripChange
    );


  /* ---------------------------------------------------------
     ADD PAYER
  --------------------------------------------------------- */

  document
    .getElementById(
      "addExpensePayerButton"
    )
    ?.addEventListener(
      "click",
      addExpensePayer
    );


  document
    .getElementById(
      "expenseNewPayer"
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


        addExpensePayer();

      }
    );


  /* ---------------------------------------------------------
     PAYER MANAGEMENT
  --------------------------------------------------------- */

  document
    .getElementById(
      "expensePayerManageList"
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


        if (
          action !==
          "delete-expense-payer"
        ) {

          return;

        }


        const payer =
          button.dataset.payer ||
          "";


        deleteExpensePayer(
          payer
        );

      }
    );


  /* ---------------------------------------------------------
     EXPENSE LIST
  --------------------------------------------------------- */

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


        /* -----------------------------------------------------
           EDIT
        ----------------------------------------------------- */

        if (
          action ===
          "edit-expense"
        ) {

          const clientUid =
            button.dataset.clientUid;


          if (
            !clientUid
          ) {

            return;

          }


          editExpense(
            clientUid
          );


          return;

        }


        /* -----------------------------------------------------
           DELETE
        ----------------------------------------------------- */

        if (
          action ===
          "delete-expense"
        ) {

          const clientUid =
            button.dataset.clientUid;


          if (
            !clientUid
          ) {

            return;

          }


          deleteExpense(
            clientUid
          );


          return;

        }


        /* -----------------------------------------------------
           DATE COLLAPSE
        ----------------------------------------------------- */

        if (
          action ===
          "toggle-expense-date"
        ) {

          const dateKey =
            button.dataset.dateKey;


          if (
            !dateKey
          ) {

            return;

          }


          toggleExpenseDate(
            dateKey
          );

        }

      }
    );

}


/* =========================================================
   END
========================================================= */


/* ===== END PART 4/4 ===== */
