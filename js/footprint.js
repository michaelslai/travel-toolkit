/* =========================================================
   Travel Toolkit V2.2.1 Modular
   File: js/footprint.js
   Modified: 2026-09-12

   V2.2.1 Changes:
   - GPS 搜尋附近地點後，自動帶入最近地點名稱
   - 自動同步最近地點類型
   - 若地點名稱已有內容，不覆蓋使用者輸入

   Changes:
   - 整合 V2.1.2 Footprint Local-first 核心
   - 保留 GPS / Reverse Geocode / Nearby 10 Places
   - 保留 8 種 Footprint 類型
   - 補回日期分組 / 折疊
   - 補回類型篩選
   - 補回今日 / 目前旅程 / 全部檢視
   - 補回 Duplicate Check：60 秒 / 30 公尺
   - 保留 previous_client_uid / link_tracked
   - 補回每日 Route Polyline
   - 地圖與列表共用同一份 displayFootprints
   - 不直接處理 D1 Sync Engine
========================================================= */

import {

  FOOTPRINT_TYPES,
  FOOTPRINT_NEARBY_RADIUS,
  FOOTPRINT_NEARBY_LIMIT,
  OVERPASS_SERVERS,
  OVERPASS_TIMEOUT_MS

} from "./config.js";


import {

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

let footprints =
  [];


let trips =
  [];


let footprintLocation =
  null;


let footprintSelectedType =
  "other";


let nearbyPlaces =
  [];


let editingFootprintUid =
  null;


let footprintMap =
  null;


let markerLayer =
  null;


let routeLayer =
  null;


let currentLocationMarker =
  null;


const collapsedDates =
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

export function initFootprintModule(
  options = {}
) {

  hooks = {

    ...hooks,

    ...options

  };


  bindFootprintEvents();


  renderFootprintTypes();


  initializeFootprintMap();

}


/* =========================================================
   SET DATA
========================================================= */

export function setFootprintData(
  data = {}
) {

  footprints =
    data.footprints ||
    [];


  trips =
    data.trips ||
    [];


  renderFootprints();

}


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
   TIME
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


function getLocalDateString(
  date =
    new Date()
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


function getLocalTimeString(
  date =
    new Date()
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

  const date =

    new Date(

      `${dateValue}T${timeValue}:00`

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
   FOOTPRINT TYPES
========================================================= */

function renderFootprintTypes() {

  const container =
    el(
      "footprintTypeGrid"
    );


  if (
    !container
  ) {

    return;

  }


  container.innerHTML =

    Object
      .entries(
        FOOTPRINT_TYPES
      )
      .map(
        (
          [
            key,
            info
          ]
        ) => `

          <button
            type="button"
            class="type-button ${
              key === footprintSelectedType
                ? "active"
                : ""
            }"
            data-footprint-type="${key}"
          >

            <span class="type-icon">
              ${info.icon}
            </span>

            <span>
              ${info.label}
            </span>

          </button>

        `
      )
      .join(
        ""
      );

}


export function setFootprintType(
  type
) {

  if (
    !FOOTPRINT_TYPES[
      type
    ]
  ) {

    type =
      "other";

  }


  footprintSelectedType =
    type;


  renderFootprintTypes();

}


/* =========================================================
   TRIP
========================================================= */

function getTripName(
  uid
) {

  if (
    !uid
  ) {

    return "未分類旅程";

  }


  return (

    trips.find(
      trip =>
        trip.client_uid ===
        uid
    )
    ?.name ||

    "未分類旅程"

  );

}


/* =========================================================
   MAP
========================================================= */

export function initializeFootprintMap() {

  const mapElement =
    el(
      "footprintMap"
    );


  if (
    !mapElement ||
    !window.L ||
    footprintMap
  ) {

    return;

  }


  footprintMap =
    L.map(
      mapElement
    )
    .setView(
      [
        25.033,
        121.5654
      ],
      13
    );


  L.tileLayer(

    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",

    {
      maxZoom:
        19,

      attribution:
        "&copy; OpenStreetMap"
    }

  )
  .addTo(
    footprintMap
  );


  markerLayer =
    L.layerGroup()
      .addTo(
        footprintMap
      );


  routeLayer =
    L.layerGroup()
      .addTo(
        footprintMap
      );

}


/* =========================================================
   DISTANCE
========================================================= */

function haversineMeters(
  lat1,
  lon1,
  lat2,
  lon2
) {

  const R =
    6371000;


  const toRad =
    value =>
      value *
      Math.PI /
      180;


  const dLat =
    toRad(
      lat2 -
      lat1
    );


  const dLon =
    toRad(
      lon2 -
      lon1
    );


  const a =

    Math.sin(
      dLat /
      2
    ) ** 2 +

    Math.cos(
      toRad(
        lat1
      )
    ) *

    Math.cos(
      toRad(
        lat2
      )
    ) *

    Math.sin(
      dLon /
      2
    ) ** 2;


  return (

    2 *
    R *
    Math.atan2(
      Math.sqrt(
        a
      ),
      Math.sqrt(
        1 -
        a
      )
    )

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
   REVERSE GEOCODE
========================================================= */

async function reverseGeocode(
  latitude,
  longitude
) {

  return await api(

    "/api/reverse-geocode" +

    "?lat=" +
    encodeURIComponent(
      latitude
    ) +

    "&lon=" +
    encodeURIComponent(
      longitude
    )

  );

}


/* =========================================================
   NEARBY TYPE
========================================================= */

function inferNearbyType(
  tags = {}
) {

  const amenity =
    tags.amenity;


  const tourism =
    tags.tourism;


  const railway =
    tags.railway;


  const publicTransport =
    tags.public_transport;


  const aeroway =
    tags.aeroway;


  const shop =
    tags.shop;


  if (
    [
      "restaurant",
      "fast_food",
      "food_court"
    ]
    .includes(
      amenity
    )
  ) {

    return "restaurant";

  }


  if (
    [
      "cafe",
      "ice_cream",
      "bar",
      "pub"
    ]
    .includes(
      amenity
    )
  ) {

    return "rest";

  }


  if (
    [
      "hotel",
      "motel",
      "hostel",
      "guest_house",
      "apartment"
    ]
    .includes(
      tourism
    )
  ) {

    return "hotel";

  }


  if (
    railway ||
    publicTransport
  ) {

    return "station";

  }


  if (
    aeroway
  ) {

    return "airport";

  }


  if (
    shop
  ) {

    return "shopping";

  }


  if (
    [
      "attraction",
      "museum",
      "gallery",
      "viewpoint",
      "theme_park",
      "zoo"
    ]
    .includes(
      tourism
    )
  ) {

    return "attraction";

  }


  return "other";

}


/* =========================================================
   NEARBY NAME
========================================================= */

function nearbyDisplayName(
  tags = {}
) {

  return (

    tags[
      "name:zh-Hant"
    ] ||

    tags[
      "name:zh"
    ] ||

    tags[
      "name:ja"
    ] ||

    tags.name ||

    tags.brand ||

    tags.operator ||

    ""

  );

}
