/* Brutus mobile conversation surface.
 *
 * Geometry and reconnect contract forked from
 * clearspeed-demos/public/demos/fnol/fnol-widget.js. Transport is Brutus
 * /api/session/* — never Anam. SNAP_KEY is deliberately not fnolResumeSnapshot
 * so the two surfaces cannot collide, and nothing here writes back to demos/fnol.
 */

const $ = (sel) => document.querySelector(sel);

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("brutus.theme", t);
  } catch {
    /* private mode */
  }
  const btn = $("#theme-toggle");
  if (btn) {
    btn.setAttribute("aria-pressed", t === "light" ? "true" : "false");
    const lab = btn.querySelector(".label");
    if (lab) lab.textContent = t === "light" ? "Light" : "Dark";
  }
}

function initTheme() {
  let cur = "dark";
  try {
    cur = localStorage.getItem("brutus.theme") || "dark";
  } catch {
    /* ignore */
  }
  applyTheme(cur);
  $("#theme-toggle")?.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  });
}

const SNAP_KEY = "brutusMobileResumeSnapshot";
const FRESH_MS = 15 * 60 * 1000;

const state = {
  sessionId: null,
  events: null,
  speaking: false,
  listening: false,
  recognizer: null,
  audio: null,
  muted: false,
  seenTurns: new Set(),
  fields: new Map(),
  wasLive: false,
  sessionComplete: false,
  reconnectCount: 0,
  pendingQuestion: null,
  ideasEs: null,
  boardEs: null,
};

const ideasState = {
  byId: new Map(),
  loadError: null,
  confirmDeleteId: null,
};

const boardState = {
  rows: [],
};

/* --- session ------------------------------------------------------------ */

async function openSession({ forceNew = false } = {}) {
  showConnecting(true);
  try {
    if (!forceNew) {
      const saved = sessionStorage.getItem("brutus.mobile.session");
      if (saved) {
        const ok = await fetch(`/api/session/${saved}`).then((r) => r.ok).catch(() => false);
        if (ok) {
          await hydrate(saved);
          enterLive();
          return;
        }
      }
    }
    const r = await fetch("/api/session/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "mobile" }),
    });
    if (!r.ok) throw new Error(`open failed (${r.status})`);
    const body = await r.json();
    sessionStorage.setItem("brutus.mobile.session", body.session_id);
    await hydrate(body.session_id);
    enterLive();
  } catch (err) {
    setStatus(`Couldn't open a session — ${err.message}`);
    showConnecting(false);
    showPlaceholder();
  }
}

async function hydrate(sessionId) {
  state.sessionId = sessionId;
  state.seenTurns.clear();
  state.fields.clear();
  $("#conversation").innerHTML = "";
  $("#fields").innerHTML = "";
  $("#proposals").innerHTML = "";
  document.getElementById("resumed-note")?.remove();
  if (!$("#fields-empty")) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.id = "fields-empty";
    empty.textContent = "Nothing yet — it fills in as you talk.";
    $("#fields").before(empty);
  } else {
    $("#fields-empty").hidden = false;
  }

  const snap = await fetch(`/api/session/${sessionId}`).then((r) => r.json());
  (snap.turns || []).forEach((t) => renderTurn(t, { animate: false }));
  (snap.fields || []).forEach((f) => renderField(f, { animate: false }));
  (snap.artifacts || []).forEach(renderProposal);
  restoreThinking(snap.turns || []);
  renderCounts();
  connect(sessionId);
  ensurePads();
  showConnecting(false);
}

function connect(sessionId) {
  if (state.events) state.events.close();
  const es = new EventSource(`/api/session/${sessionId}/events`);
  state.events = es;
  es.onopen = () => {
    setConnectionState("live");
    state.wasLive = true;
    state.sessionComplete = false;
    $("#reconnect").hidden = true;
  };
  es.onerror = () => {
    setConnectionState("error");
    // Dropped mid-session with progress → offer reconnect (FNOL contract).
    if (state.wasLive && !state.sessionComplete) {
      const resume = scrapeResume();
      if (resume.hasProgress) {
        saveSnapshot(resume);
        showReconnect(resume);
      }
    }
  };
  es.onmessage = (e) => {
    let event;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(event);
    saveSnapshot();
  };
}

