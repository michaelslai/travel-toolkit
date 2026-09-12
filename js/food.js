/* =========================================================
   Travel Toolkit V2.2.3 Modular
   File: js/food.js
   Modified: 2026-09-12

   Changes:
   - 對齊單機版 Food V2.4.1
   - 保留 Local-first + D1 Sync
   - 保留 Food → Expense
   - GPS + Reverse Geocode
   - 新增 Nearby Food Places
   - 新增 Local Photo
   - 新增照片壓縮 / 預覽 / 移除
   - 新增統計 / 篩選 / 日期分組
   - photo_local 僅存在 Local IndexedDB
   - photo_url 保留給未來 Cloudflare R2
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

let foodRecords =
  [];

let expenses =
  [];

let trips =
  [];


let foodLocation =
  null;

let foodAddressDetails =
  null;

let foodRating =
  0;


/*
  V2.2.3
  Local-only Base64 image.

  不同步到 D1。
*/
let currentFoodPhoto =
  null;


/*
  true：
  使用者在編輯模式下主動按了「移除照片」。

  用來區分：
  - 沒有選新照片 → 保留舊照片
  - 主動移除 → 清掉舊照片
*/
let removeFoodPhotoRequested =
  false;


/*
  Nearby
*/
let foodNearbyPlaces =
  [];


/*
  Filter
*/
let selectedFoodMealFilter =
  "";

let selectedFoodCategoryFilter =
  "";

let foodRecommendedOnly =
  false;

let foodFilterPanelOpen =
  false;


/*
  Date group collapse
*/
const collapsedFoodDates =
  new Set();


/* =========================================================
   NEARBY CONFIG
========================================================= */

const FOOD_NEARBY_RADIUS =
  500;

const FOOD_NEARBY_LIMIT =
  20;

const FOOD_OVERPASS_TIMEOUT =
  18000;


const FOOD_OVERPASS_SERVERS = [

  "https://overpass-api.de/api/interpreter",

  "https://overpass.kumi.systems/api/interpreter"

];


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


  /*
    初始表單日期 / 時間。
  */
  const date =
    getElement(
      "foodDate"
    );


  if (
    date &&
    !date.value
  ) {

    date.value =
      getLocalDate();

  }


  const time =
    getElement(
      "foodTime"
    );


  if (
    time &&
    !time.value
  ) {

    time.value =
      getLocalTime();

  }


  renderFoodTimezone();

  renderFoodRating();

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


  renderFoodRecords();

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


function getLocalDate(
  date = new Date()
) {

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


function getLocalTime(
  date = new Date()
) {

  return (

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
      ),

    offset_minutes:
      offsetMinutes

  };

}


function renderFoodTimezone() {

  const element =
    getElement(
      "foodTimezoneText"
    );


  if (
    !element
  ) {

    return;

  }


  const info =
    getTimezoneInfo();


  element.textContent =

    `🌏 ${info.timezone || "Local"} · GMT${info.timezone_offset}`;

}


/* =========================================================
   COMBINE DATE / TIME
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
   DISTANCE
========================================================= */

function calculateFoodDistance(
  lat1,
  lon1,
  lat2,
  lon2
) {

  const earthRadius =
    6371000;


  const p1 =

    Number(
      lat1
    ) *
    Math.PI /
    180;


  const p2 =

    Number(
      lat2
    ) *
    Math.PI /
    180;


  const deltaP =

    (
      Number(
        lat2
      ) -
      Number(
        lat1
      )
    ) *
    Math.PI /
    180;


  const deltaL =

    (
      Number(
        lon2
      ) -
      Number(
        lon1
      )
    ) *
    Math.PI /
    180;


  const a =

    Math.sin(
      deltaP /
      2
    ) ** 2 +

    Math.cos(
      p1
    ) *

    Math.cos(
      p2
    ) *

    Math.sin(
      deltaL /
      2
    ) ** 2;


  const c =

    2 *

    Math.atan2(

      Math.sqrt(
        a
      ),

      Math.sqrt(
        1 -
        a
      )

    );


  return Math.round(

    earthRadius *
    c

  );

}


/* =========================================================
   PLACE TYPE
========================================================= */

function getFoodPlaceTypeText(
  place
) {

  const type =
    place.amenity ||
    place.shop ||
    "";


  const map = {

    restaurant:
      "餐廳",

    cafe:
      "咖啡店",

    fast_food:
      "速食",

    food_court:
      "美食廣場",

    ice_cream:
      "冰品",

    bar:
      "酒吧",

    pub:
      "居酒屋 / 酒吧",

    bakery:
      "麵包店",

    convenience:
      "便利商店",

    deli:
      "熟食店",

    pastry:
      "甜點店",

    coffee:
      "咖啡店",

    confectionery:
      "甜點店"

  };


  return (

    map[
      type
    ] ||
    "店家"

  );

}


/* =========================================================
   SEARCH NEARBY FOOD PLACES
========================================================= */

