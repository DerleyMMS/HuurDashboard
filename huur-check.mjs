// Huurdashboard – verzamelaar
// Draait via GitHub Actions (zie .github/workflows/huur-verzamelaar.yml).
// Haalt het huuraanbod op van een aantal verhuurmakelaars, onthoudt wanneer
// een woning voor het eerst gezien is en schrijft alles naar huur-aanbod.json.
// Het dashboard (index.html) leest dat bestand.
//
// Alleen openbare aanbodpagina's, binnen wat robots.txt toestaat, één keer per
// half uur. Een site die faalt wordt overgeslagen; de rest gaat gewoon door.
//
// Instellingen (GitHub → Settings → Secrets and variables → Actions):
//   Secret   NTFY_TOPIC       ntfy-onderwerp voor pushmeldingen (zonder = geen meldingen)
//   Variable GEBIEDEN         meldingen alleen voor deze plaatsen/wijken, bijv. "Bergschenhoek, Hillegersberg"
//   Variable MAX_HUUR         meldingen alleen tot deze huur, bijv. 1100
//   Variable MIN_SLAAPKAMERS  bijv. 1
//   Variable APP_URL          adres van je dashboard (knop in de melding)
//   Variable POSTCODES        postcodegebied voor landelijke sites, standaard "2200-3399"
//                             (grofweg Zuid-Holland). "alles" = geen filter.
// Leeg laten = geen filter op dat punt.
//
// Testen zonder internet:  node huur-check.mjs --fixtures

import { readFile, writeFile } from "node:fs/promises";

const FIXTURES = process.argv.includes("--fixtures");
const OUT_FILE = new URL("./huur-aanbod.json", import.meta.url);
const UA = "Mozilla/5.0 (compatible; Huurdashboard/1.0; persoonlijk gebruik)";

const pcRange = (process.env.POSTCODES || "2200-3399").trim();
const [PC_MIN, PC_MAX] = /^alles$/i.test(pcRange) ? [0, 9999] : pcRange.split("-").map((s) => parseInt(s, 10));
const inRegio = (postcode) => {
  const n = parseInt(String(postcode || "").replace(/\D/g, "").slice(0, 4), 10);
  if (!n) return true; // onbekend: niet wegfilteren
  return n >= PC_MIN && n <= (PC_MAX || 9999);
};

// Snel controleren: van sites met meerdere pagina's alleen verder bladeren als
// pagina 1 iets nieuws bevat. Eén keer per uur alles helemaal nalopen.
const VORIGE = await readFile(OUT_FILE, "utf8").then(JSON.parse).catch(() => ({ woningen: [], bronnen: {} }));
const KENT = new Set((VORIGE.woningen || []).map((w) => w.url));
const VOL = FIXTURES || !VORIGE.laatsteVolledig || Date.now() - new Date(VORIGE.laatsteVolledig) > 55 * 60000;

