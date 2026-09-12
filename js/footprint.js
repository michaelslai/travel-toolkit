/* =========================================================
   Travel Toolkit V2.2.2 Modular
   File: js/footprint.js
   Modified: 2026-09-12

   V2.2.2 Changes:
   - 補回 Map → Record 定位 / Highlight
   - 補回 Record → Map 定位 / Popup
   - 補回每日站點編號
   - 補回旅程摘要
   - 補回旅行統計
   - 補回每日摘要
   - 補回前一站距離 / 刪除警告
   - 補回至下一筆紀錄時間
   - 補回最新一筆 / 回地圖
   - 保留 V2.2.1 GPS 最近地點自動帶入
   - 保留 IndexedDB Local-first + D1 Sync
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


/*
  V2.2.2

  Map ↔ Record 對應表

  key:
    footprint.client_uid

  value:
    Leaflet Marker
*/

const markerByFootprintUid =
  new Map();


const collapsedDates =
  new Set();


let highlightTimer =
  null;


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


/* =========================================================
   DISPLAY TIME
========================================================= */

function formatRecordTime(
  record
) {

  if (
    !record ||
    !record.recorded_at
  ) {

    return "--:--";

  }


  const date =
    new Date(
      record.recorded_at
    );


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return "--:--";

  }


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


/* =========================================================
   LOCAL DATETIME → ISO
========================================================= */

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
   CURRENT TRIP
========================================================= */