async function searchNearbyFoodPlaces(
  lat,
  lon
) {

  const query = `

[out:json][timeout:18];

(

  nwr
  ["amenity"~"restaurant|cafe|fast_food|food_court|ice_cream|bar|pub"]
  (around:${FOOD_NEARBY_RADIUS},${lat},${lon});

  nwr
  ["shop"~"bakery|convenience|deli|pastry|coffee|confectionery"]
  (around:${FOOD_NEARBY_RADIUS},${lat},${lon});

);

out center tags;

  `;


  let lastError =
    null;


  for (
    const server of
    FOOD_OVERPASS_SERVERS
  ) {

    const controller =
      new AbortController();


    const timer =
      setTimeout(
        () => {

          controller.abort();

        },
        FOOD_OVERPASS_TIMEOUT
      );


    try {

      const response =
        await fetch(
          server,
          {

            method:
              "POST",

            headers: {

              "Content-Type":
                "application/x-www-form-urlencoded;charset=UTF-8"

            },

            body:

              "data=" +

              encodeURIComponent(
                query
              ),

            signal:
              controller.signal

          }
        );


      if (
        !response.ok
      ) {

        throw new Error(

          "附近店家服務 HTTP " +
          response.status

        );

      }


      const data =
        await response.json();


      return parseNearbyFoodPlaces(

        data,
        lat,
        lon

      );

    }
    catch (
      error
    ) {

      lastError =
        error;

    }
    finally {

      clearTimeout(
        timer
      );

    }

  }


  throw (

    lastError ||

    new Error(
      "附近店家服務目前無法使用"
    )

  );

}


/* =========================================================
   PARSE NEARBY
========================================================= */

function parseNearbyFoodPlaces(
  data,
  userLat,
  userLon
) {

  const places =
    [];


  for (
    const element of
    data.elements ||
    []
  ) {

    const tags =
      element.tags ||
      {};


    const name =

      tags["name:zh-Hant"] ||
      tags["name:zh"] ||
      tags["name:ja"] ||
      tags.name ||
      tags.brand;


    if (
      !name
    ) {

      continue;

    }


    const placeLat =

      element.lat ??
      element.center?.lat;


    const placeLon =

      element.lon ??
      element.center?.lon;


    if (
      placeLat ==
        null ||
      placeLon ==
        null
    ) {

      continue;

    }


    places.push(
      {

        name,

        lat:
          Number(
            placeLat
          ),

        lon:
          Number(
            placeLon
          ),

        distance:

          calculateFoodDistance(

            userLat,
            userLon,

            placeLat,
            placeLon

          ),

        amenity:
          tags.amenity ||
          "",

        shop:
          tags.shop ||
          "",

        cuisine:
          tags.cuisine ||
          ""

      }
    );

  }


  /*
    同名店家去重，
    保留距離最近的一筆。
  */

  const unique =
    new Map();


  for (
    const place of
    places
  ) {

    const key =
      place.name
        .trim()
        .toLowerCase();


    if (
      !unique.has(
        key
      ) ||
      place.distance <
        unique.get(
          key
        ).distance
    ) {

      unique.set(
        key,
        place
      );

    }

  }


  return Array
    .from(
      unique.values()
    )
    .sort(
      (
        a,
        b
      ) =>
        a.distance -
        b.distance
    )
    .slice(
      0,
      FOOD_NEARBY_LIMIT
    );

}


/* =========================================================
   RENDER NEARBY
========================================================= */

function renderFoodNearbyPlaces() {

  const wrap =
    getElement(
      "foodNearbyWrap"
    );


  const list =
    getElement(
      "foodNearbyList"
    );


  if (
    !wrap ||
    !list
  ) {

    return;

  }


  wrap.style.display =
    "block";


  if (
    !foodNearbyPlaces.length
  ) {

    list.innerHTML = `

      <div class="gps-status">

        ${FOOD_NEARBY_RADIUS} 公尺內沒有找到已登錄名稱的店家。

        <br>

        你仍然可以手動輸入店名。

      </div>

    `;


    return;

  }


  list.innerHTML =

    foodNearbyPlaces
      .map(
        (
          place,
          index
        ) => `

          <button
            type="button"
            class="food-nearby-item"
            data-food-nearby-index="${index}"
          >

            <span class="food-nearby-name">

              ${escapeHtml(
                place.name
              )}

            </span>


            <span class="food-nearby-meta">

              ${escapeHtml(
                getFoodPlaceTypeText(
                  place
                )
              )}

              ・

              約
              ${escapeHtml(
                place.distance
              )}
              公尺

              ${
                place.cuisine

                  ? "・" +
                    escapeHtml(
                      place.cuisine
                    )

                  : ""
              }

            </span>

          </button>

        `
      )
      .join(
        ""
      );

}


/* =========================================================
   SELECT NEARBY
========================================================= */

function selectFoodNearbyPlace(
  index
) {

  const place =
    foodNearbyPlaces[
      index
    ];


  if (
    !place
  ) {

    return;

  }


  const input =
    getElement(
      "foodShopName"
    );


  if (
    input
  ) {

    input.value =
      place.name;

  }


  const selected =
    getElement(
      "foodSelectedShop"
    );


  if (
    selected
  ) {

    selected.textContent =

      `✓ 已選擇：${place.name}・約 ${place.distance} 公尺`;

    selected.style.display =
      "block";

  }


  hooks.showToast(

    `🏪 已選擇 ${place.name}`

  );

}


