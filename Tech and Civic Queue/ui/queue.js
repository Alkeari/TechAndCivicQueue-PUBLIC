const TREES = {
  tech: {
    storageKey: "TCQ_TECH_QUEUE",
    setNode: () => PlayerOperationTypes.SET_TECH_TREE_NODE,
    setTarget: () => PlayerOperationTypes.SET_TECH_TREE_TARGET_NODE,
    getTarget: (player) => player.Techs?.getTargetNode(),
    getTreeType: (player) => player.Techs?.getTreeType()
  },
  culture: {
    storageKey: "TCQ_CULTURE_QUEUE",
    setNode: () => PlayerOperationTypes.SET_CULTURE_TREE_NODE,
    setTarget: () => PlayerOperationTypes.SET_CULTURE_TREE_TARGET_NODE,
    getTarget: (player) => player.Culture?.getTargetNode(),
    getTreeType: (player) => player.Culture?.getActiveTree()
  }
};

const states = new Map();
const listeners = [];

// console.log never reaches Logs\UI.log in this engine; console.error does.
function log(message) {
  console.error(`[TCQ] ${message}`);
}

function isRealNode(node) {
  return node != null && node !== -1 && node !== ProgressionTreeNodeTypes.NO_NODE;
}

function reachedDepth(playerId, node) {
  const data = Game.ProgressionTrees.getNode(playerId, node);
  if (!data) {
    return 0;
  }
  const state = Game.ProgressionTrees.getNodeState(playerId, node);
  let depth = data.depthUnlocked ?? 0;
  if (state === ProgressionTreeNodeState.NODE_STATE_UNLOCKED) {
    depth = Math.max(depth, 1);
  }
  if (state === ProgressionTreeNodeState.NODE_STATE_FULLY_UNLOCKED) {
    depth = Math.max(depth, data.maxDepth ?? 1);
  }
  return depth;
}

function isPending(playerId, entry) {
  if (!isRealNode(entry.node)) {
    return false;
  }
  const data = Game.ProgressionTrees.getNode(playerId, entry.node);
  if (!data || Game.ProgressionTrees.getNodeState(playerId, entry.node) === ProgressionTreeNodeState.NODE_STATE_INVALID) {
    return false;
  }
  return entry.depth <= (data.maxDepth ?? 1) && reachedDepth(playerId, entry.node) < entry.depth;
}

// While a Mastery is researched the engine still reports the base level as its target, which is
// already done, so what is really in progress is read from the tree the way tree-grid.js does.
function currentResearch(playerId, kind) {
  const player = Players.get(playerId);
  const treeType = player ? TREES[kind].getTreeType(player) : null;
  const tree = treeType == null ? null : Game.ProgressionTrees.getTree(playerId, treeType);
  const active = tree && tree.activeNodeIndex >= 0 ? tree.nodes?.[tree.activeNodeIndex] : null;
  if (!active || !isRealNode(active.nodeType)) {
    return null;
  }
  return { node: active.nodeType, depth: reachedDepth(playerId, active.nodeType) + 1 };
}

// An empty queue starts from what is being researched: a Mastery in progress first, otherwise
// the engine's target as before.
function adoptCurrent(playerId, kind, player) {
  const current = currentResearch(playerId, kind);
  if (current && current.depth > 1 && isPending(playerId, current)) {
    return { entry: current, active: { node: current.node, depth: current.depth, mode: "direct" } };
  }
  const engineTarget = TREES[kind].getTarget(player);
  if (isPending(playerId, { node: engineTarget, depth: 1 })) {
    return { entry: { node: engineTarget, depth: 1 }, active: { node: engineTarget, depth: 1, mode: "target", confirmed: true } };
  }
  if (current && isPending(playerId, current)) {
    return { entry: current, active: { node: current.node, depth: current.depth, mode: "direct" } };
  }
  return null;
}

function keyOf(entry) {
  return `${entry.node}:${entry.depth}`;
}