// ---------- hulpjes ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", sup2: "²", "#039": "'", "#038": "&", "#8211": "–", "#8217": "’" };
const decode = (s) =>
  String(s || "")
    .replace(/&(#?\w+);/g, (m, k) => (k in ENT ? ENT[k] : /^#\d+$/.test(k) ? String.fromCharCode(+k.slice(1)) : m));
const strip = (s) => decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const num = (s) => {
  const m = String(s || "").replace(/\./g, "").match(/\d+(,\d+)?/);
  return m ? Math.round(parseFloat(m[0].replace(",", "."))) : 0;
};
const pick = (html, re) => {
  const m = html.match(re);
  return m ? m[1] : "";
};
// Knipt html in blokken die met een bepaald patroon beginnen.
const blocks = (html, startRe) => {
  const idx = [];
  const re = new RegExp(startRe.source, "g");
  let m;
  while ((m = re.exec(html))) idx.push(m.index);
  return idx.map((s, i) => html.slice(s, idx[i + 1] ?? html.length));
};
const abs = (base, u) => {
  if (!u) return "";
  try {
    return new URL(u.startsWith("//") ? "https:" + u : u, base).href;
  } catch {
    return "";
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, type = "text") {
  if (FIXTURES) throw new Error("geen netwerk in fixture-modus");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: type === "json" ? "application/json" : "text/html" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} gaf status ${res.status}`);
    return type === "json" ? await res.json() : await res.text();
  } finally {
    clearTimeout(t);
  }
}
const fixture = async (name, type = "text") => {
  const txt = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return type === "json" ? JSON.parse(txt) : txt;
};

// Haalt pagina's op tot er niets nieuws meer komt of het maximum bereikt is.
async function pages(urlFor, parse, max, fixName) {
  if (FIXTURES) return parse(await fixture(fixName));
  const all = [];
  const seen = new Set();
  for (let p = 1; p <= max; p++) {
    let html;
    try {
      html = await get(urlFor(p));
    } catch (e) {
      if (p === 1) throw e;
      break; // pagina bestaat niet (meer)
    }
    const items = parse(html).filter((i) => !seen.has(i.url));
    if (!items.length) break;
    items.forEach((i) => seen.add(i.url));
    all.push(...items);
    if (!VOL && items.every((i) => KENT.has(i.url))) {
      all.partial = true; // niets nieuws: de rest van de pagina's is nog hetzelfde
      break;
    }
    await sleep(800);
  }
  return all;
}

// ---------- parsers per site ----------
// Elke parser geeft: { url, adres, plaats, postcode?, prijs, slaapkamers?, kamers?, m2, foto, lat?, lng?, datum? }

function parseRdam(html) {
  return blocks(html, /<div class="rhea_property_card_ele_stylish_inner"/).map((b) => {
    const url = pick(b, /class="rhea_permalink[^"]*" href="([^"]+)"/) || pick(b, /<h3[^>]*><a href="([^"]+)"/);
    const loc = pick(b, /data-rhea-map-location="([^"]+)"/).split(",");
    const adresHtml = pick(b, /class="rhea_address_sty">([\s\S]*?)<\/div>/)
      .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<svg[\s\S]*?<\/svg>/gi, "");
    const full = strip(adresHtml);
    const delen = full.split(",").map((s) => s.trim()).filter(Boolean);
    const postcode = (full.match(/\b\d{4}\s?[A-Z]{2}\b/) || [""])[0];
    const plaatsIdx = delen.findIndex((d) => /zuid-holland|noord-holland|utrecht|nederland/i.test(d));
    let plaats = "", wijk = "";
    if (plaatsIdx > 0) {
      plaats = delen[plaatsIdx - 1];
      wijk = delen.slice(1, Math.max(1, plaatsIdx - 1)).join(", ");
    } else {
      // Kort adres, bijv. "Straat 1, 3031 SX Rotterdam" of alleen "Straat 1".
      const rest = delen.slice(1).map((d) => d.replace(/\b\d{4}\s?[A-Z]{2}\b/, "").trim()).filter(Boolean);
      plaats = rest.length ? rest[rest.length - 1] : "";
      wijk = rest.slice(0, -1).join(", ");
    }
    // Zonder plaats: Rdam Makelaars verhuurt (vrijwel) alleen in Rotterdam.
    if (!plaats || /\d/.test(plaats)) plaats = "Rotterdam";
    const metaVal = (label) => {
      const m = b.match(new RegExp(label + "</span>[\\s\\S]*?<span class=\"figure\">([^<]+)</span>"));
      return m ? num(m[1]) : 0;
    };
    return {
      url,
      adres: strip(pick(b, /<h3[^>]*>([\s\S]*?)<\/h3>/)),
      plaats,
      wijk,
      postcode,
      prijs: num(pick(b, /data-rhea-map-price="([^"]+)"/) || pick(b, /rh_prop_card__price_sty[^>]*>([\s\S]*?)<\/p>/)),
      slaapkamers: metaVal("Slaapkamers"),
      m2: metaVal("Oppervlakte"),
      foto: pick(b, /data-rhea-map-thumb="([^"]+)"/) || pick(b, /<img[^>]+src="([^"]+)"/),
      lat: parseFloat(loc[0]) || null,
      lng: parseFloat(loc[1]) || null,
      type: strip(pick(b, /rhea_prop_status_sty[^>]*>([\s\S]*?)<\/span>/)),
    };
  }).filter((i) => i.url && !/winkel|bedrijf|kantoor|garage|parkeer/i.test(i.type));
}

function parseRiva(html) {
  return blocks(html, /<a class="status-[^"]*" href=/)
    .filter((b) => /^<a class="status-beschikbaar/.test(b))
    .map((b) => {
      const titel = strip(pick(b, /<h3 class="wtfy-pararius-title">([\s\S]*?)<\/h3>/));
      const [straat, plaats] = titel.split(",").map((s) => s.trim());
      const li = [...b.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => strip(m[1]));
      return {
        url: pick(b, /href="([^"]+)"/),
        adres: straat || titel,
        plaats: plaats || "",
        prijs: num(li.find((s) => /€/.test(s))),
        slaapkamers: num(li.find((s) => /slaapkamer/.test(s))),
        m2: num(li.find((s) => /m²|m2/.test(s))),
        foto: pick(b, /<div class="wtfy-pararius-image"><img[^>]+src="([^"]+)"/),
      };
    });
}

function parseVoorberg(html) {
  return blocks(html, /<div class="object object-status-/)
    .filter((b) => /^<div class="object object-status-beschikbaar/.test(b))
    .map((b) => {
      const kamers = strip(pick(b, /object-feature-aantalkamers[\s\S]*?object-feature-info[^>]*>([\s\S]*?)<\/div>/));
      return {
        url: pick(b, /<a href="([^"]+)"/),
        adres: [strip(pick(b, /object-street">([\s\S]*?)<\/span>/)), strip(pick(b, /object-housenumber">([\s\S]*?)<\/span>/))].join(" ").trim(),
        plaats: strip(pick(b, /object-place">([\s\S]*?)<\/span>/)),
        prijs: num(strip(pick(b, /object-price-rent">\s*<span class="object-price-value">([\s\S]*?)<\/span>/))),
        kamers: num(kamers),
        m2: num(strip(pick(b, /object-feature-woonoppervlakte[\s\S]*?object-feature-info[^>]*>([\s\S]*?)<\/div>/))),
        foto: decode(pick(b, /<img[^>]+data-src="([^"]+)"/)),
      };
    });
}

function parseAtta(html) {
  return blocks(html, /<div class="list__object">/)
    .filter((b) => !/object-list__meta">[\s\S]*?(Verhuurd|Onder optie)[\s\S]*?<\/ul>/i.test(b))
    .map((b) => {
      const area = strip(pick(b, /object-list__area">([\s\S]*?)<\/div>/));
      return {
        url: pick(b, /<a href="([^"]+)"/),
        adres: strip(pick(b, /object-list__address">([\s\S]*?)<\/div>/)),
        plaats: strip(pick(b, /object-list__city">([\s\S]*?)<\/div>/)),
        prijs: num(strip(pick(b, /object-list__price">([\s\S]*?)<\/div>/))),
        kamers: num((area.match(/(\d+)\s*Kamer/i) || [])[1]),
        m2: num((area.match(/(\d+)\s*m/) || [])[1]),
        foto: pick(b, /<img[^>]+src="([^"]+)"/),
      };
    });
}

function parseIkwilhuren(html) {
  return blocks(html, /<div class="card card-woning/).map((b) => {
    const titel = strip(pick(b, /class="stretched-link"[^>]*>([\s\S]*?)<\/a>/));
    const pcPlaats = strip(pick(b, /<\/span>\s*<span>(\d{4}\s?[A-Z]{2}[^<]*)<\/span>/));
    const postcode = (pcPlaats.match(/\d{4}\s?[A-Z]{2}/) || [""])[0];
    const dagen = parseFloat(pick(b, /title="Sinds ([\d.]+) dagen online"/));
    // "Eengezinswoning Molenhof 18" → type + adres
    const tm = titel.match(/^(\S+)\s+(.+)$/);
    return {
      url: abs("https://ikwilhuren.nu", pick(b, /class="stretched-link" href="([^"]+)"/)),
      adres: tm ? tm[2] : titel,
      type: tm ? tm[1] : "",
      plaats: pcPlaats.replace(postcode, "").trim(),
      postcode,
      prijs: num(strip(pick(b, /<span class="fw-bold">([\s\S]*?)<\/span>/))),
      slaapkamers: num(pick(b, /<span>(\d+)\s*slaapkamers?/)),
      m2: num(pick(b, /<span>(\d+)\s*m<sup>/)),
      foto: abs("https://ikwilhuren.nu", pick(b, /src='([^']+)'/) || pick(b, /src="([^"]+thumb[^"]*)"/)),
      datum: isFinite(dagen) ? new Date(Date.now() - dagen * 864e5).toISOString() : null,
    };
  }).filter((i) => i.url && inRegio(i.postcode));
}

function parseFonzt(list) {
  return (list || [])
    .filter((w) => w.acf && w.acf.rentedOut === false)
    .map((w) => ({
      url: w.link,
      adres: strip(w.title?.rendered),
      plaats: String(w.acf.place || "").trim(),
      postcode: String(w.acf.zipcode || "").trim(),
      prijs: num(w.acf.price),
      kamers: num(w.acf.rooms),
      m2: num(w.acf.measure),
      foto: abs("https://fonzt.nl", w.fimg_url || ""),
      datum: w.date ? new Date(w.date + "Z").toISOString() : null,
    }));
}

function parseWoonzeker(json) {
  return (json?.data || [])
    .filter((d) => d.stage === "available" && inRegio(d.address?.postal_code))
    .map((d) => ({
      url: d.external_url || `https://woonzeker.com/huur/woningen/${d.slug}`,
      adres: d.title,
      plaats: d.address?.location || "",
      wijk: d.address?.neighborhood || d.address?.district || "",
      postcode: d.address?.postal_code || "",
      prijs: Math.round(d.handover?.price || 0),
      slaapkamers: d.characteristic?.layout?.number_of_bedrooms || 0,
      m2: d.characteristic?.living_area || 0,
      foto: d.media?.primary_photo || "",
      lat: d.address?.position_lat || null,
      lng: d.address?.position_long || null,
      datum: d.created_at || null,
    }));
}

