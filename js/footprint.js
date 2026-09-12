/* =========================================================
   Travel Toolkit V2.2.0 Modular
   File: js/footprint.js
   Modified: 2026-09-12

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


      return await response.json();

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
            lat === undefined ||
            lon === undefined ||
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

        `GPS ±${footprintLocation.accuracy}m，正在取得地址...`;

    }


    try {

      const geo =
        await reverseGeocode(
          footprintLocation.latitude,
          footprintLocation.longitude
        );


      footprintLocation.address =

        geo.address ||
        geo.display_name ||
        "";


      const addressInput =
        el(
          "footprintAddress"
        );


      if (
        addressInput
      ) {

        addressInput.value =
          footprintLocation.address;

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


    if (
      status
    ) {

      status.innerHTML = `

        GPS ±${footprintLocation.accuracy}m

        ${
          footprintLocation.address
            ? "<br>" +
              escapeHtml(
                footprintLocation.address
              )
            : ""
        }

      `;

    }


    await loadNearbyPlaces(

      footprintLocation.latitude,

      footprintLocation.longitude

    );

  }
  catch (
    error
  ) {

    console.error(
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
        "GPS 定位逾時";

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


  el(
    "footprintEditingUid"
  ).value =
    clientUid;


  el(
    "footprintTrip"
  ).value =
    record.trip_client_uid ||
    "";


  el(
    "footprintDate"
  ).value =
    getLocalDateString(
      date
    );


  el(
    "footprintTime"
  ).value =
    getLocalTimeString(
      date
    );


  el(
    "footprintPlace"
  ).value =
    record.place_name ||
    "";


  el(
    "footprintAddress"
  ).value =
    record.address ||
    "";


  el(
    "footprintNote"
  ).value =
    record.note ||
    "";


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


  const confirmed =
    await hooks.confirmDialog(

      "刪除足跡",

      "確定要刪除這筆足跡？\n\n📍 " +

      (
        record.place_name ||
        ""
      )

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

      el(
        "footprintTrip"
      )
      ?.value ||

      null;


    records =
      records.filter(
        record =>

          (
            record.trip_client_uid ||
            null
          ) ===
          currentTrip

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
   DATE GROUP
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
   RECORD CARD
========================================================= */

function footprintCardHtml(
  record
) {

  const type =

    FOOTPRINT_TYPES[
      record.type
    ] ||

    FOOTPRINT_TYPES.other;


  const date =
    new Date(
      record.recorded_at
    );


  return `

    <div
      class="record"
      data-footprint-uid="${escapeHtml(
        record.client_uid
      )}"
    >

      <div class="record-title">

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
        ${pad(
          date.getHours()
        )}:${pad(
          date.getMinutes()
        )}

        ・

        ${type.label}

        <br>

        🧳
        ${escapeHtml(
          getTripName(
            record.trip_client_uid
          )
        )}

        ${
          record.accuracy

            ? `<br>📡 GPS ±${escapeHtml(
                record.accuracy
              )}m`

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
   RENDER LIST
========================================================= */

export function renderFootprints() {

  const container =
    el(
      "footprintList"
    );


  const records =
    getDisplayFootprints();


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
        new Map();


      records.forEach(
        record => {

          const key =

            getLocalDateString(

              new Date(
                record.recorded_at
              )

            );


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


          groups
            .get(
              key
            )
            .push(
              record
            );

        }
      );


      container.innerHTML =

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
        )

        .map(
          date => {

            const groupRecords =
              groups.get(
                date
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

                    <div class="date-summary">

                      ${groupRecords.length}
                      筆足跡

                    </div>

                  </div>

                  <div class="date-toggle">
                    ▼
                  </div>

                </button>


                <div class="date-records">

                  ${groupRecords
                    .map(
                      footprintCardHtml
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
   MAP RENDER
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


  const coordinates =
    [];


  records.forEach(
    record => {

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


      coordinates.push(
        [
          lat,
          lon
        ]
      );


      const type =

        FOOTPRINT_TYPES[
          record.type
        ] ||

        FOOTPRINT_TYPES.other;


      L.marker(
        [
          lat,
          lon
        ]
      )
      .bindPopup(

        `<strong>${type.icon} ${escapeHtml(
          record.place_name ||
          ""
        )}</strong>`

      )
      .addTo(
        markerLayer
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
            17
        }
      );

  }

}


/* =========================================================
   DAILY ROUTE
========================================================= */

function renderRoutes(
  records
) {

  const groups =
    new Map();


  records

    .filter(
      record =>

        Number(
          record.link_tracked
        ) !==
        0 &&

        record.latitude !==
          null &&

        record.latitude !==
          undefined &&

        record.longitude !==
          null &&

        record.longitude !==
          undefined

    )

    .forEach(
      record => {

        const date =

          getLocalDateString(

            new Date(
              record.recorded_at
            )

          );


        const tripKey =

          record.trip_client_uid ||
          "__unclassified__";


        const key =

          date +
          "|" +
          tripKey;


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


        groups
          .get(
            key
          )
          .push(
            record
          );

      }
    );


  for (
    const group of
    groups.values()
  ) {

    group.sort(
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
      group.length <
      2
    ) {

      continue;

    }


    const points =

      group.map(
        record => [

          Number(
            record.latitude
          ),

          Number(
            record.longitude
          )

        ]
      );


    L.polyline(
      points,
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

}


/* =========================================================
   EVENT BINDING
========================================================= */

let eventsBound =
  false;


function bindFootprintEvents() {

  if (
    eventsBound
  ) {

    return;

  }


  eventsBound =
    true;


  el(
    "footprintGpsButton"
  )
  ?.addEventListener(
    "click",
    getFootprintGPS
  );


  el(
    "saveFootprintButton"
  )
  ?.addEventListener(
    "click",
    saveFootprint
  );


  el(
    "cancelFootprintEditButton"
  )
  ?.addEventListener(
    "click",
    resetFootprintForm
  );


  el(
    "footprintSearch"
  )
  ?.addEventListener(
    "input",
    renderFootprints
  );


  el(
    "footprintTypeFilter"
  )
  ?.addEventListener(
    "change",
    renderFootprints
  );


  el(
    "footprintScopeFilter"
  )
  ?.addEventListener(
    "change",
    renderFootprints
  );


  el(
    "footprintTrip"
  )
  ?.addEventListener(
    "change",
    () => {

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
     TYPE GRID
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


      selectNearbyPlace(

        Number(
          button.dataset.nearbyIndex
        )

      );

    }
  );


  /* =====================================================
     LIST
  ===================================================== */

  el(
    "footprintList"
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
        action ===
        "toggle-date"
      ) {

        const date =
          button.dataset.date;


        if (
          collapsedDates.has(
            date
          )
        ) {

          collapsedDates.delete(
            date
          );

        }
        else {

          collapsedDates.add(
            date
          );

        }


        renderFootprints();


        return;

      }


      const clientUid =
        button.dataset.clientUid;


      if (
        action ===
        "edit-footprint"
      ) {

        editFootprint(
          clientUid
        );

      }


      if (
        action ===
        "delete-footprint"
      ) {

        deleteFootprint(
          clientUid
        );

      }

    }
  );

}