function parseEntry(text) {
  const [node, depth] = text.split(":").map(Number);
  return { node, depth: depth || 1 };
}

function stateFor(playerId, kind) {
  const key = `${playerId}:${kind}`;
  let state = states.get(key);
  if (!state) {
    const stored = Players.get(playerId)?.Tutorial?.getProperty(Database.makeHash(TREES[kind].storageKey));
    const targets = typeof stored === "string" && stored.length > 0 ? stored.split(",").map(parseEntry) : [];
    state = { targets, active: null };
    states.set(key, state);
  }
  return state;
}

function serialize(state) {
  return state.targets.map(keyOf).join(",");
}

function save(playerId, kind, state) {
  const player = Players.get(playerId);
  const hash = Database.makeHash(TREES[kind].storageKey);
  const value = serialize(state);
  if (player?.Tutorial && player.Tutorial.getProperty(hash) !== value) {
    player.Tutorial.setProperty(hash, value);
  }
}

function notify(kind) {
  listeners.forEach((listener) => listener(kind));
}

function send(playerId, operation, node) {
  const args = { ProgressionTreeNodeType: node };
  if (!Game.PlayerOperations.canStart(playerId, operation, args, false).Success) {
    return false;
  }
  Game.PlayerOperations.sendRequest(playerId, operation, args);
  return true;
}

// A mastery level is researched by setting the node itself once its base level is done; the
// engine's target only reaches the base level, so masteries are always researched directly.
function activate(playerId, kind, state, entry) {
  const tree = TREES[kind];
  const reached = reachedDepth(playerId, entry.node);
  if (reached >= 1) {
    if (send(playerId, tree.setNode(), entry.node)) {
      state.active = { node: entry.node, depth: reached + 1, mode: "direct" };
      log(`${kind}: researching ${entry.node} level ${reached + 1}`);
      return true;
    }
  } else {
    const args = { ProgressionTreeNodeType: entry.node };
    if (Game.PlayerOperations.canStart(playerId, tree.setTarget(), args, false).Success) {
      send(playerId, tree.setNode(), entry.node);
      Game.PlayerOperations.sendRequest(playerId, tree.setTarget(), args);
      state.active = { node: entry.node, depth: 1, mode: "target", confirmed: false, turn: Game.turn };
      log(`${kind}: targeting ${entry.node}`);
      return true;
    }
    if (send(playerId, tree.setNode(), entry.node)) {
      state.active = { node: entry.node, depth: 1, mode: "direct" };
      log(`${kind}: researching ${entry.node} directly`);
      return true;
    }
  }
  log(`${kind}: ${keyOf(entry)} cannot be researched, dropped from the queue`);
  return false;
}

function activateHead(playerId, kind, state) {
  state.active = null;
  while (state.targets.length > 0 && !activate(playerId, kind, state, state.targets[0])) {
    state.targets.shift();
  }
}

function reconcile(playerId, kind, completedNode) {
  const player = Players.get(playerId);
  if (!player) {
    return;
  }
  const state = stateFor(playerId, kind);
  const before = serialize(state);
  state.targets = state.targets.filter((entry) => isPending(playerId, entry));
  const head = state.targets[0];
  if (!head) {
    state.active = null;
    finish(playerId, kind, state, before);
    return;
  }
  const engineTarget = TREES[kind].getTarget(player);
  const active = state.active;
  if (!active) {
    if (engineTarget === head.node && reachedDepth(playerId, head.node) < 1) {
      state.active = { node: head.node, depth: 1, mode: "target", confirmed: true };
    } else {
      activateHead(playerId, kind, state);
    }
  } else if (reachedDepth(playerId, active.node) >= active.depth || active.node !== head.node) {
    activateHead(playerId, kind, state);
  } else if (active.mode === "target") {
    if (engineTarget === active.node) {
      active.confirmed = true;
    } else if (active.confirmed || Game.turn > active.turn) {
      if (isPending(playerId, { node: engineTarget, depth: 1 })) {
        log(`${kind}: target changed outside the queue to ${engineTarget}, queue replaced`);
        state.targets = [{ node: engineTarget, depth: 1 }];
        state.active = { node: engineTarget, depth: 1, mode: "target", confirmed: true };
      } else {
        log(`${kind}: target cleared outside the queue, queue cleared`);
        state.targets = [];
        state.active = null;
      }
    }
  } else if (completedNode !== void 0 && completedNode !== active.node) {
    activateHead(playerId, kind, state);
  }
  finish(playerId, kind, state, before);
}

