import { Options, OptionType, CategoryType } from '/core/ui/options/model-options.js';
import { CategoryData } from '/core/ui/options/options-helpers.js';

const MOD_VERSION = "1.1.0";
const PROJECT_NAME = "Tech and Civic Queue";
const UPDATES_URL = "https://alkeari.com/updates/index.json";
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const NOTICE_ID = "tech-and-civic-queue-update-notice";
const NOTICE_MS = 15000;
const FADE_MS = 400;

// The Add-Ons options tab is not in the base game: Workshop mods create it under the shared key "mods", so each one adds it only if absent.
CategoryType["Mods"] ??= "mods";
CategoryData[CategoryType.Mods] ??= {
  title: "LOC_UI_CONTENT_MGR_SUBTITLE",
  description: "LOC_UI_CONTENT_MGR_SUBTITLE_DESCRIPTION"
};

// Settings live in localStorage under the shared "modSettings" key, in this mod's own entry, since "Mod" user options set through
// UI.setOption never reach UserOptions.txt; Map Trix (Workshop 3507072814) clears all of localStorage when it holds more than one key.
const STORE_KEY = "modSettings";
const MOD_KEY = "tech_and_civic_queue";

function readEntry() {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    const mine = all && typeof all == "object" ? all[MOD_KEY] : null;
    return mine && typeof mine == "object" && !Array.isArray(mine) ? mine : {};
  } catch {
    return {};
  }
}

function writeEntry(update) {
  try {
    let all = {};
    try {
      const held = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
      all = held && typeof held == "object" && !Array.isArray(held) ? held : {};
    } catch {
      all = {};
    }
    all[MOD_KEY] = update(readEntry());
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (error) {
    console.error(`tech-and-civic-queue: setting not saved: ${error}`);
  }
}

export function isUpdateCheckEnabled() {
  return readEntry().checkForUpdates !== 0;
}

function newer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d != 0) return d > 0;
  }
  return false;
}

function showNotice(latest) {
  if (!document.body) return;
  document.getElementById(NOTICE_ID)?.remove();
  const notice = document.createElement("div");
  notice.id = NOTICE_ID;
  notice.classList.add("font-body", "text-sm");
  notice.style.cssText = [
    "position:fixed",
    "top:1.5rem",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:9999",
    "pointer-events:none",
    "padding:0.5rem 1rem",
    "color:#FFF1B3",
    "background:#000000",
    "border:1px solid #FFDA00",
    `transition:opacity ${FADE_MS}ms ease`,
    "opacity:0"
  ].join(";");
  notice.textContent = Locale.compose("LOC_TCQ_UPDATE_AVAILABLE", latest, MOD_VERSION);
  document.body.appendChild(notice);
  requestAnimationFrame(() => notice.style.opacity = "1");
  setTimeout(() => {
    notice.style.opacity = "0";
    setTimeout(() => notice.remove(), FADE_MS + 100);
  }, NOTICE_MS);
}

// Asks alkeari.com for the newest released version, at most once a day, and says so only when it is newer than this one. Nothing is
// sent but the request for that one public file.
async function checkForUpdate() {
  if (!isUpdateCheckEnabled()) return;
  const last = Number(readEntry().lastUpdateCheck) || 0;
  if (Math.abs(Date.now() - last) < CHECK_EVERY_MS) return;
  writeEntry(entry => ({ ...entry, lastUpdateCheck: Date.now() }));
  try {
    const response = await fetch(UPDATES_URL, { cache: "no-cache" });
    if (!response.ok) return;
    const project = (await response.json())?.projects?.find(p => p.name == PROJECT_NAME);
    const latest = (project?.lines ?? []).map(line => line.version).filter(Boolean).reduce((a, b) => newer(b, a) ? b : a, MOD_VERSION);
    if (newer(latest, MOD_VERSION)) showNotice(latest);
  } catch (error) {
    console.warn(`tech-and-civic-queue: update check failed: ${error}`);
  }
}

try {
  Options.addInitCallback(() => {
    Options.addOption({
      category: CategoryType.Mods,
      group: "tech_and_civic_queue",
      type: OptionType.Checkbox,
      id: "tech-and-civic-queue-check-for-updates",
      label: "LOC_OPTIONS_TCQ_CHECK_FOR_UPDATES_LABEL",
      description: "LOC_OPTIONS_TCQ_CHECK_FOR_UPDATES_DESCRIPTION",
      initListener: info => info.currentValue = isUpdateCheckEnabled(),
      updateListener: (info, value) => {
        writeEntry(entry => ({ ...entry, checkForUpdates: value ? 1 : 0 }));
        info.currentValue = isUpdateCheckEnabled();
      }
    });
  });
} catch (error) {
  console.error(`tech-and-civic-queue: options not added: ${error}`);
}

if (!UI.isInGame()) {
  engine.whenReady.then(() => checkForUpdate());
}