// ---------- bronnen ----------
const BRONNEN = [
  {
    id: "rdam", naam: "Rdam Makelaars",
    haal: () => pages((p) => `https://rdammakelaars.nl/huurwoningen/${p > 1 ? `page/${p}/` : ""}`, parseRdam, 3, "rdam.html"),
  },
  {
    id: "riva", naam: "Riva Rentals",
    haal: () => pages((p) => `https://rivarentals.nl/aanbod/${p > 1 ? `page/${p}/` : ""}`, parseRiva, 6, "riva.html"),
  },
  {
    id: "voorberg", naam: "Voorberg",
    haal: async () => parseVoorberg(FIXTURES ? await fixture("voorberg.html") : await get("https://www.voorberg.nl/woningaanbod/huur/")),
  },
  {
    id: "fonzt", naam: "FONZT",
    haal: async () => parseFonzt(FIXTURES ? await fixture("fonzt.json", "json") : await get("https://fonzt.nl/wp-json/wp/v2/woning?per_page=100", "json")),
  },
  {
    id: "atta", naam: "Atta Makelaars",
    haal: async () => parseAtta(FIXTURES ? await fixture("atta.html") : await get("https://atta.nl/woningaanbod/huuraanbod/")),
  },
  {
    id: "ikwilhuren", naam: "Ik wil huren",
    haal: () => pages((p) => `https://ikwilhuren.nu/aanbod/${p > 1 ? `?page=${p}` : ""}`, parseIkwilhuren, 8, "ikwilhuren.html"),
  },
  {
    id: "woonzeker", naam: "Woonzeker",
    haal: async () => parseWoonzeker(FIXTURES ? await fixture("woonzeker.json", "json") : await get("https://woonzeker.com/api/ms/listing/properties?perPage=100&page=1&sort=-created_at", "json")),
  },
];


