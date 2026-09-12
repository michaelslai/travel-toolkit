/* =========================================================
   Travel Toolkit V2.2.0 Modular
   File: js/config.js
   Modified: 2026-09-12

   Changes:
   - 從 V2.1.2 index.html 抽離全域設定
   - 不修改任何既有功能
   - Worker API 維持 V2.1.1
========================================================= */

export const APP_VERSION =
  "2.2.3";


export const EXPECTED_API_VERSION =
  "2.1.1";


export const API_BASE =
  "https://travel-api.michael-slai.workers.dev";


/* =========================================================
   INDEXEDDB
========================================================= */

export const DB_NAME =
  "TravelToolkitDB";


/*
  V2.2.0 只是模組化，
  IndexedDB schema 不變。

  維持版本 4，
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
