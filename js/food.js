/* =========================================================
   Travel Toolkit V2.2.0 Modular
   File: js/food.js
   Modified: 2026-09-12

   Changes:
   - 從 V2.1.2 抽離 Food CRUD
   - 保留 Local-first
   - 保留 GPS / Reverse Geocode
   - 保留評分、推薦、餐別、分類
   - 保留 Food → Expense 關聯
   - 不直接處理 D1 Sync Engine
   - 使用 Event Delegation
========================================================= */

import {
  STORE_FOOD,
  STORE_EXPENSES
} from "./config.js";


import {
  dbGet,
  createUID
} from "./db.js";


import {
  api,
  saveAndSync,
  deleteAndSync,
  getAutoSyncEnabled
} from "./api-sync.js";


/* =========================================================
   MODULE STATE
========================================================= */

let foodRecords = [];
let expenses = [];
let trips = [];

let foodLocation = null;
let foodAddressDetails = null;
let foodRating = 0;


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

export function initFoodModule(
  options = {}
) {

  hooks = {
    ...hooks,
    ...options
  };


  bindFoodEvents();

}


/* =========================================================
   SET DATA
========================================================= */

export function setFoodData(
  data = {}
) {

  foodRecords =
    data.foodRecords ||
    [];


  expenses =
    data.expenses ||
    [];


  trips =
    data.trips ||
    [];

}


/* =========================================================
   DOM HELPER
========================================================= */

function getElement(
  id
) {

  return document
    .getElementById(
      id
    );

}


/* =========================================================
   TIME HELPERS
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
    offsetMinutes >= 0
      ? "+"
      : "-";


  const abs =
    Math.abs(
      offsetMinutes
    );


  return {

    timezone,

    timezone_offset:

      sign +

      pad(
        Math.floor(
          abs /
          60
        )
      ) +

      ":" +

      pad(
        abs %
        60
      )

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


  const date =
    new Date(

      `${dateValue}T${timeValue || "00:00"}:00`

    );


  return date
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
   TRIP
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
   GPS
========================================================= */

function getGPSPosition() {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      if (
        !navigator.geolocation
      ) {

        reject(
          new Error(
            "此瀏覽器不支援 GPS 定位"
          )
        );

        return;

      }


      navigator.geolocation
        .getCurrentPosition(

          resolve,

          reject,

          {
            enableHighAccuracy:
              true,

            timeout:
              20000,

            maximumAge:
              0
          }

        );

    }
  );

}


/* =========================================================
   FOOD GPS
========================================================= */

export async function getFoodGPS() {

  const button =
    getElement(
      "foodGpsButton"
    );


  const status =
    getElement(
      "foodGpsStatus"
    );


  if (
    button
  ) {

    button.disabled =
      true;


    button.textContent =
      "📡 定位中...";

  }


  if (
    status
  ) {

    status.textContent =
      "正在取得 GPS 位置...";

  }


  try {

    const position =
      await getGPSPosition();


    foodLocation = {

      latitude:
        position.coords.latitude,

      longitude:
        position.coords.longitude,

      accuracy:
        Math.round(
          position.coords.accuracy
        ),

      address:
        ""

    };


    if (
      status
    ) {

      status.textContent =

        `GPS ±${foodLocation.accuracy}m，正在取得地址...`;

    }


    try {

      const result =
        await api(

          "/api/reverse-geocode" +

          "?lat=" +
          encodeURIComponent(
            foodLocation.latitude
          ) +

          "&lon=" +
          encodeURIComponent(
            foodLocation.longitude
          )

        );


      foodLocation.address =

        result.address ||
        result.display_name ||
        "";


      foodAddressDetails =

        result.address_details ||
        result.addressDetails ||
        result.details ||
        null;

    }
    catch (
      error
    ) {

      console.warn(
        "Food reverse geocode failed:",
        error
      );


      foodAddressDetails =
        null;

    }


    if (
      status
    ) {

      status.innerHTML = `

        📍 GPS ±${foodLocation.accuracy}m

        ${
          foodLocation.address

            ? "<br>" +
              escapeHtml(
                foodLocation.address
              )

            : "<br>地址辨識失敗，但 GPS 已保留"
        }

      `;

    }


    hooks.showToast(
      "📍 美食位置已取得"
    );

  }
  catch (
    error
  ) {

    console.error(
      "Food GPS error:",
      error
    );


    let message =
      "無法取得 GPS 位置";


    if (
      error.code ===
      1
    ) {

      message =
        "定位權限被拒絕";

    }
    else if (
      error.code ===
      2
    ) {

      message =
        "目前無法取得 GPS 位置";

    }
    else if (
      error.code ===
      3
    ) {

      message =
        "GPS 定位逾時，請再試一次";

    }


    if (
      status
    ) {

      status.textContent =
        message;

    }


    hooks.showMessage(
      message,
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
        "📍 取得目前位置";

    }

  }

}