// ---------- locatie (voor de kaart) ----------
// Sites zonder coördinaten worden opgezocht bij de PDOK Locatieserver (de
// openbare adreszoeker van de overheid). Resultaten worden onthouden in
// huur-aanbod.json, dus elk adres wordt maar één keer opgezocht.
async function geocode(adres, plaats, postcode) {
  const q = [adres, postcode, plaats].filter(Boolean).join(" ");
  const url = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=1&fl=centroide_ll,type&fq=type:(adres%20OR%20weg%20OR%20postcode)&q=" + encodeURIComponent(q);
  const j = await get(url, "json");
  const m = String(j?.response?.docs?.[0]?.centroide_ll || "").match(/POINT\(([\d.]+) ([\d.]+)\)/);
  return m ? { lat: +(+m[2]).toFixed(6), lng: +(+m[1]).toFixed(6) } : null;
}

// ---------- hoofdprogramma ----------
const vorige = VORIGE;
const eerder = new Map((vorige.woningen || []).map((w) => [w.id, w]));
const nu = new Date();
const eersteRun = !(vorige.woningen || []).length;

const woningen = [];
const status = {};
for (const bron of BRONNEN) {
  try {
    const items = await bron.haal();
    items.forEach((it, idx) => {
      const id = `${bron.id}:${it.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}`;
      const oud = eerder.get(id);
      // Eerst gezien: van de vorige keer, anders nu. Bij de allereerste run de
      // volgorde van de site aanhouden (bovenaan = nieuwst), of de datum van de site.
      let gezien = oud?.eersteGezien;
      if (!gezien) {
        if (it.datum) gezien = it.datum;
        else gezien = new Date(nu.getTime() - (eersteRun ? idx * 60000 : 0)).toISOString();
      }
      woningen.push({
        id, bron: bron.id, bronNaam: bron.naam,
        adres: it.adres || "", plaats: it.plaats || "", wijk: it.wijk || "", postcode: it.postcode || "",
        prijs: it.prijs || 0, slaapkamers: it.slaapkamers || 0, kamers: it.kamers || 0, m2: it.m2 || 0,
        type: it.type || "", url: it.url, foto: it.foto || "",
        lat: it.lat ?? null, lng: it.lng ?? null,
        eersteGezien: gezien,
      });
    });
    let aantal = items.length;
    if (items.partial) {
      // Alleen pagina 1 bekeken: de rest van de vorige keer aanhouden.
      const hier = new Set(woningen.filter((w) => w.bron === bron.id).map((w) => w.id));
      const rest = (vorige.woningen || []).filter((w) => w.bron === bron.id && !hier.has(w.id));
      woningen.push(...rest);
      aantal += rest.length;
    }
    status[bron.id] = { naam: bron.naam, ok: true, aantal, tijd: nu.toISOString() };
    console.log(`✓ ${bron.naam}: ${aantal} woningen${items.partial ? " (alleen pagina 1 bekeken, niets nieuws)" : ""}`);
  } catch (e) {
    // Mislukt: houd de woningen van de vorige keer aan, zodat ze niet "verdwijnen".
    const oud = (vorige.woningen || []).filter((w) => w.bron === bron.id);
    woningen.push(...oud);
    status[bron.id] = { naam: bron.naam, ok: false, aantal: oud.length, fout: String(e.message || e).slice(0, 200), tijd: vorige.bronnen?.[bron.id]?.tijd || null };
    console.log(`::warning::${bron.naam} overgeslagen: ${e.message || e}`);
  }
}