function handle(event) {
  switch (event.kind) {
    case "turn":
      renderTurn(event.turn);
      break;
    case "reply":
      if (event.spoken) speak(event.spoken);
      break;
    case "thinking":
      setStatus("Thinking…");
      renderThinking(event);
      break;
    case "answer":
      setStatus("");
      resolveThinking(event);
      if (event.turn) renderTurn(event.turn);
      if (event.spoken) speak(event.spoken);
      break;
    case "field":
      renderField(event.field);
      break;
    case "proposal":
    case "proposal_settled":
      renderProposal(event.artifact);
      break;
    case "idea":
      applyIdeaEvent(event);
      break;
    default:
      break;
  }
  renderCounts();
}

function setConnectionState(stateName) {
  const el = $("#status-dot");
  if (!el) return;
  el.dataset.state = stateName;
  const label =
    stateName === "live" ? "live" : stateName === "error" ? "offline" : "idle";
  el.textContent = label;
  el.setAttribute("aria-label", `Connection ${label}`);
}

/* --- reconnect (verbatim FNOL contract, work schema) -------------------- */

function scrapeResume() {
  const fields = [...state.fields.entries()].map(([k, v]) => `${k}: ${v}`);
  const turns = [...$("#conversation").querySelectorAll(".turn:not(.interim)")].map((el) => ({
    role: el.classList.contains("user") ? "user" : "assistant",
    content: el.querySelector(".body")?.textContent || "",
  }));
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  const questions = (lastAssistant?.content || "").match(/[^.?!]*\?/g);
  const lastQuestion = questions ? questions[questions.length - 1].trim() : "";
  const digest = turns
    .slice(-8)
    .map((m) => `${m.role === "user" ? "You" : "Brutus"}: ${(m.content || "").replace(/\s+/g, " ").slice(0, 90)}`)
    .join(" | ");
  let summary = fields.length ? `Fields: ${fields.join("; ")}.` : "";
  if (digest) summary += ` Exchange just before the drop: ${digest}`;
  return {
    summary,
    lastQuestion,
    seed: turns,
    sessionId: state.sessionId,
    hasProgress: fields.length > 0 || turns.length > 1,
  };
}

function saveSnapshot(resume) {
  try {
    const r = resume || scrapeResume();
    if (!r.hasProgress || state.sessionComplete) return;
    sessionStorage.setItem(
      SNAP_KEY,
      JSON.stringify({ at: Date.now(), resume: r, count: state.reconnectCount }),
    );
  } catch {
    /* private mode */
  }
}

function clearSnapshot() {
  try {
    sessionStorage.removeItem(SNAP_KEY);
  } catch {
    /* ignore */
  }
}

function showReconnect(resume) {
  window.__pendingResume = resume;
  $("#reconnect").hidden = false;
  $("#placeholder").hidden = true;
  $("#live").hidden = true;
  showConnecting(false);
}

async function doReconnect() {
  const resume = window.__pendingResume || {};
  state.reconnectCount += 1;
  $("#reconnect").hidden = true;
  showConnecting(true);

  // Prefer the saved session id so captured fields come back from the server.
  const sid = resume.sessionId || sessionStorage.getItem("brutus.mobile.session");
  if (sid) {
    const ok = await fetch(`/api/session/${sid}`).then((r) => r.ok).catch(() => false);
    if (ok) {
      sessionStorage.setItem("brutus.mobile.session", sid);
      await hydrate(sid);
      enterLive();
      markResumed();
      // Tell Brutus where we left off so the next reply can pick up.
      if (resume.summary || resume.lastQuestion) {
        const hint = [
          "Reconnected after a drop.",
          resume.lastQuestion ? `Last open question: ${resume.lastQuestion}` : "",
          resume.summary || "",
        ]
          .filter(Boolean)
          .join(" ");
        await say(`(system) ${hint}`, "text");
      }
      return;
    }
  }
  // Session gone — open fresh but keep the digest in the first turn.
  await openSession({ forceNew: true });
  markResumed();
  if (resume.summary) {
    await say(`(system) Reconnected. Prior context: ${resume.summary}`, "text");
  }
}

function markResumed() {
  if (document.getElementById("resumed-note")) return;
  const note = document.createElement("div");
  note.id = "resumed-note";
  note.className = "resumed-note";
  note.textContent = "Reconnected — earlier details retained";
  const body = $("#sheet-body");
  body.insertBefore(note, body.firstChild);
}

