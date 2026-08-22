/* Wall panel dashboard — PLACE LOOKUP (pure).

   Turning "portland" into a latitude and a longitude. Open-Meteo's geocoding service
   answers the same shape of JSON its forecast does and needs no key, which is why it is
   the one used: the panel already talks to that host for the weather itself, so choosing
   a town adds no new party to the conversation.

   Everything here is a pure function of its arguments — no DOM, no network, no clock — so
   the awkward half (a country with no region, two towns of the same name, a response with
   no results at all) is tested directly. The fetching and the drawing live in
   wx-settings.js, which is where the screen is.

   Flat file, no wx- prefix: this registers no widget and owns no card.
*/

(function () {
  "use strict";

  var ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
  var MAX_RESULTS = 6;          // what fits the Settings section without it becoming a list
  var MAX_QUERY = 60;

  /* Two characters is where the service starts returning anything useful, and it is also
     the point below which a wall panel would be firing a request per keystroke. */
  function usable(q) {
    return String(q == null ? "" : q).trim().length >= 2;
  }

  function searchUrl(q, count) {
    var n = Math.min(MAX_RESULTS, Math.max(1, parseInt(count, 10) || MAX_RESULTS));
    return ENDPOINT
      + "?name=" + encodeURIComponent(String(q == null ? "" : q).trim().slice(0, MAX_QUERY))
      + "&count=" + n
      + "&language=en&format=json";
  }

  /* "Portland, Oregon · United States" — the region matters more than the country here,
     because the ambiguity a person is actually resolving is nearly always two towns of the
     same name in the same country. Either half may be missing (city states, small islands)
     and neither is repeated when the service sends the region as the country's own name. */
  function whereOf(r) {
    var bits = [];
    if (r.admin1) bits.push(String(r.admin1));
    if (r.country && String(r.country) !== String(r.admin1 || "")) bits.push(String(r.country));
    return bits.join(" · ");
  }

  /* A result is only worth offering if it can actually be used as a location, so anything
     without two real coordinates is dropped rather than shown and then silently ignored. */
  function usableResult(r) {
    if (!r || typeof r !== "object") return null;
    /* Number(null) is 0 and 0 is a real latitude, so the absent case has to be caught
       before the conversion — otherwise a result with no coordinates at all is offered as
       a place in the Gulf of Guinea. */
    if (r.latitude == null || r.longitude == null) return null;
    var lat = Number(r.latitude), lon = Number(r.longitude);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    var name = String(r.name == null ? "" : r.name).trim();
    if (!name) return null;
    return { name: name, latitude: lat, longitude: lon, where: whereOf(r) };
  }

  /* The service happily returns a town and its own suburb as two hits with the same name
     a kilometre apart, which on a six-row list is five wasted rows. Same name and same
     region within a tenth of a degree is one place as far as a weather panel is concerned. */
  var SAME_DEG = 0.1;
  function dedupe(list) {
    var out = [];
    list.forEach(function (r) {
      var dup = out.some(function (k) {
        return k.name.toLowerCase() === r.name.toLowerCase()
          && k.where === r.where
          && Math.abs(k.latitude - r.latitude) < SAME_DEG
          && Math.abs(k.longitude - r.longitude) < SAME_DEG;
      });
      if (!dup) out.push(r);
    });
    return out;
  }

  /* payload -> [{name, where, latitude, longitude}]. Anything unexpected is an empty list,
     never a throw: the caller's job is then to say "nothing found", which is the honest
     thing to show for a service that answered with something we cannot read. */
  function parse(payload) {
    var raw = payload && Array.isArray(payload.results) ? payload.results : [];
    var out = [];
    raw.forEach(function (r) {
      var u = usableResult(r);
      if (u) out.push(u);
    });
    return dedupe(out).slice(0, MAX_RESULTS);
  }

  /* What gets stored once a row is tapped: the three fields every widget reads, and the
     region kept in the name so the dashboard says "Portland, Oregon" rather than leaving
     two towns looking identical. The name is the only part anybody ever sees. */
  function toPlace(r) {
    if (!r) return null;
    var name = r.name;
    var region = String(r.where || "").split(" · ")[0];
    if (region && region !== name) name = name + ", " + region;
    return { name: name, latitude: r.latitude, longitude: r.longitude };
  }

  WP.geo = {
    ENDPOINT: ENDPOINT,
    MAX_RESULTS: MAX_RESULTS,
    usable: usable,
    searchUrl: searchUrl,
    parse: parse,
    toPlace: toPlace
  };
})();
