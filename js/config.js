/* =========================================================
   Travel Toolkit V2.3.0 Modular
   File: js/config.js
   Modified: 2026-09-13

   【V2.3.0】
   - 新增 Cloud Authorization 全域設定
   - APP_VERSION 升級為 2.3.0
   - EXPECTED_API_VERSION 升級為 2.3.0
   - 新增 Cloud Token LocalStorage Key
   - 新增 Worker Authorization Header 名稱
   - 未授權時維持 Local-only 模式
   - IndexedDB schema 不變，DB_VERSION 維持 4

   【V2.2.3】
   - Food Feature Parity
   - local photo / photo_local 支援
   - Sync 保留本機照片

   【V2.2.0】
   - 從 V2.1.2 index.html 抽離全域設定
   - Worker API 維持 V2.1.1
========================================================= */


/* =========================================================
   APP / API VERSION
========================================================= */

export const APP_VERSION =
  "2.3.0";


export const EXPECTED_API_VERSION =
  "2.3.0";


export const API_BASE =
  "https://travel-api.michael-slai.workers.dev";


/* =========================================================
   CLOUD AUTHORIZATION
========================================================= */

/*
  Cloud Token 只儲存在目前瀏覽器。

  注意：
  - 不可把真正 Token 寫死在這個檔案
  - 不可 commit Token 到 GitHub
  - 這裡只定義 LocalStorage Key
*/

export const CLOUD_TOKEN_STORAGE_KEY =
  "travelToolkitCloudToken";


/*
  Worker V2.3.0 使用：

  X-Travel-Token: <token>
*/

export const CLOUD_AUTH_HEADER =
  "X-Travel-Token";


/*
  Worker Token 驗證 API
*/

export const CLOUD_AUTH_CHECK_PATH =
  "/api/auth/check";


/* =========================================================
   INDEXEDDB
========================================================= */

export const DB_NAME =
  "TravelToolkitDB";


/*
  V2.3.0 只有 Cloud Authorization。

  IndexedDB object store schema 不變，
  因此維持版本 4，
  避免不必要的 upgrade。
*/

export const DB_VERSION =
  4;


export const STORE_TRIPS =
  "trips";


export const STORE_FOOTPRINTS =
  "footprints";


export const STORE_FOOD =
  "food_records";


export const STORE_EXPENSES =
  "expenses";


export const STORE_SYNC_QUEUE =
  "sync_queue";


export const STORE_META =
  "meta";


/* =========================================================
   FOOTPRINT
========================================================= */

export const FOOTPRINT_NEARBY_RADIUS =
  500;


export const FOOTPRINT_NEARBY_LIMIT =
  10;


export const FOOTPRINT_TYPES = {

  attraction: {
    icon:
      "📷",

    label:
      "景點"
  },

  restaurant: {
    icon:
      "🍜",

    label:
      "餐廳"
  },

  hotel: {
    icon:
      "🏨",

    label:
      "飯店"
  },

  station: {
    icon:
      "🚉",

    label:
      "車站"
  },

  airport: {
    icon:
      "✈️",

    label:
      "機場"
  },

  shopping: {
    icon:
      "🛍️",

    label:
      "購物"
  },

  rest: {
    icon:
      "☕",

    label:
      "休息"
  },

  other: {
    icon:
      "📍",

    label:
      "其他"
  }

};


/* =========================================================
   OVERPASS
========================================================= */

export const OVERPASS_SERVERS = [

  "https://overpass-api.de/api/interpreter",

  "https://overpass.kumi.systems/api/interpreter"

];


export const OVERPASS_TIMEOUT_MS =
  18000;