async function startOver() {
  window.__pendingResume = null;
  state.reconnectCount = 0;
  clearSnapshot();
  sessionStorage.removeItem("brutus.mobile.session");
  if (state.sessionId) {
    try {
      await fetch(`/api/session/${state.sessionId}/close`, { method: "POST" });
    } catch {
      /* best-effort */
    }
  }
  if (state.events) state.events.close();
  state.sessionId = null;
  state.wasLive = false;
  $("#reconnect").hidden = true;
  document.getElementById("resumed-note")?.remove();
  showPlaceholder();
}

/* --- rendering ---------------------------------------------------------- */

function renderText(el, text) {
  el.textContent = "";
  const parts = String(text ?? "").split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      el.append(strong);
    } else {
      el.append(document.createTextNode(part));
    }
  }
}

function renderTurn(turn, { animate = true } = {}) {
  if (!turn || state.seenTurns.has(turn.id)) return;
  // System reconnect hints stay out of the visible transcript.
  if (turn.role === "user" && String(turn.text || "").startsWith("(system)")) return;
  state.seenTurns.add(turn.id);
  clearInterim();

  const el = document.createElement("article");
  el.className = `turn ${turn.role === "user" ? "user" : "brutus"}`;
  el.dataset.turnId = turn.id;
  if (!animate) el.style.animation = "none";

  const who = document.createElement("div");
  who.className = "who";
  who.append(turn.role === "user" ? "You" : "Brutus");
  if (turn.channel === "voice") {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.append("spoken");
    who.append(badge);
  }

  const body = document.createElement("div");
  body.className = "body";
  renderText(body, turn.text);
  el.append(who, body);
  $("#conversation").append(el);
  scrollToEnd();
}

/* --- thinking cards (minimal port of session.js) ------------------------ */

function restoreThinking(turns) {
  const host = $("#thinking");
  if (!host) return;
  host.querySelectorAll(".thinking").forEach((el) => el.remove());
  if (!$("#thinking-empty")) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.id = "thinking-empty";
    empty.textContent = "Ask a real question and the answer lands here — it never interrupts.";
    host.prepend(empty);
  } else {
    $("#thinking-empty").hidden = false;
  }
  const byId = new Map(turns.map((t) => [t.id, t]));
  const answers = turns.filter((t) => t.meta && t.meta.lane === "deep" && t.meta.answers_turn);
  for (const answer of answers) {
    const asked = byId.get(answer.meta.answers_turn);
    renderThinking({ question: asked ? asked.text : "", turn_id: answer.meta.answers_turn });
    resolveThinking({ answers_turn: answer.meta.answers_turn, turn: answer });
  }
}

function renderThinking(event) {
  if (!event || !event.turn_id) return;
  const existing = $(`#thinking .thinking[data-answers="${CSS.escape(String(event.turn_id))}"]`);
  if (existing) return;
  const card = document.createElement("div");
  card.className = "thinking";
  card.dataset.answers = event.turn_id;
  card.innerHTML =
    '<div class="q"></div>' +
    '<div class="working"><span class="dot"></span><span>Thinking…</span></div>';
  card.querySelector(".q").textContent = event.question || "";
  $("#thinking-empty")?.remove();
  $("#thinking").prepend(card);
  state.pendingQuestion = event.turn_id;
  // Conversation-first: card waits in the Thinking sheet; do not steal focus.
  const btn = $("#thinking-open");
  if (btn) btn.dataset.pending = "true";
}

function resolveThinking(event) {
  const key = event.answers_turn;
  if (!key) return;
  const card = $(`#thinking .thinking[data-answers="${CSS.escape(String(key))}"]`);
  if (card) {
    card.classList.add("done");
    if (!card.querySelector(".answer")) {
      const answer = document.createElement("div");
      answer.className = "answer";
      renderText(answer, event.turn?.text || "");
      card.append(answer);
    }
  }
  state.pendingQuestion = null;
  const btn = $("#thinking-open");
  if (btn) btn.dataset.pending = "false";
}

function showInterim(text) {
  let el = $("#interim");
  if (!el) {
    el = document.createElement("article");
    el.id = "interim";
    el.className = "turn user interim";
    el.innerHTML = '<div class="who">You</div><div class="body"></div>';
    $("#conversation").append(el);
  }
  el.querySelector(".body").textContent = text;
  scrollToEnd();
}

function clearInterim() {
  $("#interim")?.remove();
}

function scrollToEnd() {
  const box = $("#conversation");
  box.scrollTop = box.scrollHeight;
}