/* =========================================================
   RATING
========================================================= */

export function setFoodRating(
  rating
) {

  foodRating =
    Math.max(
      0,
      Math.min(
        5,
        Number(
          rating
        ) ||
        0
      )
    );


  renderFoodRating();

}


function renderFoodRating() {

  document
    .querySelectorAll(
      "[data-food-rating]"
    )
    .forEach(
      button => {

        const value =
          Number(
            button.dataset.foodRating
          );


        button.classList
          .toggle(
            "active",
            value <=
            foodRating
          );


        button.textContent =

          value <=
          foodRating

            ? "★"

            : "☆";

      }
    );

}


/* =========================================================
   RESET FORM
========================================================= */

export function resetFoodForm() {

  const editingUid =
    getElement(
      "foodEditingUid"
    );


  if (
    editingUid
  ) {

    editingUid.value =
      "";

  }


  const date =
    getElement(
      "foodDate"
    );


  if (
    date
  ) {

    date.value =
      getLocalDate();

  }


  const time =
    getElement(
      "foodTime"
    );


  if (
    time
  ) {

    time.value =
      getLocalTime();

  }


  const fields = [

    "foodShopName",
    "foodName",
    "foodAmount",
    "foodNote"

  ];


  fields.forEach(
    id => {

      const element =
        getElement(
          id
        );


      if (
        element
      ) {

        element.value =
          "";

      }

    }
  );


  const meal =
    getElement(
      "foodMealType"
    );


  if (
    meal
  ) {

    meal.value =
      "";

  }


  const category =
    getElement(
      "foodCategory"
    );


  if (
    category
  ) {

    category.value =
      "";

  }


  const currency =
    getElement(
      "foodCurrency"
    );


  if (
    currency
  ) {

    currency.value =
      "TWD";

  }


  const recommended =
    getElement(
      "foodRecommended"
    );


  if (
    recommended
  ) {

    recommended.checked =
      false;

  }


  const syncExpense =
    getElement(
      "foodSyncExpense"
    );


  if (
    syncExpense
  ) {

    syncExpense.checked =
      false;

  }


  const gpsStatus =
    getElement(
      "foodGpsStatus"
    );


  if (
    gpsStatus
  ) {

    gpsStatus.textContent =
      "尚未取得位置";

  }


  foodLocation =
    null;


  foodAddressDetails =
    null;


  foodRating =
    0;


  renderFoodRating();


  const saveButton =
    getElement(
      "saveFoodButton"
    );


  if (
    saveButton
  ) {

    saveButton.textContent =
      "🍜 儲存美食";

  }


  const cancelButton =
    getElement(
      "cancelFoodEditButton"
    );


  if (
    cancelButton
  ) {

    cancelButton.style.display =
      "none";

  }

}


/* =========================================================
   FIND LINKED EXPENSE
========================================================= */

function getLinkedExpense(
  foodClientUid
) {

  return (

    expenses.find(
      expense =>

        expense.source_type ===
          "food" &&

        expense.source_client_uid ===
          foodClientUid

    ) ||

    null

  );

}


/* =========================================================
   SAVE FOOD
========================================================= */