/* =========================================================
   FOOD GPS + ADDRESS + NEARBY
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


  const nearbyWrap =
    getElement(
      "foodNearbyWrap"
    );


  const nearbyList =
    getElement(
      "foodNearbyList"
    );


  if (
    button
  ) {

    button.disabled =
      true;

    button.textContent =
      "📡 正在取得 GPS...";

  }


  if (
    status
  ) {

    status.textContent =
      "正在取得目前位置...";

  }


  if (
    nearbyWrap
  ) {

    nearbyWrap.style.display =
      "none";

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

        `GPS ±${foodLocation.accuracy}m，正在取得地址與附近店家...`;

    }


    /*
      Reverse Geocode 與 Nearby
      同時執行。
    */

    const results =
      await Promise.allSettled(
        [

          api(

            "/api/reverse-geocode" +

            "?lat=" +

            encodeURIComponent(
              foodLocation.latitude
            ) +

            "&lon=" +

            encodeURIComponent(
              foodLocation.longitude
            )

          ),

          searchNearbyFoodPlaces(

            foodLocation.latitude,
            foodLocation.longitude

          )

        ]
      );


    /* =====================================================
       ADDRESS
    ===================================================== */

    if (
      results[0].status ===
      "fulfilled"
    ) {

      const result =
        results[0].value;


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
    else {

      console.warn(

        "Food reverse geocode failed:",

        results[0].reason

      );


      foodAddressDetails =
        null;

    }


    /* =====================================================
       NEARBY
    ===================================================== */

    if (
      results[1].status ===
      "fulfilled"
    ) {

      foodNearbyPlaces =
        results[1].value ||
        [];

    }
    else {

      console.warn(

        "Food nearby search failed:",

        results[1].reason

      );


      foodNearbyPlaces =
        [];

    }


    renderFoodNearbyPlaces();


    /*
      與 Footprint V2.2.1 相同概念：
      店名欄位為空時，自動帶最近店家。

      不覆蓋使用者已經輸入的店名。
    */

    const shopInput =
      getElement(
        "foodShopName"
      );


    if (
      foodNearbyPlaces.length >
        0 &&
      shopInput &&
      !shopInput.value.trim()
    ) {

      selectFoodNearbyPlace(
        0
      );

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

        <br>

        🏪 找到 ${foodNearbyPlaces.length} 個附近店家

      `;

    }


    hooks.showToast(
      "📍 美食位置與附近店家已取得"
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
    else if (
      error.message
    ) {

      message =
        error.message;

    }


    if (
      status
    ) {

      status.textContent =
        message;

    }


    if (
      nearbyList
    ) {

      nearbyList.innerHTML =
        "";

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
        "📍 重新定位＋搜尋附近店家";

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
   PHOTO PREVIEW
========================================================= */

function renderFoodPhotoPreview() {

  const wrap =
    getElement(
      "foodPhotoPreviewWrap"
    );


  const preview =
    getElement(
      "foodPhotoPreview"
    );


  if (
    !wrap ||
    !preview
  ) {

    return;

  }


  if (
    currentFoodPhoto
  ) {

    preview.src =
      currentFoodPhoto;


    wrap.classList.add(
      "show"
    );

  }
  else {

    preview.removeAttribute(
      "src"
    );


    wrap.classList.remove(
      "show"
    );

  }

}


/* =========================================================
   PHOTO COMPRESSION
========================================================= */

function compressFoodImage(
  file
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      if (
        !file
      ) {

        reject(
          new Error(
            "沒有選擇照片"
          )
        );

        return;

      }


      if (
        !file.type.startsWith(
          "image/"
        )
      ) {

        reject(
          new Error(
            "選擇的檔案不是圖片"
          )
        );

        return;

      }


      const reader =
        new FileReader();


      reader.onload =
        event => {

          const image =
            new Image();


          image.onload =
            () => {

              /*
                與單機版 Food V2.4.1 一致：
                最長邊 1600px。
              */

              const maxSize =
                1600;


              let width =
                image.width;


              let height =
                image.height;


              if (
                width >
                  maxSize ||
                height >
                  maxSize
              ) {

                const scale =

                  Math.min(

                    maxSize /
                      width,

                    maxSize /
                      height

                  );


                width =
                  Math.round(

                    width *
                    scale

                  );


                height =
                  Math.round(

                    height *
                    scale

                  );

              }


              const canvas =
                document.createElement(
                  "canvas"
                );


              canvas.width =
                width;


              canvas.height =
                height;


              const context =
                canvas.getContext(
                  "2d"
                );


              if (
                !context
              ) {

                reject(
                  new Error(
                    "瀏覽器無法建立圖片處理畫布"
                  )
                );

                return;

              }


              /*
                白底處理：
                PNG / HEIC 轉 JPEG 時，
                避免透明區變成黑色。
              */

              context.fillStyle =
                "#ffffff";


              context.fillRect(
                0,
                0,
                width,
                height
              );


              context.drawImage(

                image,

                0,
                0,

                width,
                height

              );


              try {

                /*
                  與單機版一致：
                  JPEG quality 0.78。
                */

                const result =
                  canvas.toDataURL(
                    "image/jpeg",
                    0.78
                  );


                resolve(
                  result
                );

              }
              catch (
                error
              ) {

                reject(
                  error
                );

              }

            };


          image.onerror =
            () => {

              reject(
                new Error(
                  "無法讀取圖片"
                )
              );

            };


          image.src =
            event.target.result;

        };


      reader.onerror =
        () => {

          reject(
            new Error(
              "無法讀取照片"
            )
          );

        };


      reader.readAsDataURL(
        file
      );

    }
  );

}


/* =========================================================
   PHOTO SELECT
========================================================= */

async function handleFoodPhotoSelected(
  event
) {

  const file =
    event.target.files?.[
      0
    ];


  if (
    !file
  ) {

    return;

  }


  try {

    const input =
      getElement(
        "foodPhotoInput"
      );


    if (
      input
    ) {

      input.disabled =
        true;

    }


    hooks.showToast(
      "📷 正在處理照片..."
    );


    currentFoodPhoto =
      await compressFoodImage(
        file
      );


    /*
      選了新照片，
      代表取消原本的「移除照片」狀態。
    */

    removeFoodPhotoRequested =
      false;


    renderFoodPhotoPreview();


    hooks.showToast(
      "📷 照片已準備完成"
    );

  }
  catch (
    error
  ) {

    console.error(
      "Food photo error:",
      error
    );


    hooks.showMessage(

      "照片處理失敗：" +
      (
        error?.message ||
        error
      ),

      "error"

    );

  }
  finally {

    const input =
      getElement(
        "foodPhotoInput"
      );


    if (
      input
    ) {

      input.disabled =
        false;

    }

  }

}


/* =========================================================
   REMOVE PHOTO
========================================================= */

async function removeFoodPhoto() {

  if (
    !currentFoodPhoto
  ) {

    return;

  }


  const confirmed =
    await hooks.confirmDialog(

      "移除照片",

      "確定要移除目前這張美食照片嗎？"

    );


  if (
    !confirmed
  ) {

    return;

  }


  currentFoodPhoto =
    null;


  removeFoodPhotoRequested =
    true;


  const input =
    getElement(
      "foodPhotoInput"
    );


  if (
    input
  ) {

    input.value =
      "";

  }


  renderFoodPhotoPreview();


  hooks.showToast(
    "🗑️ 照片已移除"
  );

}


/* =========================================================
   FOOD EDIT INDICATOR
========================================================= */

function setFoodEditMode(
  enabled
) {

  const indicator =
    getElement(
      "foodEditIndicator"
    );


  const saveButton =
    getElement(
      "saveFoodButton"
    );


  const cancelButton =
    getElement(
      "cancelFoodEditButton"
    );


  if (
    indicator
  ) {

    indicator.style.display =

      enabled

        ? "block"

        : "none";

  }


  if (
    saveButton
  ) {

    saveButton.textContent =

      enabled

        ? "💾 儲存修改"

        : "🍜 儲存美食";

  }


  if (
    cancelButton
  ) {

    cancelButton.style.display =

      enabled

        ? "block"

        : "none";

  }

}


/* =========================================================
   RESET FORM
========================================================= */

export function resetFoodForm() {

  /* =====================================================
     Editing
  ===================================================== */

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


  setFoodEditMode(
    false
  );


  /* =====================================================
     Date / Time
  ===================================================== */

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


  renderFoodTimezone();


  /* =====================================================
     Text
  ===================================================== */

  [
    "foodShopName",
    "foodName",
    "foodAmount",
    "foodNote"
  ]
  .forEach(
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


  /* =====================================================
     Trip

     這裡不強制把旅程切回空值，
     保留使用者目前選擇的旅程，
     方便旅行途中連續新增美食。
  ===================================================== */


  /* =====================================================
     Meal / Category
  ===================================================== */

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


  /* =====================================================
     Currency
  ===================================================== */

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


  /* =====================================================
     Recommended
  ===================================================== */

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


  /* =====================================================
     Food → Expense
  ===================================================== */

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


  /* =====================================================
     Rating
  ===================================================== */

  foodRating =
    0;


  renderFoodRating();


  /* =====================================================
     GPS
  ===================================================== */

  foodLocation =
    null;


  foodAddressDetails =
    null;


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


  const gpsButton =
    getElement(
      "foodGpsButton"
    );


  if (
    gpsButton
  ) {

    gpsButton.textContent =
      "📍 取得目前位置＋搜尋附近店家";

  }


  /* =====================================================
     Nearby
  ===================================================== */

  foodNearbyPlaces =
    [];


  const nearbyWrap =
    getElement(
      "foodNearbyWrap"
    );


  if (
    nearbyWrap
  ) {

    nearbyWrap.style.display =
      "none";

  }


  const nearbyList =
    getElement(
      "foodNearbyList"
    );


  if (
    nearbyList
  ) {

    nearbyList.innerHTML =
      "";

  }


  const selectedShop =
    getElement(
      "foodSelectedShop"
    );


  if (
    selectedShop
  ) {

    selectedShop.textContent =
      "";

    selectedShop.style.display =
      "none";

  }


  /* =====================================================
     PHOTO
  ===================================================== */

  currentFoodPhoto =
    null;


  removeFoodPhotoRequested =
    false;


  const photoInput =
    getElement(
      "foodPhotoInput"
    );


  if (
    photoInput
  ) {

    photoInput.value =
      "";

  }


  renderFoodPhotoPreview();

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
    amount !==
      null &&
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


  /* =====================================================
     PHOTO DECISION

     新增：
       currentFoodPhoto 有值 → 存照片
       沒照片 → null

     編輯：
       選新照片 → 使用新照片
       主動移除 → null
       都沒做 → 保留 old.photo_local
  ===================================================== */

  let photoLocal =
    null;


  if (
    editingUid
  ) {

    if (
      removeFoodPhotoRequested
    ) {

      photoLocal =
        null;

    }
    else if (
      currentFoodPhoto
    ) {

      photoLocal =
        currentFoodPhoto;

    }
    else {

      photoLocal =
        old?.photo_local ||
        null;

    }

  }
  else {

    photoLocal =
      currentFoodPhoto ||
      null;

  }


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

    /*
      Local-only photo.
    */
    photo_local:
      photoLocal,

    /*
      Reserved for future R2.
    */
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


  /* =====================================================
     SAVE FOOD LOCAL + SYNC
  ===================================================== */

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
    amount !==
      null
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
      原本有 Food → Expense，
      後來取消勾選時，
      soft-delete linked expense。
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


  /* =====================================================
     BASIC FIELDS
  ===================================================== */

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


  /* =====================================================
     RATING
  ===================================================== */

  foodRating =
    Number(
      record.rating
    ) ||
    0;


  renderFoodRating();


  /* =====================================================
     GPS
  ===================================================== */

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

  }


  /* =====================================================
     PHOTO
  ===================================================== */

  currentFoodPhoto =
    record.photo_local ||
    null;


  removeFoodPhotoRequested =
    false;


  const photoInput =
    getElement(
      "foodPhotoInput"
    );


  if (
    photoInput
  ) {

    photoInput.value =
      "";

  }


  renderFoodPhotoPreview();


  /* =====================================================
     SELECTED SHOP NOTE
  ===================================================== */

  const selectedShop =
    getElement(
      "foodSelectedShop"
    );


  if (
    selectedShop
  ) {

    selectedShop.textContent =
      "";

    selectedShop.style.display =
      "none";

  }


  /* =====================================================
     FOOD → EXPENSE
  ===================================================== */

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


  /* =====================================================
     EDIT UI
  ===================================================== */

  setFoodEditMode(
    true
  );


  renderFoodTimezone();


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
      ) +
      (
        record.photo_local

          ? "\n\n📷 此筆紀錄包含本機照片，照片也會一起刪除。"

          : ""
      )

    );


  if (
    !confirmed
  ) {

    return;

  }


  /*
    Food 本身使用既有 soft-delete / sync engine。

    photo_local 會跟著 tombstone Local record 保留，
    等後續資料清理策略再決定是否實體移除。
  */

  await deleteAndSync(
    "food_records",
    clientUid
  );


  /*
    linked Expense 一起 soft-delete。
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


/* =========================================================
   FILTER STATE
========================================================= */

function updateFoodFilterUI() {

  document
    .querySelectorAll(
      '[data-food-filter-type="meal"]'
    )
    .forEach(
      button => {

        button.classList.toggle(

          "active",

          button.dataset.foodFilterValue ===
            selectedFoodMealFilter

        );

      }
    );


  document
    .querySelectorAll(
      '[data-food-filter-type="category"]'
    )
    .forEach(
      button => {

        button.classList.toggle(

          "active",

          button.dataset.foodFilterValue ===
            selectedFoodCategoryFilter

        );

      }
    );


  const recommendButton =
    getElement(
      "foodRecommendFilterButton"
    );


  if (
    recommendButton
  ) {

    recommendButton.classList.toggle(
      "active",
      foodRecommendedOnly
    );

  }


  const panel =
    getElement(
      "foodFilterPanel"
    );


  const toggle =
    getElement(
      "foodFilterToggleButton"
    );


  if (
    panel
  ) {

    panel.classList.toggle(
      "open",
      foodFilterPanelOpen
    );

  }


  if (
    toggle
  ) {

    toggle.classList.toggle(
      "open",
      foodFilterPanelOpen
    );


    toggle.textContent =

      foodFilterPanelOpen

        ? "▲ 收合篩選"

        : "☰ 展開篩選";

  }


  const activeDescriptions =
    [];


  const keyword =
    getFoodSearchKeyword();


  if (
    keyword
  ) {

    activeDescriptions.push(
      `搜尋：${keyword}`
    );

  }


  if (
    selectedFoodMealFilter
  ) {

    activeDescriptions.push(
      `餐別：${selectedFoodMealFilter}`
    );

  }


  if (
    selectedFoodCategoryFilter
  ) {

    activeDescriptions.push(
      `分類：${selectedFoodCategoryFilter}`
    );

  }


  if (
    foodRecommendedOnly
  ) {

    activeDescriptions.push(
      "只看推薦"
    );

  }


  const status =
    getElement(
      "foodFilterStatus"
    );


  if (
    status
  ) {

    status.textContent =

      activeDescriptions.length

        ? activeDescriptions.join(
            " · "
          )

        : "目前沒有啟用篩選";

  }


  const clearButton =
    getElement(
      "foodClearFilterButton"
    );


  if (
    clearButton
  ) {

    clearButton.classList.toggle(

      "show",

      activeDescriptions.length >
        0

    );

  }

}


/* =========================================================
   DISPLAY RECORDS
========================================================= */

function getDisplayFoodRecords() {

  const keyword =
    getFoodSearchKeyword();


  return foodRecords

    .filter(
      record => {

        if (
          record.deleted_at
        ) {

          return false;

        }


        if (
          selectedFoodMealFilter &&
          record.meal_type !==
            selectedFoodMealFilter
        ) {

          return false;

        }


        if (
          selectedFoodCategoryFilter &&
          record.food_category !==
            selectedFoodCategoryFilter
        ) {

          return false;

        }


        if (
          foodRecommendedOnly &&
          !Number(
            record.recommended
          )
        ) {

          return false;

        }


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

          Number(
            record.recommended
          )
            ? "推薦 值得再訪"
            : "",

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


function formatFoodDate(
  value
) {

  if (
    !value
  ) {

    return "未知日期";

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

    return "未知日期";

  }


  return getLocalDate(
    date
  );

}


function formatFoodDateTitle(
  dateKey
) {

  if (
    !dateKey ||
    dateKey ===
      "unknown"
  ) {

    return "未知日期";

  }


  const date =
    new Date(
      `${dateKey}T00:00:00`
    );


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return dateKey;

  }


  return (

    date.getFullYear() +
    " / " +

    pad(
      date.getMonth() +
      1
    ) +
    " / " +

    pad(
      date.getDate()
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


  const amount =
    Number(
      record.amount
    );


  const currency =
    record.currency ||
    "";


  if (
    currency ===
    "TWD"
  ) {

    return (

      "NT$" +

      amount.toLocaleString(
        "zh-TW",
        {
          maximumFractionDigits:
            2
        }
      )

    );

  }


  if (
    currency ===
    "JPY"
  ) {

    return (

      "¥" +

      amount.toLocaleString(
        "ja-JP",
        {
          maximumFractionDigits:
            0
        }
      )

    );

  }


  if (
    currency ===
    "CNY"
  ) {

    return (

      "CN¥" +

      amount.toLocaleString(
        "zh-CN",
        {
          maximumFractionDigits:
            2
        }
      )

    );

  }


  if (
    currency ===
    "USD"
  ) {

    return (

      "US$" +

      amount.toLocaleString(
        "en-US",
        {
          maximumFractionDigits:
            2
        }
      )

    );

  }


  if (
    currency ===
    "KRW"
  ) {

    return (

      "₩" +

      amount.toLocaleString(
        "ko-KR",
        {
          maximumFractionDigits:
            0
        }
      )

    );

  }


  return (

    currency +
    " " +
    amount.toLocaleString()

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
   SUMMARY
========================================================= */

function renderFoodSummary(
  records
) {

  const activeRecords =
    records.filter(
      record =>
        !record.deleted_at
    );


  const count =
    activeRecords.length;


  const ratingRecords =
    activeRecords.filter(
      record =>
        Number(
          record.rating
        ) >
        0
    );


  const averageRating =

    ratingRecords.length

      ? ratingRecords.reduce(
          (
            sum,
            record
          ) =>
            sum +
            Number(
              record.rating
            ),
          0
        ) /
        ratingRecords.length

      : null;


  const twdTotal =
    activeRecords.reduce(
      (
        sum,
        record
      ) => {

        if (
          record.currency !==
            "TWD" ||
          record.amount ===
            null ||
          record.amount ===
            undefined
        ) {

          return sum;

        }


        return (
          sum +
          Number(
            record.amount
          )
        );

      },
      0
    );


  const jpyTotal =
    activeRecords.reduce(
      (
        sum,
        record
      ) => {

        if (
          record.currency !==
            "JPY" ||
          record.amount ===
            null ||
          record.amount ===
            undefined
        ) {

          return sum;

        }


        return (
          sum +
          Number(
            record.amount
          )
        );

      },
      0
    );


  const countElement =
    getElement(
      "foodSummaryCount"
    );


  if (
    countElement
  ) {

    countElement.textContent =
      String(
        count
      );

  }


  const ratingElement =
    getElement(
      "foodSummaryRating"
    );


  if (
    ratingElement
  ) {

    ratingElement.textContent =

      averageRating ===
        null

        ? "-"

        : `${averageRating.toFixed(1)} ★`;

  }


  const twdElement =
    getElement(
      "foodSummaryTWD"
    );


  if (
    twdElement
  ) {

    twdElement.textContent =

      "NT$" +

      twdTotal.toLocaleString(
        "zh-TW",
        {
          maximumFractionDigits:
            2
        }
      );

  }


  const jpyElement =
    getElement(
      "foodSummaryJPY"
    );


  if (
    jpyElement
  ) {

    jpyElement.textContent =

      "¥" +

      jpyTotal.toLocaleString(
        "ja-JP",
        {
          maximumFractionDigits:
            0
        }
      );

  }

}


/* =========================================================
   SEARCH RESULT INFO
========================================================= */

function renderFoodSearchResultInfo(
  visibleCount,
  totalCount
) {

  const element =
    getElement(
      "foodSearchResultInfo"
    );


  if (
    !element
  ) {

    return;

  }


  const hasFilter =

    Boolean(
      getFoodSearchKeyword()
    ) ||

    Boolean(
      selectedFoodMealFilter
    ) ||

    Boolean(
      selectedFoodCategoryFilter
    ) ||

    foodRecommendedOnly;


  if (
    hasFilter
  ) {

    element.textContent =

      `找到 ${visibleCount} 筆，共 ${totalCount} 筆美食紀錄`;

  }
  else {

    element.textContent =

      totalCount

        ? `顯示全部 ${totalCount} 筆紀錄`

        : "目前沒有美食紀錄";

  }

}


/* =========================================================
   DATE GROUP
========================================================= */

function groupFoodRecordsByDate(
  records
) {

  const groups =
    new Map();


  records.forEach(
    record => {

      const key =
        formatFoodDate(
          record.recorded_at
        ) ||
        "unknown";


      if (
        !groups.has(
          key
        )
      ) {

        groups.set(
          key,
          []
        );

      }


      groups.get(
        key
      )
      .push(
        record
      );

    }
  );


  return groups;

}


/* =========================================================
   DAILY SUMMARY
========================================================= */

function buildFoodDailySummary(
  records
) {

  const count =
    records.length;


  const recommendedCount =
    records.filter(
      record =>
        Number(
          record.recommended
        )
    ).length;


  const ratingRecords =
    records.filter(
      record =>
        Number(
          record.rating
        ) >
        0
    );


  const average =

    ratingRecords.length

      ? ratingRecords.reduce(
          (
            sum,
            record
          ) =>
            sum +
            Number(
              record.rating
            ),
          0
        ) /
        ratingRecords.length

      : null;


  const parts = [

    `${count} 筆`

  ];


  if (
    average !==
      null
  ) {

    parts.push(
      `平均 ${average.toFixed(1)}★`
    );

  }


  if (
    recommendedCount
  ) {

    parts.push(
      `推薦 ${recommendedCount}`
    );

  }


  return parts.join(
    " · "
  );

}


/* =========================================================
   RECORD CARD
========================================================= */

function foodRecordCardHtml(
  record
) {

  const ratingValue =
    Math.max(
      0,
      Math.min(
        5,
        Number(
          record.rating
        ) ||
        0
      )
    );


  const stars =

    ratingValue

      ? "★".repeat(
          ratingValue
        ) +
        "☆".repeat(
          5 -
          ratingValue
        )

      : "";


  const tags =
    [];


  if (
    record.meal_type
  ) {

    tags.push(
      `
        <span class="food-record-tag">
          ${escapeHtml(
            record.meal_type
          )}
        </span>
      `
    );

  }


  if (
    record.food_category
  ) {

    tags.push(
      `
        <span class="food-record-tag">
          ${escapeHtml(
            record.food_category
          )}
        </span>
      `
    );

  }


  if (
    Number(
      record.recommended
    )
  ) {

    tags.push(
      `
        <span class="food-record-tag recommended">
          ⭐ 推薦 / 值得再訪
        </span>
      `
    );

  }


  return `

    <div
      class="record"
      data-food-uid="${escapeHtml(
        record.client_uid
      )}"
    >

      <div class="food-record-store">

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

            <div class="food-record-food">

              🍽️
              ${escapeHtml(
                record.food_name
              )}

            </div>

          `

          : ""
      }


      ${
        record.photo_local

          ? `

            <img
              class="food-record-photo"
              src="${record.photo_local}"
              alt="${escapeHtml(
                record.shop_name ||
                "美食照片"
              )}"
              loading="lazy"
            >

          `

          : (
              record.photo_url

                ? `

                  <img
                    class="food-record-photo"
                    src="${escapeHtml(
                      record.photo_url
                    )}"
                    alt="${escapeHtml(
                      record.shop_name ||
                      "美食照片"
                    )}"
                    loading="lazy"
                  >

                `

                : ""
            )
      }


      ${
        stars

          ? `

            <div class="food-record-stars">
              ${stars}
            </div>

          `

          : ""
      }


      ${
        tags.length

          ? `

            <div class="food-record-tags">

              ${tags.join(
                ""
              )}

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

      </div>


      ${
        record.amount !==
          null &&
        record.amount !==
          undefined

          ? `

            <div class="food-record-money">

              💰
              ${escapeHtml(
                formatMoney(
                  record
                )
              )}

            </div>

          `

          : ""
      }


      ${
        record.address

          ? `

            <div class="food-record-address">

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


  /*
    Summary 使用全部非刪除紀錄，
    不隨搜尋 / filter 改變。

    這樣與單機版「整體美食統計」概念一致。
  */

  const allActiveRecords =
    foodRecords.filter(
      record =>
        !record.deleted_at
    );


  renderFoodSummary(
    allActiveRecords
  );


  updateFoodFilterUI();


  const records =
    getDisplayFoodRecords();


  renderFoodSearchResultInfo(

    records.length,
    allActiveRecords.length

  );


  if (
    !records.length
  ) {

    container.innerHTML = `

      <div class="empty">

        ${
          allActiveRecords.length

            ? "沒有符合搜尋或篩選條件的美食紀錄"

            : "尚無美食紀錄"
        }

      </div>

    `;

    return;

  }


  const groups =
    groupFoodRecordsByDate(
      records
    );


  container.innerHTML =

    Array
      .from(
        groups.entries()
      )
      .map(
        (
          [
            dateKey,
            groupRecords
          ]
        ) => {

          const collapsed =
            collapsedFoodDates.has(
              dateKey
            );


          return `

            <div
              class="food-date-group ${
                collapsed
                  ? "collapsed"
                  : ""
              }"
              data-food-date="${escapeHtml(
                dateKey
              )}"
            >

              <button
                type="button"
                class="food-date-header"
                data-action="toggle-food-date"
                data-date="${escapeHtml(
                  dateKey
                )}"
              >

                <div>

                  <div class="food-date-title">

                    📅
                    ${escapeHtml(
                      formatFoodDateTitle(
                        dateKey
                      )
                    )}

                  </div>


                  <div class="food-date-summary">

                    ${escapeHtml(
                      buildFoodDailySummary(
                        groupRecords
                      )
                    )}

                  </div>

                </div>


                <div class="food-date-toggle">
                  ▼
                </div>

              </button>


              <div class="food-date-records">

                ${groupRecords
                  .map(
                    foodRecordCardHtml
                  )
                  .join(
                    ""
                  )}

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
   FILTER ACTIONS