function renderField(field, { animate = true } = {}) {
  if (!field) return;
  state.fields.set(field.name, field.value);
  $("#fields-empty")?.remove();
  const list = $("#fields");
  let row = list.querySelector(`[data-field="${CSS.escape(field.name)}"]`);
  if (!row) {
    row = document.createElement("div");
    row.className = "field";
    row.dataset.field = field.name;
    row.innerHTML = "<dt></dt><dd></dd>";
    list.append(row);
  }
  row.querySelector("dt").textContent = field.name.replace(/_/g, " ");
  row.querySelector("dd").textContent = field.value;
  if (animate) {
    row.classList.remove("new");
    void row.offsetWidth;
    row.classList.add("new");
  }
  // Auto-expand the sheet the first time something lands.
  if (state.fields.size === 1) setSheet(true);
}

const SETTLED_WORDS = {
  executed: "done",
  failed: "failed",
  rejected: "cancelled",
  cancelled: "cancelled",
};

function renderProposal(artifact) {
  if (!artifact) return;
  setSheet(true);
  const host = $("#proposals");
  let card = host.querySelector(`[data-artifact="${CSS.escape(artifact.id)}"]`);
  if (!card) {
    card = document.createElement("div");
    card.className = "proposal";
    card.dataset.artifact = artifact.id;
    host.prepend(card);
  }
  card.dataset.state = artifact.state;
  card.textContent = "";

  const what = document.createElement("p");
  what.className = "what";
  what.textContent = artifact.summary || artifact.tool;
  card.append(what);

  const args = document.createElement("dl");
  args.className = "args";
  for (const [k, v] of Object.entries(artifact.args || {})) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = String(v);
    args.append(dt, dd);
  }
  card.append(args);

  if (artifact.state === "draft") {
    const row = document.createElement("div");
    row.className = "actions";
    const yes = document.createElement("button");
    yes.className = "primary";
    yes.textContent = "Do it";
    yes.addEventListener("click", () => settleProposal(artifact.id, "approve", row));
    const no = document.createElement("button");
    no.textContent = "Cancel";
    no.addEventListener("click", () => settleProposal(artifact.id, "reject", row));
    row.append(yes, no);
    card.append(row);
  } else {
    const settled = document.createElement("p");
    settled.className = "settled";
    settled.textContent = SETTLED_WORDS[artifact.state] || artifact.state;
    card.append(settled);
  }
}