woningen.sort((a, b) => (b.eersteGezien || "").localeCompare(a.eersteGezien || ""));

const geoCache = vorige.geo || {};
let opgezocht = 0;
for (const w of woningen) {
  if (w.lat && w.lng) continue;
  const key = `${w.adres}|${w.postcode}|${w.plaats}`.toLowerCase();
  if (!(key in geoCache) && !FIXTURES && opgezocht < 150) {
    opgezocht++;
    try {
      geoCache[key] = await geocode(w.adres, w.plaats, w.postcode);
    } catch (e) {
      console.log(`Adres niet gevonden: ${w.adres}, ${w.plaats} (${e.message || e})`);
    }
    await sleep(120);
  }
  const g = geoCache[key];
  if (g) { w.lat = g.lat; w.lng = g.lng; }
}
if (opgezocht) console.log(`Locatie opgezocht voor ${opgezocht} adressen.`);

// ---------- pushmeldingen ----------
const env = (k) => (process.env[k] || "").trim();
const TOPIC = env("NTFY_TOPIC").replace(/\s+/g, "").replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").replace(/^(https?:\/\/)?ntfy\.sh\//i, "").replace(/\/+$/, "");
const GEBIEDEN = env("GEBIEDEN").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_HUUR = parseFloat(env("MAX_HUUR").replace(",", ".")) || 0;
const MIN_SLPK = parseInt(env("MIN_SLAAPKAMERS"), 10) || 0;
const APP_URL = env("APP_URL") || "https://derleymms.github.io/HuurDashboard/";
const euro = (n) => "€ " + Math.round(n).toLocaleString("nl-NL");