async function saveFood() {

  const shopName =
    getElement(
      "foodShopName"
    )
    ?.value
    .trim() ||
    "";


  if (
    !shopName
  ) {

    hooks.showMessage(
      "請輸入店家名稱",
      "error"
    );

    return;

  }


  const date =
    getElement(
      "foodDate"
    )
    ?.value;


  const time =
    getElement(
      "foodTime"
    )
    ?.value;


  if (
    !date ||
    !time
  ) {

    hooks.showMessage(
      "請輸入日期與時間",
      "error"
    );

    return;

  }


  const editingUid =
    getElement(
      "foodEditingUid"
    )
    ?.value ||
    "";


  const old =

    editingUid

      ? await dbGet(
          STORE_FOOD,
          editingUid
        )

      : null;


  const clientUid =

    editingUid ||
    createUID();


  const timezone =
    getTimezoneInfo();


  const amountText =
    getElement(
      "foodAmount"
    )
    ?.value ??
    "";


  const amount =

    amountText === ""

      ? null

      : Number(
          amountText
        );


  if (
    amount !== null &&
    Number.isNaN(
      amount
    )
  ) {

    hooks.showMessage(
      "金額格式不正確",
      "error"
    );

    return;

  }


  const tripClientUid =

    getElement(
      "foodTrip"
    )
    ?.value ||
    null;


  const foodRecord = {

    ...old,

    client_uid:
      clientUid,

    trip_client_uid:
      tripClientUid,

    recorded_at:
      combineLocalDateTime(
        date,
        time
      ),

    timezone:
      timezone.timezone,

    timezone_offset:
      timezone.timezone_offset,

    shop_name:
      shopName,

    food_name:
      getElement(
        "foodName"
      )
      ?.value
      .trim() ||
      null,

    meal_type:
      getElement(
        "foodMealType"
      )
      ?.value ||
      null,

    food_category:
      getElement(
        "foodCategory"
      )
      ?.value ||
      null,

    recommended:

      getElement(
        "foodRecommended"
      )
      ?.checked
        ? 1
        : 0,

    rating:
      foodRating,

    amount,

    currency:
      getElement(
        "foodCurrency"
      )
      ?.value ||
      "TWD",

    latitude:
      foodLocation?.latitude ??
      old?.latitude ??
      null,

    longitude:
      foodLocation?.longitude ??
      old?.longitude ??
      null,

    gps_accuracy:
      foodLocation?.accuracy ??
      old?.gps_accuracy ??
      null,

    address:
      foodLocation?.address ??
      old?.address ??
      null,

    address_details:
      foodAddressDetails ??
      old?.address_details ??
      null,

    photo_url:
      old?.photo_url ||
      null,

    note:
      getElement(
        "foodNote"
      )
      ?.value
      .trim() ||
      null,

    deleted_at:
      null

  };


  /*
    先存 Food Local。
  */

  await saveAndSync(
    "food_records",
    foodRecord
  );


  /* =====================================================
     FOOD → EXPENSE
  ===================================================== */

  const shouldCreateExpense =

    getElement(
      "foodSyncExpense"
    )
    ?.checked ===
    true;


  const linkedExpense =
    getLinkedExpense(
      clientUid
    );


  if (
    shouldCreateExpense &&
    amount !== null
  ) {

    const expenseRecord = {

      ...linkedExpense,

      client_uid:

        linkedExpense?.client_uid ||
        createUID(),

      trip_client_uid:
        tripClientUid,

      recorded_at:
        foodRecord.recorded_at,

      timezone:
        foodRecord.timezone,

      timezone_offset:
        foodRecord.timezone_offset,

      category:
        "餐飲",

      subcategory:
        foodRecord.food_category ||
        null,

      title:

        foodRecord.food_name

          ? `${shopName} - ${foodRecord.food_name}`

          : shopName,

      amount,

      currency:
        foodRecord.currency,

      payment_method:
        linkedExpense?.payment_method ||
        null,

      payer:
        linkedExpense?.payer ||
        null,

      source_type:
        "food",

      source_client_uid:
        clientUid,

      note:
        linkedExpense?.note ||
        null,

      deleted_at:
        null

    };


    await saveAndSync(
      "expenses",
      expenseRecord
    );

  }
  else if (
    linkedExpense
  ) {

    /*
      原本有連動消費，
      後來取消勾選，
      則 soft-delete 該 Expense。
    */

    await deleteAndSync(
      "expenses",
      linkedExpense.client_uid
    );

  }


  resetFoodForm();


  hooks.requestRefresh();


  hooks.showToast(

    getAutoSyncEnabled()

      ? "🍜 已存 Local，正在同步 D1"

      : "🍜 已存 Local，等待手動同步"

  );

}


/* =========================================================
   EDIT FOOD
========================================================= */