async function settleProposal(artifactId, decision, row) {
  row.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await fetch(`/api/session/${state.sessionId}/artifact/${artifactId}/${decision}`, {
      method: "POST",
    });
  } catch (err) {
    setStatus(`Couldn't ${decision} that — ${err.message}`);
    row.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

function renderCounts() {
  $("#field-count").textContent = String(state.fields.size);
}

/* --- pad sheets (Ideas / Ledger / Thinking) ----------------------------- */

const PAD_IDS = ["ideas-sheet", "board-sheet", "thinking-sheet"];
const PAD_OPENERS = {
  "ideas-sheet": "ideas-open",
  "board-sheet": "board-open",
  "thinking-sheet": "thinking-open",
};

function openPad(id) {
  for (const padId of PAD_IDS) {
    const el = document.getElementById(padId);
    const btn = document.getElementById(PAD_OPENERS[padId]);
    const on = padId === id;
    if (el) {
      el.hidden = !on;
      el.dataset.open = on ? "true" : "false";
    }
    if (btn) btn.setAttribute("aria-expanded", String(on));
  }
  if (id === "ideas-sheet") setSheet(false);
}

function closePads() {
  openPad(null);
}

function ensurePads() {
  if (!state.ideasEs) initIdeas();
  if (!state.boardEs) initBoard();
}

/* --- ideas pad ---------------------------------------------------------- */

function isMeetingDump(text) {
  const t = String(text || "");
  return /\ba1OUG\b/i.test(t) || / — 20\d{2}-\d{2}-\d{2}\b/.test(t);
}

async function initIdeas() {
  if (state.ideasEs) state.ideasEs.close();
  const es = new EventSource("/api/session/ideas/events");
  state.ideasEs = es;
  es.onmessage = (e) => {
    try {
      applyIdeaEvent(JSON.parse(e.data));
    } catch {
      /* ignore a malformed frame */
    }
  };
  await loadIdeas();
}

async function loadIdeas() {
  try {
    const r = await fetch("/api/todos");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    ideasState.byId.clear();
    ideasState.loadError = null;
    for (const note of data.todos || []) {
      ideasState.byId.set(note.id, note);
    }
    drawIdeas();
  } catch {
    ideasState.loadError = "Couldn't reach the Ideas pad.";
    drawIdeas();
  }
}

function applyIdeaEvent(event) {
  if (!event || (event.kind && event.kind !== "idea")) return;
  const action = event.action || (event.note ? "upsert" : "");
  if (action === "delete") {
    const id = event.note_id || event.note?.id;
    if (id) {
      ideasState.byId.delete(id);
      if (ideasState.confirmDeleteId === id) ideasState.confirmDeleteId = null;
      drawIdeas();
    }
    return;
  }
  if (event.note && event.note.id) {
    upsertIdea(event.note, { animate: true });
  }
}

function upsertIdea(note, { animate = false } = {}) {
  if (!note || !note.id) return;
  ideasState.byId.set(note.id, note);
  drawIdeas({ flashId: animate ? note.id : null });
}

function drawIdeas({ flashId = null } = {}) {
  const host = $("#ideas-list");
  const empty = $("#ideas-empty");
  const countEl = $("#ideas-count");
  if (!host) return;

  if (ideasState.loadError) {
    host.textContent = "";
    if (empty) {
      empty.hidden = false;
      empty.replaceChildren();
      const msg = document.createElement("span");
      msg.textContent = ideasState.loadError;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ideas-retry";
      retry.textContent = "Retry";
      retry.setAttribute("aria-label", "Retry loading Ideas");
      retry.addEventListener("click", () => loadIdeas());
      empty.append(msg, document.createTextNode(" "), retry);
    }
    if (countEl) countEl.textContent = "";
    return;
  }

  const notes = [...ideasState.byId.values()].sort((a, b) =>
    String(b.updated_at || b.created_at || "").localeCompare(
      String(a.updated_at || a.created_at || ""),
    ),
  );
  const open = notes.filter((n) => n.status !== "done" && n.lane !== "Done");
  // Mobile Focus default: hide meeting dumps (same as /session).
  const visible = open.filter((n) => !isMeetingDump(n.text));
  if (countEl) countEl.textContent = visible.length ? String(visible.length) : "";

  host.textContent = "";
  if (!open.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = "Nothing on the pad — say “capture …” or type above.";
    }
    return;
  }
  if (!visible.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = "Focus is clear — meeting notes stay on /session All.";
    }
    return;
  }
  if (empty) empty.hidden = true;

  for (const note of visible) {
    const li = document.createElement("li");
    li.className = "idea";
    li.dataset.id = note.id;
    if (flashId && note.id === flashId) li.classList.add("new");

    const what = document.createElement("p");
    what.className = "what";
    what.textContent = note.text;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = note.lane || note.status || "Inbox";

    const actions = document.createElement("div");
    actions.className = "actions";

    if (ideasState.confirmDeleteId === note.id) {
      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "primary";
      yes.textContent = "Yes, delete";
      yes.addEventListener("click", () => ideaDelete(note.id));
      const no = document.createElement("button");
      no.type = "button";
      no.textContent = "Cancel";
      no.addEventListener("click", () => {
        ideasState.confirmDeleteId = null;
        drawIdeas();
      });
      actions.append(yes, no);
    } else {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger";
      del.textContent = "Delete";
      del.setAttribute("aria-label", `Delete idea: ${note.text}`);
      del.addEventListener("click", () => {
        ideasState.confirmDeleteId = note.id;
        drawIdeas();
      });
      actions.append(del);
    }

    li.append(what, meta, actions);
    host.append(li);
  }
}

