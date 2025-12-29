/**
 * DemoMed assessment solution
 * Node.js 18+ (fetch incluido)
 *
 * Uso:
 *   API_KEY=ak_... node submit.js
 *
 * Opcional:
 *   LIMIT=20 API_KEY=... node submit.js
 */

const BASE_URL = "https://assessment.ksensetech.com/api";
const API_KEY = process.env.API_KEY; // NO hardcodear en repo
const LIMIT = Math.min(Number(process.env.LIMIT || 5), 20);

if (!API_KEY) {
  console.error(
    "Missing API_KEY env var. Example: API_KEY=ak_... node submit.js"
  );
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(ms) {
  const j = Math.floor(Math.random() * 250);
  return ms + j;
}

async function fetchWithRetry(url, options = {}, maxRetries = 6) {
  let attempt = 0;
  let backoff = 400;

  while (true) {
    attempt++;
    try {
      getAllPatients;
      const res = await fetch(url, options);

      // Rate limit
      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const wait = retryAfter ? Number(retryAfter) * 1000 : jitter(backoff);
        if (attempt > maxRetries)
          throw new Error(`429 too many requests after ${maxRetries} retries`);
        await sleep(wait);
        backoff *= 2;
        continue;
      }

      // Intermittent errors
      if ([500, 503].includes(res.status)) {
        if (attempt > maxRetries)
          throw new Error(`${res.status} after ${maxRetries} retries`);
        await sleep(jitter(backoff));
        backoff *= 2;
        continue;
      }

      // Other non-OK
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }

      // Sometimes APIs return weird content-types; be defensive
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      // Network/parse error: retry too
      if (attempt > maxRetries) throw err;
      await sleep(jitter(backoff));
      backoff *= 2;
    }
  }
}

/** ---------- Parsing + Scoring ---------- **/

function parseNumberStrict(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;

  // If string, trim and parse. Reject non-numeric like "TEMP_ERROR"
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    // Only accept standard numeric forms
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function parseBloodPressure(bp) {
  // Valid examples: "120/80"
  // Invalid: "150/" "/90" "N/A" null
  if (bp === null || bp === undefined) return { ok: false };
  if (typeof bp !== "string") return { ok: false };
  const s = bp.trim();
  if (!s) return { ok: false };

  const parts = s.split("/");
  if (parts.length !== 2) return { ok: false };

  const sys = parseNumberStrict(parts[0].trim());
  const dia = parseNumberStrict(parts[1].trim());

  if (sys === null || dia === null) return { ok: false };
  return { ok: true, sys, dia };
}

function bpScore(bpStr) {
  const p = parseBloodPressure(bpStr);
  if (!p.ok) return 0;

  const { sys, dia } = p;

  // Normal: sys < 120 AND dia < 80 => 1
  if (sys < 120 && dia < 80) return 1;

  // Elevated: sys 120-129 AND dia < 80 => 2
  if (sys >= 120 && sys <= 129 && dia < 80) return 2;

  // Stage 1: sys 130-139 OR dia 80-89 => 3
  if ((sys >= 130 && sys <= 139) || (dia >= 80 && dia <= 89)) return 3;

  // Stage 2: sys >= 140 OR dia >= 90 => 4
  if (sys >= 140 || dia >= 90) return 4;

  // Fallback (shouldn't happen)
  return 0;
}

function tempScore(tempVal) {
  const t = parseNumberStrict(tempVal);
  if (t === null) return 0;

  if (t <= 99.5) return 0;
  if (t >= 99.6 && t <= 100.9) return 1;
  if (t >= 101.0) return 2;
  return 0;
}

function ageScore(ageVal) {
  const a = parseNumberStrict(ageVal);
  if (a === null) return 0;

  if (a < 40) return 1;
  if (a >= 40 && a <= 65) return 1;
  if (a > 65) return 2;
  return 0;
}

function hasDataQualityIssue(patient) {
  const bpOk = parseBloodPressure(patient?.blood_pressure).ok;
  const tOk = parseNumberStrict(patient?.temperature) !== null;
  const aOk = parseNumberStrict(patient?.age) !== null;

  return !bpOk || !tOk || !aOk;
}

function isFever(patient) {
  const t = parseNumberStrict(patient?.temperature);
  return t !== null && t >= 99.6;
}

function totalRisk(patient) {
  return (
    bpScore(patient?.blood_pressure) +
    tempScore(patient?.temperature) +
    ageScore(patient?.age)
  );
}

/** ---------- Fetch all patients (pagination) ---------- **/

async function getAllPatients() {
  const all = [];
  let page = 1;
  let totalPages = null;

  while (true) {
    const url = `${BASE_URL}/patients?page=${page}&limit=${LIMIT}`;
    const json = await fetchWithRetry(url, {
      method: "GET",
      headers: { "x-api-key": API_KEY },
    });

    const data = Array.isArray(json?.data) ? json.data : [];
    all.push(...data);

    // intenta leer totalPages si existe (aunque venga como string)
    const tp = json?.pagination?.totalPages ?? json?.pagination?.total_pages;
    if (tp !== null && tp !== undefined) totalPages = Number(tp);

    const hasNextRaw = json?.pagination?.hasNext ?? json?.pagination?.has_next;

    // 1) Si hay totalPages, esa es la verdad
    if (Number.isFinite(totalPages)) {
      if (page >= totalPages) break;
      page++;
      await sleep(jitter(150));
      continue;
    }

    // 2) Si hay hasNext boolean real
    if (typeof hasNextRaw === "boolean") {
      if (!hasNextRaw) break;
      page++;
      await sleep(jitter(150));
      continue;
    }

    // 3) Fallback: si devuelve menos que el límite, probablemente acabó
    if (data.length < LIMIT) break;

    // 4) Si devuelve justo LIMIT, intenta próxima página
    page++;
    await sleep(jitter(150));

    // safety guard
    if (page > 200) throw new Error("Pagination safety stop (page > 200)");
  }

  console.log(`Fetched patients: ${all.length}`);
  return all;
}

/** ---------- Submit ---------- **/

async function submitLists(payload) {
  const url = `${BASE_URL}/submit-assessment`;
  return fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(payload),
  });
}

/** ---------- Main ---------- **/

(async function main() {
  const patients = await getAllPatients();

  const highRisk = [];
  const fever = [];
  const dataIssues = [];

  for (const p of patients) {
    const id = p?.patient_id;
    if (!id) continue; // si faltara id, ignora (o podrías trackearlo)

    if (hasDataQualityIssue(p)) dataIssues.push(id);
    if (isFever(p)) fever.push(id);
    if (totalRisk(p) >= 4) highRisk.push(id);
  }

  // de-dup + sort para submission estable
  const uniqSort = (arr) => Array.from(new Set(arr)).sort();

  const payload = {
    high_risk_patients: uniqSort(highRisk),
    fever_patients: uniqSort(fever),
    data_quality_issues: uniqSort(dataIssues),
  };

  console.log("Submitting:");
  console.log(JSON.stringify(payload, null, 2));

  const result = await submitLists(payload);

  console.log("\nServer response:");
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error("Error:", e?.message || e);
  process.exit(1);
});