========================================================= */

function toggleFoodFilterPanel() {

  foodFilterPanelOpen =
    !foodFilterPanelOpen;


  updateFoodFilterUI();

}


/* =========================================================
   SET MEAL FILTER
========================================================= */

function setFoodMealFilter(
  value
) {

  selectedFoodMealFilter =
    value ||
    "";


  renderFoodRecords();

}


/* =========================================================
   SET CATEGORY FILTER
========================================================= */

function setFoodCategoryFilter(
  value
) {

  selectedFoodCategoryFilter =
    value ||
    "";


  renderFoodRecords();

}


/* =========================================================
   TOGGLE RECOMMENDED FILTER
========================================================= */

function toggleFoodRecommendedFilter() {

  foodRecommendedOnly =
    !foodRecommendedOnly;


  renderFoodRecords();

}


/* =========================================================
   CLEAR FILTERS
========================================================= */

function clearFoodFilters() {

  selectedFoodMealFilter =
    "";


  selectedFoodCategoryFilter =
    "";


  foodRecommendedOnly =
    false;


  const search =
    getElement(
      "foodSearch"
    );


  if (
    search
  ) {

    search.value =
      "";

  }


  renderFoodRecords();


  hooks.showToast(
    "🔎 已清除美食搜尋與篩選"
  );

}