function finish(playerId, kind, state, before) {
  if (serialize(state) !== before) {
    save(playerId, kind, state);
    notify(kind);
  }
}

export function toggleQueued(kind, node, depth) {
  const playerId = GameContext.localPlayerID;
  const player = Players.get(playerId);
  const entry = { node, depth };
  if (!player || !isPending(playerId, entry)) {
    return false;
  }
  const state = stateFor(playerId, kind);
  state.targets = state.targets.filter((target) => isPending(playerId, target));
  if (state.targets.length === 0) {
    const adopted = adoptCurrent(playerId, kind, player);
    if (adopted) {
      state.targets = [adopted.entry];
      state.active = adopted.active;
    }
  }
  const index = state.targets.findIndex((target) => keyOf(target) === keyOf(entry));
  if (index >= 0) {
    state.targets.splice(index, 1);
    log(`${kind}: removed ${keyOf(entry)}`);
    if (index === 0) {
      if (state.targets.length > 0) {
        activateHead(playerId, kind, state);
      } else {
        if (state.active?.mode === "target") {
          send(playerId, TREES[kind].setTarget(), ProgressionTreeNodeTypes.NO_NODE);
        }
        state.active = null;
      }
    }
  } else {
    state.targets.push(entry);
    log(`${kind}: queued ${keyOf(entry)} at position ${state.targets.length}`);
    if (state.targets.length === 1) {
      activateHead(playerId, kind, state);
    }
  }
  save(playerId, kind, state);
  notify(kind);
  return true;
}

export function queuedTargets(kind) {
  const playerId = GameContext.localPlayerID;
  return stateFor(playerId, kind).targets.filter((entry) => isPending(playerId, entry));
}

// Every step the queue will research, in order, as "node:depth" keys; depth 1 is the base level.
export function researchOrder(kind) {
  const playerId = GameContext.localPlayerID;
  const ai = Players.get(playerId)?.AI;
  const order = [];
  const add = (key) => {
    if (!order.includes(key)) {
      order.push(key);
    }
  };
  for (const entry of queuedTargets(kind)) {
    const reached = reachedDepth(playerId, entry.node);
    if (reached < 1) {
      for (const step of ai?.getProgressionTreePath(entry.node, 1) ?? []) {
        add(`${step.nodeType}:1`);
      }
      add(`${entry.node}:1`);
    }
    for (let depth = Math.max(2, reached + 1); depth <= entry.depth; depth++) {
      add(`${entry.node}:${depth}`);
    }
  }
  return order;
}

export function onQueueChanged(listener) {
  listeners.push(listener);
}

function reconcileLocal(kind) {
  return (data) => {
    if (data?.player === void 0 || data.player === GameContext.localPlayerID) {
      reconcile(GameContext.localPlayerID, kind, data?.activeNode);
    }
  };
}

engine.whenReady.then(() => {
  engine.on("TechNodeCompleted", reconcileLocal("tech"));
  engine.on("TechTargetChanged", reconcileLocal("tech"));
  engine.on("CultureNodeCompleted", reconcileLocal("culture"));
  engine.on("CultureTargetChanged", reconcileLocal("culture"));
  const both = (data) => {
    reconcileLocal("tech")(data);
    reconcileLocal("culture")(data);
  };
  engine.on("PlayerTurnActivated", both);
  engine.on("LocalPlayerChanged", both);
  both();
});