function pastVoorMelding(w) {
  const tekst = `${w.adres} ${w.wijk} ${w.plaats} ${w.postcode}`.toLowerCase();
  if (GEBIEDEN.length && !GEBIEDEN.some((g) => tekst.includes(g))) return false;
  if (MAX_HUUR && (!w.prijs || w.prijs > MAX_HUUR)) return false;
  const slpk = w.slaapkamers || (w.kamers ? w.kamers - 1 : 0);
  if (MIN_SLPK && slpk && slpk < MIN_SLPK) return false;
  return true;
}

async function stuur(msg) {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const res = await fetch("https://ntfy.sh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: TOPIC, ...msg }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return true;
      console.log(`ntfy gaf status ${res.status}: ${await res.text()}`);
      if (res.status < 500 && res.status !== 429) return false;
    } catch (e) {
      console.log(`ntfy niet bereikbaar (poging ${poging}/3): ${e.cause?.code || e.name || e.message}`);
    }
    if (poging < 3) await sleep(poging * 4000);
  }
  return false;
}

function meldingVoor(w) {
  const waar = [...new Set([w.wijk, w.plaats].filter(Boolean))].join(", ");
  const kamers = w.slaapkamers ? `${w.slaapkamers} slpk` : w.kamers ? `${w.kamers} kamers` : "";
  return {
    title: `${w.bronNaam}: ${w.adres}`,
    message: [[w.prijs ? euro(w.prijs) + " p/m" : "Prijs onbekend", w.m2 ? `${w.m2} m²` : "", kamers].filter(Boolean).join(" · "), waar].filter(Boolean).join("\n"),
    tags: ["house"],
    priority: 4,
    click: w.url,
    ...(w.foto ? { attach: w.foto, filename: "woning.jpg" } : {}),
    actions: [{ action: "view", label: "Bekijk woning", url: w.url }, { action: "view", label: "Dashboard", url: APP_URL }],
  };
}

let teMelden = [];
const TOPIC_OK = /^[-_A-Za-z0-9]{1,64}$/.test(TOPIC);