async function ideaDelete(id) {
  try {
    const r = await fetch(`/api/todos/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error(await r.text());
    ideasState.byId.delete(id);
    ideasState.confirmDeleteId = null;
    drawIdeas();
    setStatus("Deleted from Ideas.");
  } catch (err) {
    setStatus(`Couldn't delete that — ${err.message}`);
    drawIdeas();
  }
}

/* --- ledger (compact needs-you + with-bots) ----------------------------- */

function flattenBoard(board) {
  const out = [];
  const lanes = [
    ["needs_you", "needs you"],
    ["working", "with bots"],
  ];
  for (const [lane, label] of lanes) {
    const value = board[lane];
    if (!Array.isArray(value)) continue;
    for (const r of value) {
      out.push({
        lane,
        laneLabel: label,
        ticket: String(r.ticket || ""),
        title: String(r.title || ""),
        signal: String(r.signal || r.question || r.reason || ""),
        key: String(r.ticket || r.thread_id || r.title || ""),
      });
    }
  }
  return out;
}

async function initBoard() {
  if (state.boardEs) state.boardEs.close();
  const es = new EventSource("/api/session/board/events");
  state.boardEs = es;
  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.kind === "board") applyBoardEvent(event);
    } catch {
      /* ignore a malformed frame */
    }
  };
  await loadBoard();
}

async function loadBoard() {
  const empty = $("#board-empty");
  if (empty) {
    empty.hidden = false;
    empty.dataset.state = "loading";
    empty.textContent = "Waiting for the ledger…";
  }
  try {
    const r = await fetch("/api/board");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const board = await r.json();
    boardState.rows = flattenBoard(board);
    const headline = $("#board-headline");
    if (headline) headline.textContent = board.headline || "";
    drawBoard();
  } catch {
    boardState.rows = [];
    const headline = $("#board-headline");
    if (headline) headline.textContent = "";
    drawBoard();
    if (empty) {
      empty.hidden = false;
      empty.dataset.state = "error";
      empty.textContent = "Couldn't reach the ledger.";
    }
  }
}

function applyBoardEvent(event) {
  if (event.headline) {
    const headline = $("#board-headline");
    if (headline) headline.textContent = event.headline;
  }
  // Visual only — never speak board deltas (UUID doorbells, leftover tabs).
  loadBoard();
}

function drawBoard() {
  const host = $("#board-list");
  const empty = $("#board-empty");
  const countEl = $("#board-count");
  if (!host) return;
  const keepError = empty && empty.dataset.state === "error" && !empty.hidden;
  const rows = boardState.rows;
  if (countEl) countEl.textContent = rows.length ? String(rows.length) : "";

  host.textContent = "";
  if (!keepError) {
    if (!rows.length) {
      if (empty) {
        empty.hidden = false;
        empty.dataset.state = "empty";
        empty.textContent = "Ledger is empty.";
      }
      return;
    }
    if (empty) {
      empty.hidden = true;
      empty.dataset.state = "";
    }
  } else if (!rows.length) {
    return;
  }

  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "board-row";
    li.dataset.lane = r.lane;

    const ticket = document.createElement("div");
    ticket.className = "ticket";
    const id = document.createElement("span");
    id.textContent = r.ticket || "—";
    const lane = document.createElement("span");
    lane.className = "lane";
    lane.textContent = r.laneLabel;
    ticket.append(id, lane);

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = r.title || "(no title)";

    li.append(ticket, title);
    if (r.signal) {
      const signal = document.createElement("div");
      signal.className = "signal";
      signal.textContent = r.signal;
      li.append(signal);
    }
    host.append(li);
  }
}

/* --- saying / voice ----------------------------------------------------- */

async function say(message, channel) {
  const text = (message || "").trim();
  if (!text || !state.sessionId) return;
  clearInterim();
  $("#send").disabled = true;
  try {
    await fetch(`/api/session/${state.sessionId}/say`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, channel }),
    });
  } catch (err) {
    setStatus(`Couldn't send that — ${err.message}`);
  } finally {
    $("#send").disabled = false;
  }
}

const STOP_WORDS = /\b(stop|mute|quiet|cancel|shut up)\b/i;
const FRUSTRATION_WORDS =
  /^\s*(?:(?:oh|fuck|god|holy|jesus)\s+)*(?:shit|fuck|damn|goddamn|crap|enough|shut up|be quiet|quiet|stop talking|jesus|christ)(?:\s+(?:man|dude|already|please))?[!?.]*\s*$/i;

/* Continuous recognition emits finals as scraps. Buffer ~1s of silence, then
 * send one concatenated utterance. STOP / FRUSTRATION still fire immediately. */
const UTTERANCE_SILENCE_MS = 1000;
let utteranceParts = [];
let utteranceTimer = null;

function clearUtteranceBuffer() {
  utteranceParts = [];
  if (utteranceTimer) {
    clearTimeout(utteranceTimer);
    utteranceTimer = null;
  }
}