function getCurrentFootprintTripUid() {

  return (

    el(
      "footprintTrip"
    )
    ?.value ||

    null

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
   V2.2.2 NUMBERED MARKER
========================================================= */

function createNumberedMarkerIcon(
  number
) {

  return L.divIcon(
    {

      className:
        "route-number-icon",

      html: `

        <div class="route-number-marker">

          ${number}

        </div>

      `,

      iconSize:
        [
          30,
          30
        ],

      iconAnchor:
        [
          15,
          15
        ],

      popupAnchor:
        [
          0,
          -18
        ]

    }
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
   V2.2.2 DISTANCE FORMAT
========================================================= */

function formatDistance(
  meters
) {

  const value =
    Number(
      meters
    ) ||
    0;


  if (
    value <
    1000
  ) {

    return (

      Math.round(
        value
      ) +
      " m"

    );

  }


  return (

    (
      value /
      1000
    )
    .toFixed(
      value >=
        10000

        ? 1

        : 2
    ) +

    " km"

  );

}


/* =========================================================
   V2.2.2 DATE GROUP
========================================================= */

function groupFootprintsByDay(
  records
) {

  const groups =
    new Map();


  records.forEach(
    record => {

      const dateKey =

        getLocalDateString(

          new Date(
            record.recorded_at
          )

        );


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
          record
        );

    }
  );


  return groups;

}


/* =========================================================
   V2.2.2 PREVIOUS LINK STATE
========================================================= */

function getPreviousLinkState(
  record
) {

  if (
    Number(
      record.link_tracked
    ) ===
    0
  ) {

    return {

      state:
        "disabled",

      previous:
        null

    };

  }


  const previousUid =
    record.previous_client_uid;


  if (
    !previousUid
  ) {

    return {

      state:
        "none",

      previous:
        null

    };

  }


  const previous =

    footprints.find(
      item =>
        String(
          item.client_uid
        ) ===
        String(
          previousUid
        )
    );


  if (
    !previous
  ) {

    return {

      state:
        "missing",

      previous:
        null

    };

  }


  if (
    previous.deleted_at
  ) {

    return {

      state:
        "deleted",

      previous

    };

  }


  return {

    state:
      "valid",

    previous

  };

}


/* =========================================================
   V2.2.2 PREVIOUS DISTANCE
========================================================= */

function getPreviousDistance(
  record
) {

  const link =
    getPreviousLinkState(
      record
    );


  if (
    link.state !==
    "valid"
  ) {

    return null;

  }


  const previous =
    link.previous;


  if (
    record.latitude ===
      null ||
    record.latitude ===
      undefined ||
    record.longitude ===
      null ||
    record.longitude ===
      undefined ||
    previous.latitude ===
      null ||
    previous.latitude ===
      undefined ||
    previous.longitude ===
      null ||
    previous.longitude ===
      undefined
  ) {

    return null;

  }


  return haversineMeters(

    Number(
      previous.latitude
    ),

    Number(
      previous.longitude
    ),

    Number(
      record.latitude
    ),

    Number(
      record.longitude
    )

  );

}


/* =========================================================
   V2.2.2 NEXT LINKED RECORD
========================================================= */

function getNextLinkedRecord(
  record
) {

  if (
    !record
  ) {

    return null;

  }


  return (

    footprints

      .filter(
        item => {

          if (
            item.deleted_at
          ) {

            return false;

          }


          if (
            Number(
              item.link_tracked
            ) ===
            0
          ) {

            return false;

          }


          if (
            String(
              item.previous_client_uid ||
              ""
            ) !==
            String(
              record.client_uid
            )
          ) {

            return false;

          }


          if (
            String(
              item.trip_client_uid ||
              ""
            ) !==
            String(
              record.trip_client_uid ||
              ""
            )
          ) {

            return false;

          }


          return true;

        }
      )

      .sort(
        (
          a,
          b
        ) =>

          new Date(
            a.recorded_at
          ) -

          new Date(
            b.recorded_at
          )

      )[0] ||

    null

  );

}


/* =========================================================
   V2.2.2 TIME TO NEXT RECORD
========================================================= */

function getTimeToNextLinkedRecord(
  record
) {

  const next =
    getNextLinkedRecord(
      record
    );


  if (
    !next
  ) {

    return null;

  }


  const currentTime =
    new Date(
      record.recorded_at
    )
    .getTime();


  const nextTime =
    new Date(
      next.recorded_at
    )
    .getTime();


  if (
    !Number.isFinite(
      currentTime
    ) ||
    !Number.isFinite(
      nextTime
    )
  ) {

    return null;

  }


  const diffMs =
    nextTime -
    currentTime;


  if (
    diffMs <
    0
  ) {

    return null;

  }


  const totalMinutes =

    Math.round(
      diffMs /
      60000
    );


  const hours =

    Math.floor(
      totalMinutes /
      60
    );


  const minutes =

    totalMinutes %
    60;


  let text =
    "";


  if (
    hours >
    0
  ) {

    text +=
      `${hours} 小時`;

  }


  if (
    minutes >
      0 ||
    hours ===
      0
  ) {

    if (
      text
    ) {

      text +=
        " ";

    }


    text +=
      `${minutes} 分`;

  }


  return {

    next,

    text

  };

}

/* =========================================================
   V2.2.2 TRACKED DAY DISTANCE
========================================================= */

function calculateTrackedDayDistance(
  dayRecords
) {

  let total =
    0;


  const dayIds =
    new Set(

      dayRecords.map(
        record =>
          String(
            record.client_uid
          )
      )

    );


  dayRecords.forEach(
    record => {

      const link =
        getPreviousLinkState(
          record
        );


      if (
        link.state !==
        "valid"
      ) {

        return;

      }


      const previous =
        link.previous;


      /*
        必須是同一天畫面中的紀錄
      */

      if (
        !dayIds.has(
          String(
            previous.client_uid
          )
        )
      ) {

        return;

      }


      /*
        必須同一旅程
      */

      if (
        String(
          previous.trip_client_uid ||
          ""
        ) !==
        String(
          record.trip_client_uid ||
          ""
        )
      ) {

        return;

      }


      const distance =
        getPreviousDistance(
          record
        );


      if (
        distance !==
        null
      ) {

        total +=
          distance;

      }

    }
  );


  return total;

}


/* =========================================================
   V2.2.2 TOTAL TRACKED DISTANCE
========================================================= */

function calculateTrackedDistance(
  records
) {

  let total =
    0;


  const groups =
    groupFootprintsByDay(
      records
    );


  for (
    const dayRecords of
    groups.values()
  ) {

    total +=
      calculateTrackedDayDistance(
        dayRecords
      );

  }


  return total;

}


/* =========================================================
   V2.2.2 TYPE SUMMARY
========================================================= */

function getTypeSummary(
  records
) {

  const counts =
    {};


  records.forEach(
    record => {

      const type =

        FOOTPRINT_TYPES[
          record.type
        ]

          ? record.type

          : "other";


      counts[
        type
      ] =

        (
          counts[
            type
          ] ||
          0
        ) +
        1;

    }
  );


  return Object
    .entries(
      counts
    )
    .sort(
      (
        a,
        b
      ) =>
        b[1] -
        a[1]
    )
    .map(
      (
        [
          type,
          count
        ]
      ) => {

        const info =

          FOOTPRINT_TYPES[
            type
          ] ||

          FOOTPRINT_TYPES.other;


        return {

          type,

          icon:
            info.icon,

          label:
            info.label,

          count

        };

      }
    );

}


/* =========================================================
   V2.2.2 DAILY TYPE SUMMARY
========================================================= */

function buildDailyTypeSummaryHtml(
  records
) {

  return getTypeSummary(
    records
  )
  .map(
    item => `

      <span class="date-type-chip">

        ${item.icon}

        ${escapeHtml(
          item.label
        )}

        ${item.count}

      </span>

    `
  )
  .join(
    ""
  );

}


/* =========================================================
   V2.2.2 FOOTPRINT STATISTICS
========================================================= */

function renderFootprintStats(
  records
) {

  const recordCount =
    el(
      "footprintStatsRecords"
    );


  const dayCount =
    el(
      "footprintStatsDays"
    );


  const distance =
    el(
      "footprintStatsDistance"
    );


  if (
    recordCount
  ) {

    recordCount.textContent =
      String(
        records.length
      );

  }


  const groups =
    groupFootprintsByDay(
      records
    );


  if (
    dayCount
  ) {

    dayCount.textContent =
      String(
        groups.size
      );

  }


  if (
    distance
  ) {

    distance.textContent =
      formatDistance(

        calculateTrackedDistance(
          records
        )

      );

  }

}


/* =========================================================
   V2.2.2 TRIP SUMMARY
========================================================= */

function renderFootprintTripSummary() {

  const tripUid =
    getCurrentFootprintTripUid();


  const activeRecords =

    footprints
      .filter(
        record =>
          !record.deleted_at
      )
      .filter(
        record =>

          String(
            record.trip_client_uid ||
            ""
          ) ===
          String(
            tripUid ||
            ""
          )

      )
      .sort(
        (
          a,
          b
        ) =>

          new Date(
            a.recorded_at
          ) -

          new Date(
            b.recorded_at
          )

      );


  const title =
    el(
      "footprintTripSummaryTitle"
    );


  const recordCount =
    el(
      "footprintTripSummaryRecords"
    );


  const dayCount =
    el(
      "footprintTripSummaryDays"
    );


  const distance =
    el(
      "footprintTripSummaryDistance"
    );


  const period =
    el(
      "footprintTripSummaryPeriod"
    );


  const types =
    el(
      "footprintTripSummaryTypes"
    );


  if (
    title
  ) {

    title.textContent =
      getTripName(
        tripUid
      );

  }


  if (
    recordCount
  ) {

    recordCount.textContent =
      String(
        activeRecords.length
      );

  }


  const groups =
    groupFootprintsByDay(
      activeRecords
    );


  if (
    dayCount
  ) {

    dayCount.textContent =
      String(
        groups.size
      );

  }


  if (
    distance
  ) {

    distance.textContent =
      formatDistance(

        calculateTrackedDistance(
          activeRecords
        )

      );

  }


  if (
    !activeRecords.length
  ) {

    if (
      period
    ) {

      period.textContent =
        "尚無足跡";

    }


    if (
      types
    ) {

      types.innerHTML =
        "";

    }


    return;

  }


  const first =
    activeRecords[
      0
    ];


  const last =
    activeRecords[
      activeRecords.length -
      1
    ];


  if (
    period
  ) {

    period.innerHTML = `

      📅
      ${escapeHtml(
        getLocalDateString(
          new Date(
            first.recorded_at
          )
        )
      )}

      ${escapeHtml(
        formatRecordTime(
          first
        )
      )}

      <br>

      ↓

      <br>

      📅
      ${escapeHtml(
        getLocalDateString(
          new Date(
            last.recorded_at
          )
        )
      )}

      ${escapeHtml(
        formatRecordTime(
          last
        )
      )}

    `;

  }


  if (
    types
  ) {

    types.innerHTML =

      getTypeSummary(
        activeRecords
      )
      .map(
        item => `

          <span class="trip-summary-chip">

            ${item.icon}

            ${escapeHtml(
              item.label
            )}

            ${item.count}

          </span>

        `
      )
      .join(
        ""
      );

  }

}


/* =========================================================
   V2.2.2 FIND RECORD ELEMENT
========================================================= */

function findFootprintRecordElement(
  clientUid
) {

  return [

    ...document
      .querySelectorAll(
        "#footprintList .record[data-footprint-uid]"
      )

  ]
  .find(
    element =>

      String(
        element.dataset.footprintUid
      ) ===
      String(
        clientUid
      )

  ) ||
  null;

}


/* =========================================================
   V2.2.2 HIGHLIGHT RECORD
========================================================= */

function highlightFootprintRecord(
  clientUid
) {

  if (
    highlightTimer
  ) {

    clearTimeout(
      highlightTimer
    );

    highlightTimer =
      null;

  }


  document
    .querySelectorAll(
      "#footprintList .record-highlight"
    )
    .forEach(
      element =>
        element.classList.remove(
          "record-highlight"
        )
    );


  const recordElement =
    findFootprintRecordElement(
      clientUid
    );


  if (
    !recordElement
  ) {

    return;

  }


  recordElement
    .classList
    .add(
      "record-highlight"
    );


  highlightTimer =
    setTimeout(
      () => {

        recordElement
          .classList
          .remove(
            "record-highlight"
          );


        highlightTimer =
          null;

      },
      2600
    );

}


/* =========================================================
   V2.2.2 MAP → RECORD
========================================================= */

function scrollToFootprintRecord(
  clientUid
) {

  const record =

    footprints.find(
      item =>

        String(
          item.client_uid
        ) ===
        String(
          clientUid
        )

    );


  if (
    !record
  ) {

    return;

  }


  const dateKey =

    getLocalDateString(

      new Date(
        record.recorded_at
      )

    );


  /*
    若日期群組收合，
    先自動展開。
  */

  if (
    collapsedDates.has(
      dateKey
    )
  ) {

    collapsedDates.delete(
      dateKey
    );


    const group =

      document
        .querySelector(
          `.date-group[data-date="${dateKey}"]`
        );


    if (
      group
    ) {

      group.classList.remove(
        "collapsed"
      );

    }

  }


  const recordElement =
    findFootprintRecordElement(
      clientUid
    );


  if (
    !recordElement
  ) {

    return;

  }


  recordElement
    .scrollIntoView(
      {

        behavior:
          "smooth",

        block:
          "center"

      }
    );


  highlightFootprintRecord(
    clientUid
  );

}


/* =========================================================
   V2.2.2 RECORD → MAP
========================================================= */

function focusFootprintOnMap(
  clientUid
) {

  const marker =

    markerByFootprintUid.get(
      String(
        clientUid
      )
    );


  if (
    !marker ||
    !footprintMap
  ) {

    hooks.showToast(
      "這筆足跡沒有可定位的地圖座標"
    );

    return;

  }


  const mapElement =
    el(
      "footprintMap"
    );


  if (
    mapElement
  ) {

    mapElement
      .scrollIntoView(
        {

          behavior:
            "smooth",

          block:
            "center"

        }
      );

  }


  setTimeout(
    () => {

      footprintMap
        .invalidateSize();


      footprintMap
        .setView(
          marker.getLatLng(),
          16,
          {

            animate:
              true

          }
        );


      marker
        .openPopup();

    },
    450
  );

}


/* =========================================================
   V2.2.2 BACK TO MAP
========================================================= */

function scrollBackToFootprintMap() {

  const mapElement =
    el(
      "footprintMap"
    );


  if (
    !mapElement
  ) {

    return;

  }


  mapElement
    .scrollIntoView(
      {

        behavior:
          "smooth",

        block:
          "center"

      }
    );


  setTimeout(
    () => {

      footprintMap
        ?.invalidateSize();

    },
    450
  );

}


/* =========================================================
   V2.2.2 JUMP TO LATEST RECORD
========================================================= */

function jumpToLatestFootprint() {

  const records =

    getDisplayFootprints()
      .sort(
        (
          a,
          b
        ) =>

          new Date(
            a.recorded_at
          ) -

          new Date(
            b.recorded_at
          )

      );


  if (
    !records.length
  ) {

    hooks.showToast(
      "目前沒有符合條件的足跡"
    );

    return;

  }


  const latest =
    records[
      records.length -
      1
    ];


  scrollToFootprintRecord(
    latest.client_uid
  );


  hooks.showToast(

    "⏬ 已跳到最新一筆：" +

    (
      latest.place_name ||
      "未命名地點"
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


      navigator
        .geolocation
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


/* =========================================================
   OVERPASS QUERY
========================================================= */

async function fetchOverpassNearby(
  latitude,
  longitude
) {

  const radius =
    FOOTPRINT_NEARBY_RADIUS;


  const query = `

[out:json][timeout:15];

(
  nwr["amenity"~"restaurant|fast_food|food_court|cafe|ice_cream|bar|pub"]
     (around:${radius},${latitude},${longitude});

  nwr["shop"]
     (around:${radius},${latitude},${longitude});

  nwr["tourism"~"hotel|motel|hostel|guest_house|apartment|attraction|museum|gallery|viewpoint|theme_park|zoo"]
     (around:${radius},${latitude},${longitude});

  nwr["railway"~"station|halt|tram_stop|subway_entrance"]
     (around:${radius},${latitude},${longitude});

  nwr["public_transport"~"station|platform|stop_position"]
     (around:${radius},${latitude},${longitude});

  nwr["aeroway"~"aerodrome|terminal"]
     (around:${radius},${latitude},${longitude});
);

out center tags;

`;


  let lastError =
    null;


  for (
    const server of
    OVERPASS_SERVERS
  ) {

    const controller =
      new AbortController();


    const timer =
      setTimeout(
        () =>
          controller.abort(),
        OVERPASS_TIMEOUT_MS
      );


    try {

      const response =
        await fetch(
          server,
          {

            method:
              "POST",

            body:
              new URLSearchParams(
                {
                  data:
                    query
                }
              ),

            signal:
              controller.signal

          }
        );


      if (
        !response.ok
      ) {

        throw new Error(
          `Overpass HTTP ${response.status}`
        );

      }


      return await response
        .json();

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
      "附近地點查詢失敗"
    )

  );

}


/* =========================================================
   LOAD NEARBY
========================================================= */

async function loadNearbyPlaces(
  latitude,
  longitude
) {

  const wrap =
    el(
      "nearbyWrap"
    );


  const list =
    el(
      "nearbyList"
    );


  if (
    wrap
  ) {

    wrap.style.display =
      "block";

  }


  if (
    list
  ) {

    list.innerHTML =

      '<div class="status-text">正在搜尋附近地點...</div>';

  }


  try {

    const data =
      await fetchOverpassNearby(
        latitude,
        longitude
      );


    nearbyPlaces =

      (
        data.elements ||
        []
      )

      .map(
        item => {

          const lat =

            item.lat ??
            item.center?.lat;


          const lon =

            item.lon ??
            item.center?.lon;


          const name =

            nearbyDisplayName(
              item.tags
            );


          if (
            lat ===
              undefined ||
            lon ===
              undefined ||
            !name
          ) {

            return null;

          }


          return {

            id:
              `${item.type}:${item.id}`,

            name,

            latitude:
              lat,

            longitude:
              lon,

            distance:

              Math.round(

                haversineMeters(

                  latitude,
                  longitude,
                  lat,
                  lon

                )

              ),

            type:

              inferNearbyType(
                item.tags ||
                {}
              ),

            tags:
              item.tags ||
              {}

          };

        }
      )

      .filter(
        Boolean
      )

      .sort(
        (
          a,
          b
        ) =>
          a.distance -
          b.distance
      );


    /*
      Name + Type dedupe
    */

    const seen =
      new Set();


    nearbyPlaces =

      nearbyPlaces
        .filter(
          place => {

            const key =

              place.name +
              "|" +
              place.type;


            if (
              seen.has(
                key
              )
            ) {

              return false;

            }


            seen.add(
              key
            );


            return true;

          }
        )

        .slice(
          0,
          FOOTPRINT_NEARBY_LIMIT
        );


    /* =====================================================
       V2.2.1+
       GPS 後自動選最近地點

       只有地點名稱目前是空白時才自動填入，
       不覆蓋使用者已輸入的內容。
    ===================================================== */

    const placeInput =
      el(
        "footprintPlace"
      );


    if (
      nearbyPlaces.length >
        0 &&
      placeInput &&
      !placeInput.value.trim()
    ) {

      const nearestPlace =
        nearbyPlaces[
          0
        ];


      placeInput.value =
        nearestPlace.name;


      setFootprintType(
        nearestPlace.type
      );

    }


    renderNearbyPlaces();

  }
  catch (
    error
  ) {

    console.error(
      "Nearby error:",
      error
    );


    nearbyPlaces =
      [];


    if (
      list
    ) {

      list.innerHTML = `

        <div class="status-text">

          目前無法取得附近地點，
          仍可手動輸入地點名稱。

        </div>

      `;

    }

  }

}


/* =========================================================
   RENDER NEARBY
========================================================= */

function renderNearbyPlaces() {

  const list =
    el(
      "nearbyList"
    );


  if (
    !list
  ) {

    return;

  }


  if (
    !nearbyPlaces.length
  ) {

    list.innerHTML = `

      <div class="status-text">

        ${FOOTPRINT_NEARBY_RADIUS}
        公尺內沒有找到已登錄名稱的地點。

      </div>

    `;


    return;

  }


  list.innerHTML =

    nearbyPlaces
      .map(
        (
          place,
          index
        ) => {

          const type =

            FOOTPRINT_TYPES[
              place.type
            ] ||

            FOOTPRINT_TYPES.other;


          return `

            <button
              type="button"
              class="nearby-item"
              data-nearby-index="${index}"
            >

              <span class="nearby-name">

                ${type.icon}

                ${escapeHtml(
                  place.name
                )}

              </span>


              <span class="nearby-meta">

                約
                ${place.distance}
                公尺

                ·

                ${type.label}

              </span>

            </button>

          `;

        }
      )
      .join(
        ""
      );

}


/* =========================================================
   SELECT NEARBY
========================================================= */

function selectNearbyPlace(
  index
) {

  const place =
    nearbyPlaces[
      index
    ];


  if (
    !place
  ) {

    return;

  }


  const placeInput =
    el(
      "footprintPlace"
    );


  if (
    placeInput
  ) {

    placeInput.value =
      place.name;

  }


  setFootprintType(
    place.type
  );


  hooks.showToast(

    `📍 已選擇 ${place.name}`

  );

}


/* =========================================================
   GET FOOTPRINT GPS
========================================================= */

export async function getFootprintGPS() {

  const button =
    el(
      "footprintGpsButton"
    );


  const status =
    el(
      "footprintGpsStatus"
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
      "正在取得 GPS...";

  }


  try {

    const position =
      await getGPSPosition();


    footprintLocation = {

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
      footprintMap
    ) {

      footprintMap
        .setView(
          [
            footprintLocation.latitude,
            footprintLocation.longitude
          ],
          17
        );


      if (
        currentLocationMarker
      ) {

        currentLocationMarker
          .remove();

      }


      currentLocationMarker =

        L.marker(
          [
            footprintLocation.latitude,
            footprintLocation.longitude
          ]
        )

        .addTo(
          footprintMap
        )

        .bindPopup(
          "目前位置"
        );

    }


    if (
      status
    ) {

      status.textContent =

        `GPS ${footprintLocation.latitude.toFixed(6)}, ` +

        `${footprintLocation.longitude.toFixed(6)} ` +

        `±${footprintLocation.accuracy}m`;

    }


    /*
      Reverse Geocode
    */

    try {

      const result =
        await reverseGeocode(

          footprintLocation.latitude,
          footprintLocation.longitude

        );


      const address =

        result?.display_name ||

        result?.address ||

        result?.data?.display_name ||

        "";


      footprintLocation.address =
        address;


      const addressInput =
        el(
          "footprintAddress"
        );


      if (
        addressInput &&
        !addressInput.value.trim()
      ) {

        addressInput.value =
          address;

      }

    }
    catch (
      error
    ) {

      console.warn(
        "Reverse geocode failed:",
        error
      );

    }


    /*
      Nearby POI
    */

    await loadNearbyPlaces(

      footprintLocation.latitude,
      footprintLocation.longitude

    );

  }
  catch (
    error
  ) {

    console.error(
      "GPS error:",
      error
    );


    let message =
      "無法取得目前位置";


    if (
      error?.code ===
      1
    ) {

      message =
        "GPS 權限被拒絕";

    }


    else if (
      error?.code ===
      2
    ) {

      message =
        "目前無法取得 GPS 位置";

    }


    else if (
      error?.code ===
      3
    ) {

      message =
        "GPS 定位逾時";

    }


    if (
      status
    ) {

      status.textContent =
        message;

    }


    hooks.showToast(
      message
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
   DUPLICATE CHECK
========================================================= */

function findPotentialDuplicate(
  record
) {

  if (
    record.latitude === null ||
    record.longitude === null
  ) {

    return null;

  }


  const targetTime =
    new Date(
      record.recorded_at
    )
    .getTime();


  const candidates =

    footprints

      .filter(
        item => {

          if (
            item.deleted_at
          ) {

            return false;

          }


          if (
            item.client_uid ===
            editingFootprintUid
          ) {

            return false;

          }


          if (
            item.latitude === null ||
            item.latitude === undefined ||
            item.longitude === null ||
            item.longitude === undefined
          ) {

            return false;

          }


          return true;

        }
      )

      .map(
        item => {

          const timeDiff =

            Math.abs(

              targetTime -

              new Date(
                item.recorded_at
              )
              .getTime()

            ) /
            1000;


          const distance =

            haversineMeters(

              record.latitude,
              record.longitude,

              Number(
                item.latitude
              ),

              Number(
                item.longitude
              )

            );


          return {

            item,
            timeDiff,
            distance

          };

        }
      )

      .filter(
        candidate =>

          candidate.timeDiff <=
            60 &&

          candidate.distance <=
            30
      )

      .sort(
        (
          a,
          b
        ) =>
          a.timeDiff -
          b.timeDiff
      );


  return (
    candidates[0] ||
    null
  );

}


/* =========================================================
   PREVIOUS RECORD
========================================================= */

function findPreviousFootprint(
  record
) {

  const targetTime =
    new Date(
      record.recorded_at
    )
    .getTime();


  return (

    footprints

      .filter(
        item => {

          if (
            item.deleted_at
          ) {

            return false;

          }


          if (
            item.client_uid ===
            editingFootprintUid
          ) {

            return false;

          }


          if (
            (
              item.trip_client_uid ||
              null
            ) !==
            (
              record.trip_client_uid ||
              null
            )
          ) {

            return false;

          }


          return (

            new Date(
              item.recorded_at
            )
            .getTime() <
            targetTime

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
      )[0] ||

    null

  );

}


/* =========================================================
   SAVE
========================================================= */

async function saveFootprint() {

  const place =

    el(
      "footprintPlace"
    )
    ?.value
    .trim() ||
    "";


  if (
    !place
  ) {

    hooks.showMessage(
      "請輸入地點名稱",
      "error"
    );

    return;

  }


  const date =

    el(
      "footprintDate"
    )
    ?.value ||

    getLocalDateString();


  const time =

    el(
      "footprintTime"
    )
    ?.value ||

    getLocalTimeString();


  const timezone =
    getTimezoneInfo();


  const old =

    editingFootprintUid

      ? footprints.find(
          item =>
            item.client_uid ===
            editingFootprintUid
        )

      : null;


  const record = {

    ...old,

    client_uid:

      editingFootprintUid ||
      createUID(),

    trip_client_uid:

      el(
        "footprintTrip"
      )
      ?.value ||

      null,

    recorded_at:

      combineLocalDateTime(
        date,
        time
      ),

    timezone:
      timezone.timezone,

    timezone_offset:
      timezone.timezone_offset,

    latitude:

      footprintLocation?.latitude ??

      old?.latitude ??

      null,

    longitude:

      footprintLocation?.longitude ??

      old?.longitude ??

      null,

    accuracy:

      footprintLocation?.accuracy ??

      old?.accuracy ??

      null,

    address:

      el(
        "footprintAddress"
      )
      ?.value
      .trim() ||

      footprintLocation?.address ||

      null,

    place_name:
      place,

    type:
      footprintSelectedType,

    note:

      el(
        "footprintNote"
      )
      ?.value
      .trim() ||

      null,

    link_tracked:

      el(
        "footprintLinkTracked"
      )
      ?.checked ===
      false

        ? 0

        : 1,

    deleted_at:
      null

  };


  /* =====================================================
     DUPLICATE CHECK
  ===================================================== */

  if (
    !editingFootprintUid
  ) {

    const duplicate =
      findPotentialDuplicate(
        record
      );


    if (
      duplicate
    ) {

      const confirmed =
        await hooks.confirmDialog(

          "可能重複紀錄",

          `偵測到 ${Math.round(
            duplicate.timeDiff
          )} 秒內、約 ${Math.round(
            duplicate.distance
          )} 公尺處已有足跡：

📍 ${duplicate.item.place_name || "未命名地點"}

仍要新增嗎？`

        );


      if (
        !confirmed
      ) {

        return;

      }

    }

  }


  /* =====================================================
     PREVIOUS LINK
  ===================================================== */

  if (
    !editingFootprintUid
  ) {

    const previous =
      findPreviousFootprint(
        record
      );


    record.previous_client_uid =

      previous?.client_uid ||
      null;

  }


  await saveAndSync(
    "footprints",
    record
  );


  resetFootprintForm();


  hooks.requestRefresh();


  hooks.showToast(

    getAutoSyncEnabled()

      ? "📍 已存 Local，正在同步 D1"

      : "📍 已存 Local，等待手動同步"

  );

}


/* =========================================================
   EDIT
========================================================= */

export function editFootprint(
  clientUid
) {

  const record =
    footprints.find(
      item =>
        item.client_uid ===
        clientUid
    );


  if (
    !record
  ) {

    return;

  }


  editingFootprintUid =
    clientUid;


  const date =
    new Date(
      record.recorded_at
    );


  const editing =
    el(
      "footprintEditingUid"
    );


  if (
    editing
  ) {

    editing.value =
      clientUid;

  }


  const trip =
    el(
      "footprintTrip"
    );


  if (
    trip
  ) {

    trip.value =
      record.trip_client_uid ||
      "";

  }


  const dateInput =
    el(
      "footprintDate"
    );


  if (
    dateInput
  ) {

    dateInput.value =
      getLocalDateString(
        date
      );

  }


  const timeInput =
    el(
      "footprintTime"
    );


  if (
    timeInput
  ) {

    timeInput.value =
      getLocalTimeString(
        date
      );

  }


  const place =
    el(
      "footprintPlace"
    );


  if (
    place
  ) {

    place.value =
      record.place_name ||
      "";

  }


  const address =
    el(
      "footprintAddress"
    );


  if (
    address
  ) {

    address.value =
      record.address ||
      "";

  }


  const note =
    el(
      "footprintNote"
    );


  if (
    note
  ) {

    note.value =
      record.note ||
      "";

  }


  const linkTracked =
    el(
      "footprintLinkTracked"
    );


  if (
    linkTracked
  ) {

    linkTracked.checked =

      Number(
        record.link_tracked
      ) !==
      0;

  }


  setFootprintType(
    record.type ||
    "other"
  );


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

    footprintLocation = {

      latitude:
        Number(
          record.latitude
        ),

      longitude:
        Number(
          record.longitude
        ),

      accuracy:
        record.accuracy,

      address:
        record.address ||
        ""

    };


    if (
      footprintMap
    ) {

      footprintMap
        .setView(
          [
            footprintLocation.latitude,
            footprintLocation.longitude
          ],
          17
        );

    }

  }


  const saveButton =
    el(
      "saveFootprintButton"
    );


  if (
    saveButton
  ) {

    saveButton.textContent =
      "💾 儲存修改";

  }


  const cancel =
    el(
      "cancelFootprintEditButton"
    );


  if (
    cancel
  ) {

    cancel.style.display =
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
   DELETE
========================================================= */

export async function deleteFootprint(
  clientUid
) {

  const record =
    footprints.find(
      item =>
        item.client_uid ===
        clientUid
    );


  if (
    !record
  ) {

    return;

  }


  const childCount =

    footprints.filter(
      item =>

        !item.deleted_at &&

        Number(
          item.link_tracked
        ) !==
        0 &&

        String(
          item.previous_client_uid ||
          ""
        ) ===
        String(
          record.client_uid
        )
    )
    .length;


  let message =

    "確定要刪除這筆足跡？\n\n📍 " +

    (
      record.place_name ||
      "未命名地點"
    );


  if (
    childCount >
    0
  ) {

    message +=

      `\n\n⚠️ 有 ${childCount} 筆後續足跡連到這筆紀錄。` +

      "\n刪除後，後續足跡會顯示「前一站紀錄已刪除」。";

  }


  const confirmed =
    await hooks.confirmDialog(

      "刪除足跡",

      message

    );


  if (
    !confirmed
  ) {

    return;

  }


  await deleteAndSync(
    "footprints",
    clientUid
  );


  hooks.requestRefresh();


  hooks.showToast(

    "🗑️ 足跡已刪除"

  );

}


/* =========================================================
   RESET
========================================================= */

export function resetFootprintForm() {

  editingFootprintUid =
    null;


  footprintLocation =
    null;


  nearbyPlaces =
    [];


  footprintSelectedType =
    "other";


  const editing =
    el(
      "footprintEditingUid"
    );


  if (
    editing
  ) {

    editing.value =
      "";

  }


  const date =
    el(
      "footprintDate"
    );


  if (
    date
  ) {

    date.value =
      getLocalDateString();

  }


  const time =
    el(
      "footprintTime"
    );


  if (
    time
  ) {

    time.value =
      getLocalTimeString();

  }


  [
    "footprintPlace",
    "footprintAddress",
    "footprintNote"
  ]
  .forEach(
    id => {

      const element =
        el(
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


  const linkTracked =
    el(
      "footprintLinkTracked"
    );


  if (
    linkTracked
  ) {

    linkTracked.checked =
      true;

  }


  const gpsStatus =
    el(
      "footprintGpsStatus"
    );


  if (
    gpsStatus
  ) {

    gpsStatus.textContent =
      "尚未取得位置";

  }


  const nearbyWrap =
    el(
      "nearbyWrap"
    );


  if (
    nearbyWrap
  ) {

    nearbyWrap.style.display =
      "none";

  }


  const nearbyList =
    el(
      "nearbyList"
    );


  if (
    nearbyList
  ) {

    nearbyList.innerHTML =
      "";

  }


  const save =
    el(
      "saveFootprintButton"
    );


  if (
    save
  ) {

    save.textContent =
      "📍 儲存足跡";

  }


  const cancel =
    el(
      "cancelFootprintEditButton"
    );


  if (
    cancel
  ) {

    cancel.style.display =
      "none";

  }


  renderFootprintTypes();

}

/* =========================================================
   DISPLAY FILTER
========================================================= */

function getDisplayFootprints() {

  let records =
    footprints.filter(
      record =>
        !record.deleted_at
    );


  /* =====================================================
     Scope
  ===================================================== */

  const scope =

    el(
      "footprintScopeFilter"
    )
    ?.value ||

    "all";


  if (
    scope ===
    "today"
  ) {

    const today =
      getLocalDateString();


    records =
      records.filter(
        record =>

          getLocalDateString(
            new Date(
              record.recorded_at
            )
          ) ===
          today
      );

  }


  if (
    scope ===
    "trip"
  ) {

    const currentTrip =
      getCurrentFootprintTripUid();


    records =
      records.filter(
        record =>

          String(
            record.trip_client_uid ||
            ""
          ) ===
          String(
            currentTrip ||
            ""
          )
      );

  }


  /* =====================================================
     Type
  ===================================================== */

  const typeFilter =

    el(
      "footprintTypeFilter"
    )
    ?.value ||

    "all";


  if (
    typeFilter !==
    "all"
  ) {

    records =
      records.filter(
        record =>
          record.type ===
          typeFilter
      );

  }


  /* =====================================================
     Search
  ===================================================== */

  const keyword =

    el(
      "footprintSearch"
    )
    ?.value
    .trim()
    .toLowerCase() ||

    "";


  if (
    keyword
  ) {

    records =
      records.filter(
        record => {

          const text = [

            record.place_name,

            record.address,

            record.note,

            getTripName(
              record.trip_client_uid
            ),

            FOOTPRINT_TYPES[
              record.type
            ]
            ?.label

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
      );

  }


  return records.sort(
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
   DATE TITLE
========================================================= */

function formatDateTitle(
  dateString
) {

  const [
    year,
    month,
    day
  ] =

    dateString
      .split(
        "-"
      )
      .map(
        Number
      );


  const date =
    new Date(
      year,
      month -
      1,
      day
    );


  const weekdays = [

    "日",
    "一",
    "二",
    "三",
    "四",
    "五",
    "六"

  ];


  return (

    `${year}/${month}/${day}` +

    `（${weekdays[
      date.getDay()
    ]}）`

  );

}


/* =========================================================
   SEARCH RESULT INFO
========================================================= */

function renderFootprintSearchResultInfo(
  records
) {

  const info =
    el(
      "footprintSearchResultInfo"
    );


  if (
    !info
  ) {

    return;

  }


  const keyword =

    el(
      "footprintSearch"
    )
    ?.value
    .trim() ||
    "";


  const typeFilter =

    el(
      "footprintTypeFilter"
    )
    ?.value ||
    "all";


  const scope =

    el(
      "footprintScopeFilter"
    )
    ?.value ||
    "all";


  const filters =
    [];


  if (
    keyword
  ) {

    filters.push(
      `搜尋「${keyword}」`
    );

  }


  if (
    typeFilter !==
    "all"
  ) {

    filters.push(

      FOOTPRINT_TYPES[
        typeFilter
      ]
      ?.label ||
      typeFilter

    );

  }


  if (
    scope ===
    "today"
  ) {

    filters.push(
      "今天"
    );

  }


  if (
    scope ===
    "trip"
  ) {

    filters.push(
      "目前旅程"
    );

  }


  if (
    filters.length
  ) {

    info.textContent =

      `找到 ${records.length} 筆符合條件的足跡`;

  }
  else {

    info.textContent =
      "";

  }

}


/* =========================================================
   SYNC BADGE
========================================================= */

function syncBadgeHtml(
  status
) {

  const map = {

    synced:
      [
        "☁️",
        "已同步"
      ],

    pending:
      [
        "⏳",
        "待同步"
      ],

    syncing:
      [
        "🔄",
        "同步中"
      ],

    error:
      [
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
   V2.2.2 RECORD LINK BADGES
========================================================= */

function buildRecordLinkBadges(
  record
) {

  let html =
    "";


  const link =
    getPreviousLinkState(
      record
    );


  if (
    link.state ===
    "valid"
  ) {

    const distance =
      getPreviousDistance(
        record
      );


    if (
      distance !==
      null
    ) {

      html += `

        <span class="record-distance">

          ↗ 前一站
          ${formatDistance(
            distance
          )}

        </span>

      `;

    }

  }


  else if (
    link.state ===
    "deleted"
  ) {

    html += `

      <span class="record-link-warning">

        ⚠️ 前一站紀錄已刪除

      </span>

    `;

  }


  else if (
    link.state ===
    "missing"
  ) {

    html += `

      <span class="record-link-warning">

        ⚠️ 找不到前一站紀錄

      </span>

    `;

  }


  const nextInfo =
    getTimeToNextLinkedRecord(
      record
    );


  if (
    nextInfo &&
    nextInfo.text
  ) {

    html += `

      <span class="record-next-time">

        ⏱ 至下一筆紀錄
        ${escapeHtml(
          nextInfo.text
        )}

      </span>

    `;

  }


  return html;

}


/* =========================================================
   RECORD CARD
========================================================= */

function footprintCardHtml(
  record,
  sequenceNumber
) {

  const type =

    FOOTPRINT_TYPES[
      record.type
    ] ||

    FOOTPRINT_TYPES.other;


  const tripName =
    getTripName(
      record.trip_client_uid
    );


  return `

    <div
      class="record"
      data-footprint-uid="${escapeHtml(
        record.client_uid
      )}"
    >

      <div
        class="record-main"
        data-action="focus-footprint"
        data-client-uid="${escapeHtml(
          record.client_uid
        )}"
      >

        <div class="record-title">

          <span class="record-number">
            ${sequenceNumber}
          </span>

          ${type.icon}

          ${escapeHtml(
            record.place_name ||
            "未命名地點"
          )}

          ${syncBadgeHtml(
            record.sync_status
          )}

        </div>


        <div class="record-meta">

          🕒
          ${escapeHtml(
            formatRecordTime(
              record
            )
          )}

          ・

          ${escapeHtml(
            type.label
          )}

          <br>

          🧳
          ${escapeHtml(
            tripName
          )}

          ${
            record.accuracy

              ? `

                <br>

                📡 GPS ±${escapeHtml(
                  Math.round(
                    Number(
                      record.accuracy
                    )
                  )
                )}m

              `

              : ""
          }

        </div>


        ${
          record.address

            ? `

              <div class="record-meta">

                🏠
                ${escapeHtml(
                  record.address
                )}

              </div>

            `

            : ""
        }


        <div>

          ${buildRecordLinkBadges(
            record
          )}

        </div>


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

      </div>


      <div class="record-actions">

        <button
          type="button"
          class="btn-gray"
          data-action="edit-footprint"
          data-client-uid="${escapeHtml(
            record.client_uid
          )}"
        >

          ✏️ 編輯

        </button>


        <button
          type="button"
          class="btn-soft-red"
          data-action="delete-footprint"
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
   V2.2.2 DAILY SUMMARY
========================================================= */

function buildDailySummaryHtml(
  dayRecords
) {

  if (
    !dayRecords.length
  ) {

    return "";

  }


  const sorted =

    [
      ...dayRecords
    ]
    .sort(
      (
        a,
        b
      ) =>

        new Date(
          a.recorded_at
        ) -

        new Date(
          b.recorded_at
        )
    );


  const first =
    sorted[
      0
    ];


  const last =
    sorted[
      sorted.length -
      1
    ];


  const distance =

    calculateTrackedDayDistance(
      sorted
    );


  return `

    <div class="date-summary">

      📍
      ${sorted.length}
      個足跡

      ・

      🚗 已追蹤移動
      ${formatDistance(
        distance
      )}

      <br>

      🕐 第一筆
      ${escapeHtml(
        formatRecordTime(
          first
        )
      )}

      ・

      最後一筆
      ${escapeHtml(
        formatRecordTime(
          last
        )
      )}

    </div>


    <div class="date-type-summary">

      ${buildDailyTypeSummaryHtml(
        sorted
      )}

    </div>

  `;

}


/* =========================================================
   RENDER LIST
========================================================= */

export function renderFootprints() {

  const container =
    el(
      "footprintList"
    );


  const records =
    getDisplayFootprints();


  /*
    V2.2.2
    統計跟目前篩選畫面一致
  */

  renderFootprintStats(
    records
  );


  renderFootprintTripSummary();


  renderFootprintSearchResultInfo(
    records
  );


  if (
    container
  ) {

    if (
      !records.length
    ) {

      container.innerHTML = `

        <div class="empty">

          尚無符合條件的足跡

        </div>

      `;

    }
    else {

      const groups =
        groupFootprintsByDay(
          records
        );


      const dateKeys =

        [
          ...groups.keys()
        ]
        .sort(
          (
            a,
            b
          ) =>
            b.localeCompare(
              a
            )
        );


      container.innerHTML =

        dateKeys
          .map(
            date => {

              const groupRecords =

                [
                  ...groups.get(
                    date
                  )
                ]
                .sort(
                  (
                    a,
                    b
                  ) =>

                    new Date(
                      a.recorded_at
                    ) -

                    new Date(
                      b.recorded_at
                    )
                );


              const collapsed =
                collapsedDates.has(
                  date
                );


              return `

                <section
                  class="date-group ${
                    collapsed
                      ? "collapsed"
                      : ""
                  }"
                  data-date="${date}"
                >

                  <button
                    type="button"
                    class="date-header"
                    data-action="toggle-date"
                    data-date="${date}"
                  >

                    <div>

                      <div class="date-title">

                        📅
                        ${formatDateTitle(
                          date
                        )}

                      </div>


                      ${buildDailySummaryHtml(
                        groupRecords
                      )}

                    </div>


                    <div class="date-toggle">
                      ▼
                    </div>

                  </button>


                  <div class="date-records">

                    ${groupRecords
                      .map(
                        (
                          record,
                          index
                        ) =>

                          footprintCardHtml(
                            record,
                            index +
                            1
                          )
                      )
                      .join(
                        ""
                      )}

                  </div>

                </section>

              `;

            }
          )
          .join(
            ""
          );

    }

  }


  renderFootprintMap(
    records
  );

}


/* =========================================================
   V2.2.2 MAP RENDER
========================================================= */

function renderFootprintMap(
  records
) {

  if (
    !footprintMap ||
    !markerLayer ||
    !routeLayer
  ) {

    return;

  }


  markerLayer
    .clearLayers();


  routeLayer
    .clearLayers();


  markerByFootprintUid
    .clear();


  const coordinates =
    [];


  const groups =
    groupFootprintsByDay(
      records
    );


  const dateKeys =

    [
      ...groups.keys()
    ]
    .sort();


  dateKeys.forEach(
    dateKey => {

      const dayRecords =

        [
          ...groups.get(
            dateKey
          )
        ]
        .sort(
          (
            a,
            b
          ) =>

            new Date(
              a.recorded_at
            ) -

            new Date(
              b.recorded_at
            )
        );


      dayRecords.forEach(
        (
          record,
          index
        ) => {

          if (
            record.latitude ===
              null ||
            record.latitude ===
              undefined ||
            record.longitude ===
              null ||
            record.longitude ===
              undefined
          ) {

            return;

          }


          const lat =
            Number(
              record.latitude
            );


          const lon =
            Number(
              record.longitude
            );


          if (
            !Number.isFinite(
              lat
            ) ||
            !Number.isFinite(
              lon
            )
          ) {

            return;

          }


          const sequenceNumber =
            index +
            1;


          const type =

            FOOTPRINT_TYPES[
              record.type
            ] ||

            FOOTPRINT_TYPES.other;


          const marker =

            L.marker(
              [
                lat,
                lon
              ],
              {

                icon:
                  createNumberedMarkerIcon(
                    sequenceNumber
                  )

              }
            )

            .bindPopup(
              `

                <strong>

                  ${sequenceNumber}.
                  ${type.icon}
                  ${escapeHtml(
                    record.place_name ||
                    "未命名地點"
                  )}

                </strong>

                <br>

                ${escapeHtml(
                  type.label
                )}

                <br>

                🧳
                ${escapeHtml(
                  getTripName(
                    record.trip_client_uid
                  )
                )}

                <br>

                ${escapeHtml(
                  dateKey
                )}

                ${escapeHtml(
                  formatRecordTime(
                    record
                  )
                )}

              `
            )

            .addTo(
              markerLayer
            );


          /*
            Map → Record
          */

          marker.on(
            "click",
            () => {

              scrollToFootprintRecord(
                record.client_uid
              );

            }
          );


          markerByFootprintUid
            .set(
              String(
                record.client_uid
              ),
              marker
            );


          coordinates.push(
            [
              lat,
              lon
            ]
          );

        }
      );

    }
  );


  renderRoutes(
    records
  );


  if (
    coordinates.length
  ) {

    footprintMap
      .fitBounds(
        coordinates,
        {

          padding:
            [
              30,
              30
            ],

          maxZoom:
            16

        }
      );

  }

}


/* =========================================================
   V2.2.2 ROUTE RENDER
========================================================= */

function renderRoutes(
  records
) {

  if (
    !routeLayer
  ) {

    return;

  }


  const displayIds =

    new Set(

      records.map(
        record =>
          String(
            record.client_uid
          )
      )

    );


  records.forEach(
    record => {

      if (
        Number(
          record.link_tracked
        ) ===
        0
      ) {

        return;

      }


      const link =
        getPreviousLinkState(
          record
        );


      if (
        link.state !==
        "valid"
      ) {

        return;

      }


      const previous =
        link.previous;


      /*
        前一筆也必須在目前畫面篩選結果裡
      */

      if (
        !displayIds.has(
          String(
            previous.client_uid
          )
        )
      ) {

        return;

      }


      /*
        必須同一旅程
      */

      if (
        String(
          previous.trip_client_uid ||
          ""
        ) !==
        String(
          record.trip_client_uid ||
          ""
        )
      ) {

        return;

      }


      /*
        必須同一天
      */

      const previousDate =

        getLocalDateString(

          new Date(
            previous.recorded_at
          )

        );


      const currentDate =

        getLocalDateString(

          new Date(
            record.recorded_at
          )

        );


      if (
        previousDate !==
        currentDate
      ) {

        return;

      }


      if (
        previous.latitude ===
          null ||
        previous.latitude ===
          undefined ||
        previous.longitude ===
          null ||
        previous.longitude ===
          undefined ||
        record.latitude ===
          null ||
        record.latitude ===
          undefined ||
        record.longitude ===
          null ||
        record.longitude ===
          undefined
      ) {

        return;

      }


      const lat1 =
        Number(
          previous.latitude
        );


      const lon1 =
        Number(
          previous.longitude
        );


      const lat2 =
        Number(
          record.latitude
        );


      const lon2 =
        Number(
          record.longitude
        );


      if (
        !Number.isFinite(
          lat1
        ) ||
        !Number.isFinite(
          lon1
        ) ||
        !Number.isFinite(
          lat2
        ) ||
        !Number.isFinite(
          lon2
        )
      ) {

        return;

      }


      L.polyline(
        [
          [
            lat1,
            lon1
          ],
          [
            lat2,
            lon2
          ]
        ],
        {

          weight:
            4,

          opacity:
            0.7

        }
      )
      .addTo(
        routeLayer
      );

    }
  );

}

/* =========================================================
   EVENT BINDING
========================================================= */

function bindFootprintEvents() {

  /* =====================================================
     TYPE BUTTON
  ===================================================== */

  el(
    "footprintTypeGrid"
  )
  ?.addEventListener(
    "click",
    event => {

      const button =
        event.target.closest(
          "[data-footprint-type]"
        );


      if (
        !button
      ) {

        return;

      }


      setFootprintType(
        button.dataset.footprintType
      );

    }
  );


  /* =====================================================
     GPS
  ===================================================== */

  el(
    "footprintGpsButton"
  )
  ?.addEventListener(
    "click",
    async () => {

      await getFootprintGPS();

    }
  );


  /* =====================================================
     NEARBY
  ===================================================== */

  el(
    "nearbyList"
  )
  ?.addEventListener(
    "click",
    event => {

      const button =
        event.target.closest(
          "[data-nearby-index]"
        );


      if (
        !button
      ) {

        return;

      }


      const index =
        Number(
          button.dataset.nearbyIndex
        );


      if (
        !Number.isInteger(
          index
        )
      ) {

        return;

      }


      selectNearbyPlace(
        index
      );

    }
  );


  /* =====================================================
     SAVE
  ===================================================== */

  el(
    "saveFootprintButton"
  )
  ?.addEventListener(
    "click",
    async () => {

      try {

        await saveFootprint();

      }
      catch (
        error
      ) {

        console.error(
          "Save footprint error:",
          error
        );


        hooks.showMessage(

          error?.message ||
          "儲存足跡失敗",

          "error"

        );

      }

    }
  );


  /* =====================================================
     CANCEL EDIT
  ===================================================== */

  el(
    "cancelFootprintEditButton"
  )
  ?.addEventListener(
    "click",
    () => {

      resetFootprintForm();

      hooks.showToast(
        "已取消編輯"
      );

    }
  );


  /* =====================================================
     SEARCH
  ===================================================== */

  el(
    "footprintSearch"
  )
  ?.addEventListener(
    "input",
    () => {

      renderFootprints();

    }
  );


  /* =====================================================
     SCOPE FILTER
  ===================================================== */

  el(
    "footprintScopeFilter"
  )
  ?.addEventListener(
    "change",
    () => {

      renderFootprints();

    }
  );


  /* =====================================================
     TYPE FILTER
  ===================================================== */

  el(
    "footprintTypeFilter"
  )
  ?.addEventListener(
    "change",
    () => {

      renderFootprints();

    }
  );


  /* =====================================================
     TRIP CHANGE
  ===================================================== */

  el(
    "footprintTrip"
  )
  ?.addEventListener(
    "change",
    () => {

      /*
        旅程摘要永遠跟著目前
        footprintTrip 選項更新。
      */

      renderFootprintTripSummary();


      /*
        如果篩選目前就是「目前旅程」，
        旅程切換後清單 / 地圖也一起更新。
      */

      if (
        el(
          "footprintScopeFilter"
        )
        ?.value ===
        "trip"
      ) {

        renderFootprints();

      }

    }
  );


  /* =====================================================
     LIST DELEGATION
  ===================================================== */

  el(
    "footprintList"
  )
  ?.addEventListener(
    "click",
    async event => {

      const actionElement =
        event.target.closest(
          "[data-action]"
        );


      if (
        !actionElement
      ) {

        return;

      }


      const action =
        actionElement.dataset.action;


      const clientUid =
        actionElement.dataset.clientUid;


      /* =================================================
         DATE TOGGLE
      ================================================= */

      if (
        action ===
        "toggle-date"
      ) {

        const date =
          actionElement.dataset.date;


        if (
          !date
        ) {

          return;

        }


        const group =
          actionElement.closest(
            ".date-group"
          );


        if (
          collapsedDates.has(
            date
          )
        ) {

          collapsedDates.delete(
            date
          );


          group
            ?.classList
            .remove(
              "collapsed"
            );

        }
        else {

          collapsedDates.add(
            date
          );


          group
            ?.classList
            .add(
              "collapsed"
            );

        }


        return;

      }


      /* =================================================
         RECORD → MAP
      ================================================= */

      if (
        action ===
        "focus-footprint"
      ) {

        if (
          clientUid
        ) {

          focusFootprintOnMap(
            clientUid
          );

        }


        return;

      }


      /* =================================================
         EDIT
      ================================================= */

      if (
        action ===
        "edit-footprint"
      ) {

        if (
          clientUid
        ) {

          editFootprint(
            clientUid
          );

        }


        return;

      }


      /* =================================================
         DELETE
      ================================================= */

      if (
        action ===
        "delete-footprint"
      ) {

        if (
          !clientUid
        ) {

          return;

        }


        try {

          await deleteFootprint(
            clientUid
          );

        }
        catch (
          error
        ) {

          console.error(
            "Delete footprint error:",
            error
          );


          hooks.showMessage(

            error?.message ||
            "刪除足跡失敗",

            "error"

          );

        }


        return;

      }

    }
  );


  /* =====================================================
     LATEST RECORD
  ===================================================== */

  el(
    "jumpToLatestFootprintButton"
  )
  ?.addEventListener(
    "click",
    () => {

      jumpToLatestFootprint();

    }
  );


  /* =====================================================
     BACK TO MAP
  ===================================================== */

  el(
    "backToFootprintMapButton"
  )
  ?.addEventListener(
    "click",
    () => {

      scrollBackToFootprintMap();

    }
  );


  /* =====================================================
     DEFAULT DATE / TIME
  ===================================================== */

  const dateInput =
    el(
      "footprintDate"
    );


  if (
    dateInput &&
    !dateInput.value
  ) {

    dateInput.value =
      getLocalDateString();

  }


  const timeInput =
    el(
      "footprintTime"
    );


  if (
    timeInput &&
    !timeInput.value
  ) {

    timeInput.value =
      getLocalTimeString();

  }

}
