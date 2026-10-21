import { TreeGrid, TreeGridSourceType } from '/base-standard/ui/tree-grid/tree-grid.js';
import TechTree from '/base-standard/ui/tech-tree/model-tech-tree.js';
import CultureTree from '/base-standard/ui/culture-tree/model-culture-tree.js';
import { Audio } from '/core/ui/audio-base/audio-support.js';
import { toggleQueued, queuedTargets, researchOrder, onQueueChanged } from './queue.js';

const SCREENS = {
  "screen-tech-tree": "tech",
  "screen-culture-tree": "culture"
};

const LEFT_BUTTON = 0;
// Tree screens pan by dragging, so a release this far from the press was a drag, not a click.
const DRAG_THRESHOLD_PX = 6;

function kindOfGrid(grid) {
  switch (grid.treeType) {
    case TreeGridSourceType.TECHS:
      return "tech";
    case TreeGridSourceType.CULTURE:
      return "culture";
    default:
      return null;
  }
}

const orderCache = { tech: [], culture: [] };

function positionOf(kind, node, depth) {
  const index = orderCache[kind].indexOf(`${node}:${depth}`);
  return index >= 0 ? index + 1 : 0;
}

function applyQueueOrder(grid) {
  const kind = kindOfGrid(grid);
  const cards = grid._treeData?.cards;
  if (!kind || !cards) {
    return;
  }
  orderCache[kind] = researchOrder(kind);
  const targets = queuedTargets(kind);
  if (targets.length < 2 && !targets.some((entry) => entry.depth > 1)) {
    return;
  }
  for (const card of cards) {
    const position = positionOf(kind, card.nodeType, 1);
    card.isQueued = position > 0;
    card.queueOrder = (position > 0 ? position : -1).toString();
  }
}

// The base card only draws a queued state and number on a card's base level, so a queued
// Mastery level gets the same look and its own number applied to its element directly.
const QUEUED_CHILD_BACKGROUND = 'url("fs://game/techtree_child-node_selected")';
// The engine reads the url back without its quotes, so the style string cannot say whether the
// mod set it; a class of the mod's own does.
const QUEUED_CHILD_CLASS = "tcq-queued-bg";

function decorateMastery(kind, element) {
  const node = Number(element.id.slice("tree-card-type-".length));
  const position = positionOf(kind, node, levelOf(element) + 1);
  const background = element.querySelector(".tree-card-child-bg");
  let badge = element.querySelector(".tcq-queue-order");
  if (position > 0) {
    if (background && !background.classList.contains(QUEUED_CHILD_CLASS)) {
      background.classList.add(QUEUED_CHILD_CLASS);
      background.style.backgroundImage = QUEUED_CHILD_BACKGROUND;
    }
    if (!badge) {
      const container = element.querySelector(".tree-card-name-container");
      if (!container) {
        return;
      }
      badge = document.createElement("div");
      badge.classList.add("tree-card-queue-order", "tcq-queue-order", "font-body", "text-xs", "text-accent-2", "mr-1");
      badge.style.display = "flex";
      container.insertBefore(badge, container.querySelector(".turn-text"));
    }
    if (badge.textContent !== String(position)) {
      badge.textContent = String(position);
    }
  } else {
    if (background?.classList.contains(QUEUED_CHILD_CLASS)) {
      background.classList.remove(QUEUED_CHILD_CLASS);
      background.style.removeProperty("background-image");
    }
    badge?.parentNode?.removeChild(badge);
  }
}

function decorateScreens() {
  for (const [tag, kind] of Object.entries(SCREENS)) {
    const screen = document.querySelector(tag);
    if (screen) {
      screen.querySelectorAll(".tree-card--mastery").forEach((element) => decorateMastery(kind, element));
    }
  }
}

setInterval(decorateScreens, 250);

const baseGenerateData = TreeGrid.prototype.generateData;
TreeGrid.prototype.generateData = function(...args) {
  baseGenerateData.apply(this, args);
  applyQueueOrder(this);
};

onQueueChanged((kind) => {
  orderCache[kind] = researchOrder(kind);
  const model = kind === "tech" ? TechTree : CultureTree;
  model.updateGate.call("TechAndCivicQueue");
});

function isShiftHeld(event) {
  // Mouse events here report shiftKey false while Shift is held, so the engine is asked too.
  return event.shiftKey || (typeof Input?.isShiftDown === "function" && Input.isShiftDown());
}

// The engine withholds its mouse actions while a modifier is held, so the base card activation
// normally never fires on a Shift-click; this keeps it from also replacing the queue if it does.
function guardScreen(tag) {
  const prototype = Controls.getDefinition(tag)?.createInstance?.prototype;
  if (!prototype || prototype.tcqGuarded || typeof prototype.handleCardActivate !== "function") {
    return;
  }
  const baseHandleCardActivate = prototype.handleCardActivate;
  prototype.handleCardActivate = function(...args) {
    if (typeof Input?.isShiftDown === "function" && Input.isShiftDown()) {
      return;
    }
    return baseHandleCardActivate.apply(this, args);
  };
  prototype.tcqGuarded = true;
}

// Each level of a card is its own element with the id tree-card-type-<node>; only the base
// level carries the parent-node class, and the level index is read where the engine exposes it.
function levelOf(element) {
  const raw = element.dataLevel ?? element.getAttribute("data-level");
  if (raw != null && raw !== "" && Number.isInteger(Number(raw))) {
    return Number(raw);
  }
  return element.classList.contains("parent-node") ? 0 : 1;
}

function findCardAndScreen(element) {
  let card = null;
  for (let node = element; node; node = node.parentElement) {
    const tag = node.tagName?.toLowerCase();
    if (card === null && typeof node.id === "string" && node.id.startsWith("tree-card-type-")) {
      card = { node: Number(node.id.slice("tree-card-type-".length)), depth: levelOf(node) + 1 };
    }
    if (tag === "tree-card-v2" && card === null) {
      card = { node: Number(node.getAttribute("type")), depth: 1 };
    }
    if (SCREENS[tag]) {
      return card === null ? null : { kind: SCREENS[tag], ...card };
    }
  }
  return null;
}

let pressX = 0;
let pressY = 0;
let pressed = false;

window.addEventListener("mousedown", (event) => {
  if (event.button !== LEFT_BUTTON) {
    return;
  }
  pressed = true;
  Object.keys(SCREENS).forEach(guardScreen);
  pressX = event.clientX;
  pressY = event.clientY;
}, true);

window.addEventListener("mouseup", (event) => {
  if (event.button !== LEFT_BUTTON) {
    return;
  }
  const dragged = !pressed || Math.abs(event.clientX - pressX) > DRAG_THRESHOLD_PX || Math.abs(event.clientY - pressY) > DRAG_THRESHOLD_PX;
  pressed = false;
  if (dragged || !isShiftHeld(event)) {
    return;
  }
  const hit = findCardAndScreen(event.target);
  if (!hit || Number.isNaN(hit.node)) {
    return;
  }
  try {
    if (toggleQueued(hit.kind, hit.node, hit.depth)) {
      Audio.playSound("data-audio-queue-hover", hit.kind === "tech" ? "audio-screen-tech-tree" : "audio-screen-culture-tree-progression");
    }
  } catch (error) {
    console.error(`[TCQ] Shift-click failed: ${error}`);
  }
}, true);

Object.keys(SCREENS).forEach(guardScreen);
console.error("[TCQ] loaded: Shift-click queue active in the tech and civic trees");