function flushUtterance() {
  utteranceTimer = null;
  const text = utteranceParts.join(" ").replace(/\s+/g, " ").trim();
  utteranceParts = [];
  if (text) say(text, "voice");
}

function queueVoiceFinal(text) {
  const part = String(text || "").trim();
  if (!part) return;
  utteranceParts.push(part);
  if (utteranceTimer) clearTimeout(utteranceTimer);
  utteranceTimer = setTimeout(flushUtterance, UTTERANCE_SILENCE_MS);
}

const SPOKEN_MEMORY_MS = 12_000;
const spokenRecently = [];

function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rememberSpoken(text) {
  const n = normalise(text);
  if (n) spokenRecently.push({ text: n, at: Date.now() });
}

function isOurOwnVoice(heard) {
  const n = normalise(heard);
  if (!n) return false;
  const now = Date.now();
  while (spokenRecently.length && now - spokenRecently[0].at > SPOKEN_MEMORY_MS) {
    spokenRecently.shift();
  }
  return spokenRecently.some(
    (s) => s.text.includes(n) || n.includes(s.text),
  );
}

function supportsSpeech() {
  return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
}

function startListening() {
  if (!supportsSpeech()) return;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const result = e.results[i];
      const text = result[0].transcript;
      if (!result.isFinal) {
        interim += text;
        continue;
      }
      if (STOP_WORDS.test(text) || FRUSTRATION_WORDS.test(text)) {
        clearUtteranceBuffer();
        if (state.speaking) stopSpeaking();
        if (FRUSTRATION_WORDS.test(text)) say("what needs me", "voice");
        continue;
      }
      if (state.speaking) {
        continue;
      }
      if (isOurOwnVoice(text)) {
        setStatus("(ignored my own voice)");
        continue;
      }
      queueVoiceFinal(text);
    }
    if (interim) showInterim(interim);
  };
  rec.onend = () => {
    if (state.listening) {
      try {
        rec.start();
      } catch {
        /* already starting */
      }
    }
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed") {
      state.listening = false;
      setMicState();
      setStatus("Microphone blocked. Allow it for this page and try again.");
    }
  };
  state.recognizer = rec;
  state.listening = true;
  rec.start();
  setMicState();
}

function stopListening() {
  state.listening = false;
  try {
    state.recognizer?.stop();
  } catch {
    /* not started */
  }
  state.recognizer = null;
  clearUtteranceBuffer();
  clearInterim();
  setMicState();
}

async function speak(text) {
  if (state.muted || !text) return;
  rememberSpoken(text);
  try {
    const r = await fetch("/api/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    stopSpeaking();
    const audio = new Audio(url);
    state.audio = audio;
    state.speaking = true;
    setMicState();
    audio.onended = () => {
      URL.revokeObjectURL(url);
      state.speaking = false;
      state.audio = null;
      setMicState();
    };
    await audio.play();
  } catch {
    state.speaking = false;
    setMicState();
  }
}

function stopSpeaking() {
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }
  state.speaking = false;
  setMicState();
}

function setMicState() {
  const btn = $("#mic");
  if (!btn) return;
  const glyph = btn.querySelector(".glyph");
  if (state.speaking) {
    glyph.textContent = "■";
    btn.setAttribute("aria-label", "Stop reading");
    btn.setAttribute("aria-pressed", "true");
    setStatus("Speaking…");
  } else if (state.listening) {
    glyph.textContent = "●";
    btn.setAttribute("aria-label", "Stop listening");
    btn.setAttribute("aria-pressed", "true");
    setStatus("Listening…");
  } else {
    glyph.textContent = "◎";
    btn.setAttribute("aria-label", "Voice commands");
    btn.setAttribute("aria-pressed", "false");
    setStatus("");
  }
}

function setStatus(text) {
  const el = $("#status-line");
  if (el) el.textContent = text || "";
}

/* --- stage switches ----------------------------------------------------- */

function showConnecting(on) {
  const el = $("#connecting");
  el.hidden = !on;
  el.setAttribute("aria-busy", on ? "true" : "false");
}

function showPlaceholder() {
  $("#placeholder").hidden = false;
  $("#live").hidden = true;
  $("#reconnect").hidden = true;
  $("#outro").hidden = true;
  showConnecting(false);
  setConnectionState("idle");
}

function enterLive() {
  $("#placeholder").hidden = true;
  $("#live").hidden = false;
  $("#reconnect").hidden = true;
  $("#outro").hidden = true;
  state.wasLive = true;
  state.sessionComplete = false;
}