/* =========================================================
   DATE COLLAPSE
========================================================= */

function toggleFoodDate(
  dateKey
) {

  if (
    !dateKey
  ) {

    return;

  }


  if (
    collapsedFoodDates.has(
      dateKey
    )
  ) {

    collapsedFoodDates.delete(
      dateKey
    );

  }
  else {

    collapsedFoodDates.add(
      dateKey
    );

  }


  renderFoodRecords();

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


  /* =====================================================
     GPS
  ===================================================== */

  getElement(
    "foodGpsButton"
  )
  ?.addEventListener(
    "click",
    getFoodGPS
  );


  /* =====================================================
     SAVE
  ===================================================== */

  getElement(
    "saveFoodButton"
  )
  ?.addEventListener(
    "click",
    saveFood
  );


  /* =====================================================
     CANCEL EDIT
  ===================================================== */

  getElement(
    "cancelFoodEditButton"
  )
  ?.addEventListener(
    "click",
    () => {

      resetFoodForm();

      hooks.showToast(
        "已取消編輯"
      );

    }
  );


  /* =====================================================
     SEARCH
  ===================================================== */

  getElement(
    "foodSearch"
  )
  ?.addEventListener(
    "input",
    renderFoodRecords
  );


  /* =====================================================
     FILTER PANEL
  ===================================================== */

  getElement(
    "foodFilterToggleButton"
  )
  ?.addEventListener(
    "click",
    toggleFoodFilterPanel
  );


  /* =====================================================
     RECOMMENDED FILTER
  ===================================================== */

  getElement(
    "foodRecommendFilterButton"
  )
  ?.addEventListener(
    "click",
    toggleFoodRecommendedFilter
  );


  /* =====================================================
     CLEAR FILTER
  ===================================================== */

  getElement(
    "foodClearFilterButton"
  )
  ?.addEventListener(
    "click",
    clearFoodFilters
  );


  /* =====================================================
     FILTER CHIPS
  ===================================================== */

  document
    .querySelectorAll(
      "[data-food-filter-type]"
    )
    .forEach(
      button => {

        button.addEventListener(
          "click",
          () => {

            const type =
              button.dataset.foodFilterType;


            const value =
              button.dataset.foodFilterValue ||
              "";


            if (
              type ===
              "meal"
            ) {

              setFoodMealFilter(
                value
              );

            }


            if (
              type ===
              "category"
            ) {

              setFoodCategoryFilter(
                value
              );

            }

          }
        );

      }
    );


  /* =====================================================
     RATING STARS
  ===================================================== */

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


  /* =====================================================
     PHOTO SELECT
  ===================================================== */

  getElement(
    "foodPhotoInput"
  )
  ?.addEventListener(
    "change",
    handleFoodPhotoSelected
  );


  /* =====================================================
     REMOVE PHOTO
  ===================================================== */

  getElement(
    "removeFoodPhotoButton"
  )
  ?.addEventListener(
    "click",
    removeFoodPhoto
  );


  /* =====================================================
     NEARBY PLACE CLICK
  ===================================================== */

  getElement(
    "foodNearbyList"
  )
  ?.addEventListener(
    "click",
    event => {

      const button =
        event.target.closest(
          "[data-food-nearby-index]"
        );


      if (
        !button
      ) {

        return;

      }


      const index =
        Number(
          button.dataset.foodNearbyIndex
        );


      if (
        Number.isNaN(
          index
        )
      ) {

        return;

      }


      selectFoodNearbyPlace(
        index
      );

    }
  );


  /* =====================================================
     FOOD LIST EVENT DELEGATION
  ===================================================== */

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


      /* Edit */

      if (
        action ===
        "edit-food"
      ) {

        editFood(
          clientUid
        );

        return;

      }


      /* Delete */

      if (
        action ===
        "delete-food"
      ) {

        deleteFood(
          clientUid
        );

        return;

      }


      /* Date collapse */

      if (
        action ===
        "toggle-food-date"
      ) {

        toggleFoodDate(
          button.dataset.date
        );

      }

    }
  );

}