export function editFood(
  clientUid
) {

  const record =
    foodRecords.find(
      item =>
        item.client_uid ===
        clientUid
    );


  if (
    !record
  ) {

    return;

  }


  const date =
    new Date(
      record.recorded_at
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


  getElement(
    "foodEditingUid"
  ).value =
    record.client_uid;


  getElement(
    "foodTrip"
  ).value =
    record.trip_client_uid ||
    "";


  getElement(
    "foodDate"
  ).value =
    localDate;


  getElement(
    "foodTime"
  ).value =
    localTime;


  getElement(
    "foodShopName"
  ).value =
    record.shop_name ||
    "";


  getElement(
    "foodName"
  ).value =
    record.food_name ||
    "";


  getElement(
    "foodMealType"
  ).value =
    record.meal_type ||
    "";


  getElement(
    "foodCategory"
  ).value =
    record.food_category ||
    "";


  getElement(
    "foodRecommended"
  ).checked =
    Boolean(
      Number(
        record.recommended
      )
    );


  getElement(
    "foodAmount"
  ).value =
    record.amount ??
    "";


  getElement(
    "foodCurrency"
  ).value =
    record.currency ||
    "TWD";


  getElement(
    "foodNote"
  ).value =
    record.note ||
    "";


  foodRating =
    Number(
      record.rating
    ) ||
    0;


  renderFoodRating();


  if (
    record.latitude !==
      null &&
    record.latitude !==
      undefined &&
    record.longitude !==
      null &&
    record.longitude !==
      undefined
  ) {

    foodLocation = {

      latitude:
        Number(
          record.latitude
        ),

      longitude:
        Number(
          record.longitude
        ),

      accuracy:
        record.gps_accuracy,

      address:
        record.address ||
        ""

    };


    foodAddressDetails =
      record.address_details ||
      null;


    const gpsStatus =
      getElement(
        "foodGpsStatus"
      );


    if (
      gpsStatus
    ) {

      gpsStatus.innerHTML = `

        📍 GPS

        ${
          record.gps_accuracy

            ? ` ±${escapeHtml(
                record.gps_accuracy
              )}m`

            : ""
        }

        ${
          record.address

            ? "<br>" +
              escapeHtml(
                record.address
              )

            : ""
        }

      `;

    }

  }
  else {

    foodLocation =
      null;


    foodAddressDetails =
      null;

  }


  const linkedExpense =
    getLinkedExpense(
      record.client_uid
    );


  const syncExpense =
    getElement(
      "foodSyncExpense"
    );


  if (
    syncExpense
  ) {

    syncExpense.checked =
      Boolean(
        linkedExpense
      );

  }


  const saveButton =
    getElement(
      "saveFoodButton"
    );


  if (
    saveButton
  ) {

    saveButton.textContent =
      "💾 儲存修改";

  }


  const cancelButton =
    getElement(
      "cancelFoodEditButton"
    );


  if (
    cancelButton
  ) {

    cancelButton.style.display =
      "block";

  }


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
   DELETE FOOD
========================================================= */

export async function deleteFood(
  clientUid
) {

  const record =
    foodRecords.find(
      item =>
        item.client_uid ===
        clientUid
    );


  if (
    !record
  ) {

    return;

  }


  const confirmed =
    await hooks.confirmDialog(

      "刪除美食紀錄",

      "確定要刪除這筆美食紀錄？\n\n🍜 " +
      (
        record.shop_name ||
        ""
      )

    );


  if (
    !confirmed
  ) {

    return;

  }


  /*
    先刪 Food。
  */

  await deleteAndSync(
    "food_records",
    clientUid
  );


  /*
    若有 linked expense，
    一起 soft delete。
  */

  const linkedExpense =
    getLinkedExpense(
      clientUid
    );


  if (
    linkedExpense
  ) {

    await deleteAndSync(
      "expenses",
      linkedExpense.client_uid
    );

  }


  hooks.requestRefresh();


  hooks.showToast(
    "🗑️ 美食紀錄已刪除"
  );

}


/* =========================================================
   SEARCH
========================================================= */

function getFoodSearchKeyword() {

  return (

    getElement(
      "foodSearch"
    )
    ?.value
    .trim()
    .toLowerCase() ||

    ""

  );

}


function getDisplayFoodRecords() {

  const keyword =
    getFoodSearchKeyword();


  return foodRecords

    .filter(
      record => {

        if (
          !keyword
        ) {

          return true;

        }


        const text = [

          record.shop_name,

          record.food_name,

          record.meal_type,

          record.food_category,

          record.address,

          record.note,

          getTripName(
            record.trip_client_uid
          )

        ]
        .filter(
          Boolean
        )
        .join(
          " "
        )
        .toLowerCase();


        return text.includes(
          keyword
        );

      }
    )

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
   FORMAT
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


function formatMoney(
  record
) {

  if (
    record.amount ===
      null ||
    record.amount ===
      undefined ||
    record.amount ===
      ""
  ) {

    return "";

  }


  return (

    escapeHtml(
      record.currency ||
      ""
    ) +

    " " +

    Number(
      record.amount
    )
    .toLocaleString()

  );

}


/* =========================================================
   SYNC BADGE
========================================================= */

function syncBadgeHtml(
  status
) {

  const map = {

    synced: [
      "☁️",
      "已同步"
    ],

    pending: [
      "⏳",
      "待同步"
    ],

    syncing: [
      "🔄",
      "同步中"
    ],

    error: [
      "⚠️",
      "同步失敗"
    ]

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
      ${info[0]}
      ${info[1]}
    </span>

  `;

}


/* =========================================================
   RENDER FOOD
========================================================= */

export function renderFoodRecords() {

  const container =
    getElement(
      "foodList"
    );


  if (
    !container
  ) {

    return;

  }


  const records =
    getDisplayFoodRecords();


  if (
    !records.length
  ) {

    container.innerHTML = `

      <div class="empty">
        尚無美食紀錄
      </div>

    `;

    return;

  }


  container.innerHTML =
    records
      .map(
        record => {

          const stars =

            Number(
              record.rating
            ) >
            0

              ? "★".repeat(
                  Number(
                    record.rating
                  )
                ) +

                "☆".repeat(
                  5 -
                  Number(
                    record.rating
                  )
                )

              : "";


          return `

            <div
              class="record"
              data-food-uid="${escapeHtml(
                record.client_uid
              )}"
            >

              <div class="record-title">

                🍜

                ${escapeHtml(
                  record.shop_name ||
                  "未命名店家"
                )}

                ${syncBadgeHtml(
                  record.sync_status
                )}

              </div>


              ${
                record.food_name

                  ? `

                    <div
                      style="
                        font-size:17px;
                        font-weight:600;
                        margin-top:6px;
                      "
                    >

                      🍽️
                      ${escapeHtml(
                        record.food_name
                      )}

                    </div>

                  `

                  : ""
              }


              ${
                stars

                  ? `

                    <div
                      style="
                        margin-top:7px;
                        font-size:18px;
                      "
                    >

                      ${stars}

                    </div>

                  `

                  : ""
              }


              <div class="record-meta">

                🧳
                ${escapeHtml(
                  getTripName(
                    record.trip_client_uid
                  )
                )}

                <br>

                🕒
                ${escapeHtml(
                  formatRecordedAt(
                    record.recorded_at
                  )
                )}

                ${
                  record.meal_type

                    ? "<br>🍴 " +
                      escapeHtml(
                        record.meal_type
                      )

                    : ""
                }

                ${
                  record.food_category

                    ? "　📂 " +
                      escapeHtml(
                        record.food_category
                      )

                    : ""
                }

                ${
                  Number(
                    record.recommended
                  )

                    ? "<br>👍 推薦"

                    : ""
                }

              </div>


              ${
                record.amount !==
                  null &&
                record.amount !==
                  undefined

                  ? `

                    <div
                      style="
                        margin-top:8px;
                        font-weight:700;
                        font-size:17px;
                      "
                    >

                      💰
                      ${formatMoney(
                        record
                      )}

                    </div>

                  `

                  : ""
              }


              ${
                record.address

                  ? `

                    <div class="record-meta">

                      📍
                      ${escapeHtml(
                        record.address
                      )}

                    </div>

                  `

                  : ""
              }


              ${
                record.note

                  ? `

                    <div class="record-note">

                      ${escapeHtml(
                        record.note
                      )}

                    </div>

                  `

                  : ""
              }


              <div class="record-actions">

                <button
                  type="button"
                  class="btn-gray"
                  data-action="edit-food"
                  data-client-uid="${escapeHtml(
                    record.client_uid
                  )}"
                >
                  ✏️ 編輯
                </button>


                <button
                  type="button"
                  class="btn-soft-red"
                  data-action="delete-food"
                  data-client-uid="${escapeHtml(
                    record.client_uid
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
   BIND EVENTS
========================================================= */

let eventsBound =
  false;


function bindFoodEvents() {

  if (
    eventsBound
  ) {

    return;

  }


  eventsBound =
    true;


  getElement(
    "foodGpsButton"
  )
  ?.addEventListener(
    "click",
    getFoodGPS
  );


  getElement(
    "saveFoodButton"
  )
  ?.addEventListener(
    "click",
    saveFood
  );


  getElement(
    "cancelFoodEditButton"
  )
  ?.addEventListener(
    "click",
    resetFoodForm
  );


  getElement(
    "foodSearch"
  )
  ?.addEventListener(
    "input",
    renderFoodRecords
  );


  /*
    Rating Stars
  */

  document
    .querySelectorAll(
      "[data-food-rating]"
    )
    .forEach(
      button => {

        button.addEventListener(
          "click",
          () => {

            setFoodRating(
              button.dataset.foodRating
            );

          }
        );

      }
    );


  /*
    Food List Event Delegation
  */

  getElement(
    "foodList"
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
        "edit-food"
      ) {

        editFood(
          clientUid
        );

      }


      if (
        action ===
        "delete-food"
      ) {

        deleteFood(
          clientUid
        );

      }

    }
  );

}