function setSheet(expanded) {
  const sheet = $("#sheet");
  sheet.dataset.expanded = expanded ? "true" : "false";
  $("#sheet-toggle").setAttribute("aria-expanded", String(expanded));
}

async function endSession() {
  state.sessionComplete = true;
  clearSnapshot();
  stopListening();
  stopSpeaking();
  if (state.events) state.events.close();
  if (state.sessionId) {
    try {
      await fetch(`/api/session/${state.sessionId}/close`, { method: "POST" });
    } catch {
      /* best-effort */
    }
  }
  sessionStorage.removeItem("brutus.mobile.session");
  state.sessionId = null;
  state.wasLive = false;

  const outro = $("#outro");
  outro.hidden = false;
  outro.classList.add("show");
  setTimeout(() => outro.classList.add("fade"), 1600);
  setTimeout(() => {
    outro.classList.remove("show", "fade");
    outro.hidden = true;
    showPlaceholder();
  }, 2800);
}

/* --- wiring ------------------------------------------------------------- */

function init() {
  if (!supportsSpeech()) $("#mic")?.remove();

  $("#start-btn").addEventListener("click", () => openSession({ forceNew: true }));
  $("#reconnect-btn").addEventListener("click", () => doReconnect());
  $("#startover-btn").addEventListener("click", () => {
    if (
      !window.confirm(
        "Start over? Captured work from this reconnect offer will be dropped.",
      )
    ) {
      return;
    }
    startOver();
  });
  $("#end-btn").addEventListener("click", () => {
    if (!window.confirm("End this session?")) return;
    endSession();
  });

  $("#sheet-toggle").addEventListener("click", () => {
    const next = $("#sheet").dataset.expanded !== "true";
    setSheet(next);
    if (next) closePads();
  });

  $("#ideas-open")?.addEventListener("click", () => {
    const open = $("#ideas-sheet")?.dataset.open === "true";
    if (open) closePads();
    else {
      openPad("ideas-sheet");
      ensurePads();
    }
  });
  $("#board-open")?.addEventListener("click", () => {
    const open = $("#board-sheet")?.dataset.open === "true";
    if (open) closePads();
    else {
      openPad("board-sheet");
      ensurePads();
    }
  });
  $("#thinking-open")?.addEventListener("click", () => {
    const open = $("#thinking-sheet")?.dataset.open === "true";
    if (open) closePads();
    else openPad("thinking-sheet");
  });
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closePads());
  });

  $("#ideas-add")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = $("#idea-text");
    const text = (box.value || "").trim();
    if (!text) return;
    box.value = "";
    const btn = e.submitter || $("#ideas-add button[type=submit]");
    if (btn) btn.disabled = true;
    try {
      const r = await fetch("/api/todos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error(await r.text());
      const note = await r.json();
      upsertIdea(note, { animate: true });
      setStatus(`On Ideas — ${note.text}`);
    } catch (err) {
      setStatus(`Couldn't add that — ${err.message}`);
      box.value = text;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $("#mic")?.addEventListener("click", () => {
    if (state.speaking) return stopSpeaking();
    if (state.listening) return stopListening();
    startListening();
  });

  $("#mute").addEventListener("click", (e) => {
    state.muted = !state.muted;
    if (state.muted) stopSpeaking();
    e.currentTarget.setAttribute("aria-pressed", String(state.muted));
    e.currentTarget.querySelector(".label").textContent = state.muted ? "Muted" : "Speaking on";
  });

  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const box = $("#say");
    const text = box.value;
    box.value = "";
    say(text, "text");
  });

  $("#say").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });

  addEventListener("beforeunload", () => saveSnapshot());

  // Fresh load after a mid-session reload: offer the pickup (FNOL contract).
  try {
    const raw = sessionStorage.getItem(SNAP_KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      if (snap && snap.resume && Date.now() - snap.at < FRESH_MS && snap.resume.hasProgress) {
        state.reconnectCount = snap.count || 0;
        showReconnect(snap.resume);
        setMicState();
        return;
      }
      clearSnapshot();
    }
  } catch {
    /* ignore */
  }

  // Ideas + Ledger buses are session-independent — start them on load so
  // counts are ready before the first conversation.
  ensurePads();

  setMicState();
  initTheme();
  showPlaceholder();
}

document.addEventListener("DOMContentLoaded", init);