// Testmelding (knop "Run workflow" met het vinkje "Testmelding sturen" aan)
if (/^(true|ja|1)$/i.test(env("TESTMELDING"))) {
  if (!TOPIC) console.log("::error::Testmelding niet verstuurd: NTFY_TOPIC ontbreekt in Settings → Secrets and variables → Actions.");
  else if (!TOPIC_OK) console.log("::error::Testmelding niet verstuurd: NTFY_TOPIC is geen geldig ntfy-onderwerp (alleen letters, cijfers, - en _).");
  else {
    const voorbeeld = woningen.find(pastVoorMelding) || woningen[0];
    const msg = voorbeeld ? meldingVoor(voorbeeld) : { message: "Er staan nu geen woningen in het overzicht.", click: APP_URL };
    msg.title = "Testmelding" + (voorbeeld ? ` · ${voorbeeld.bronNaam}: ${voorbeeld.adres}` : "");
    msg.message = `Meldingen werken! Zo ziet een melding eruit.\n${msg.message}`;
    msg.tags = ["white_check_mark"];
    const ok = await stuur(msg);
    console.log(ok ? "Testmelding verstuurd." : "::error::Testmelding kon niet worden verstuurd (ntfy.sh niet bereikbaar).");
  }
}

if (TOPIC && !FIXTURES && TOPIC_OK) {
  // Nieuw = niet in de vorige stand. Een site die er net bij komt telt niet mee
  // (anders krijg je in één keer al zijn woningen als melding).
  const hadBron = new Set((vorige.woningen || []).map((w) => w.bron));
  const open = new Set(vorige.teMelden || []);
  const kandidaten = eersteRun ? [] : woningen.filter((w) => (open.has(w.id) || (!eerder.has(w.id) && hadBron.has(w.bron))) && pastVoorMelding(w));
  console.log(`Meldingen: ${kandidaten.length} nieuwe passende woning(en). Filters: gebieden=${GEBIEDEN.join(" | ") || "(alle)"}, max huur=${MAX_HUUR || "(geen)"}, min slaapkamers=${MIN_SLPK || "(geen)"}`);
  if (kandidaten.length > 5) {
    const regels = kandidaten.slice(0, 8).map((w) => `${w.prijs ? euro(w.prijs) : "?"}  ${w.adres}, ${w.plaats} (${w.bronNaam})`);
    if (kandidaten.length > 8) regels.push(`en nog ${kandidaten.length - 8}`);
    const ok = await stuur({ title: `${kandidaten.length} nieuwe woningen bij makelaars`, message: regels.join("\n"), tags: ["house"], priority: 4, click: APP_URL });
    if (!ok) teMelden = kandidaten.map((w) => w.id);
  } else {
    for (const w of kandidaten) if (!(await stuur(meldingVoor(w)))) teMelden.push(w.id);
  }
  if (teMelden.length) console.log(`::warning::${teMelden.length} melding(en) niet verstuurd; de volgende run probeert het opnieuw.`);
} else if (env("NTFY_TOPIC")) {
  console.log("::warning::NTFY_TOPIC is geen geldig ntfy-onderwerp (alleen letters, cijfers, - en _).");
}

// Alleen wegschrijven als er inhoudelijk iets veranderde (scheelt commits).
const kern = (lijst) => JSON.stringify(lijst.map((w) => [w.id, w.prijs, w.eersteGezien, w.adres, w.plaats, w.wijk, w.lat, w.lng]));
const laatsteVolledig = VOL ? nu.toISOString() : vorige.laatsteVolledig;
const veranderd = kern(woningen) !== kern(vorige.woningen || []) ||
  JSON.stringify(teMelden) !== JSON.stringify(vorige.teMelden || []) || laatsteVolledig !== vorige.laatsteVolledig ||
  JSON.stringify(Object.values(status).map((s) => s.ok)) !== JSON.stringify(Object.values(vorige.bronnen || {}).map((s) => s.ok));

if (veranderd || FIXTURES) {
  const out = { bijgewerkt: nu.toISOString(), laatsteVolledig, bronnen: status, woningen, teMelden, geo: geoCache };
  const doel = FIXTURES ? new URL("./huur-aanbod.test.json", import.meta.url) : OUT_FILE;
  await writeFile(doel, JSON.stringify(out, null, 1));
  console.log(`Opgeslagen: ${woningen.length} woningen.`);
} else {
  console.log("Niets veranderd.");
}
